from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import re
import tempfile
from urllib.parse import unquote, urlparse
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from .config import AstrBotSettings, get_settings


def _looks_like_md5(value: str) -> bool:
    """Heuristic: 32 hex chars -> treat as already MD5-hashed."""
    if len(value) != 32:
        return False
    lowered = value.lower()
    return all("0" <= c <= "9" or "a" <= c <= "f" for c in lowered)


def _filename_from_content_disposition(value: str) -> str | None:
    """
    Extract filename from Content-Disposition header.

    Supports:
      - filename="..."
      - filename*=UTF-8''...
    """
    if not value:
        return None

    # RFC 5987: filename*=UTF-8''%E4%B8%AD%E6%96%87.txt
    match = re.search(r"filename\\*=([^']*)''([^;]+)", value, flags=re.IGNORECASE)
    if match:
        filename = unquote(match.group(2))
        filename = os.path.basename(filename.strip().strip('"'))
        return filename or None

    match = re.search(r'filename=\"?([^\";]+)\"?', value, flags=re.IGNORECASE)
    if match:
        filename = os.path.basename(match.group(1).strip().strip('"'))
        return filename or None

    return None


@dataclass
class AstrBotClient:
    """Small helper around AstrBot's HTTP API."""

    settings: AstrBotSettings
    _token: str | None = field(default=None, init=False, repr=False)

    @classmethod
    def from_env(cls) -> "AstrBotClient":
        return cls(settings=get_settings())

    @property
    def base_url(self) -> str:
        return self.settings.base_url

    @property
    def timeout(self) -> float:
        return self.settings.timeout

    # ---- Auth / token handling --------------------------------------

    async def ensure_token(self) -> str | None:
        """
        Ensure we have a valid JWT token.

        Uses ASTRBOT_USERNAME / ASTRBOT_PASSWORD if provided.
        If not provided, requests will be sent without Authorization header.

        AstrBot's dashboard backend compares the incoming password with the
        stored MD5 hash (see routes/auth.py), while the frontend sends the
        MD5(username) string. To match that behavior, we hash the provided
        password with MD5 unless it already looks like a 32-char hex string.
        """
        if self._token is not None:
            return self._token

        username = self.settings.username
        password = self.settings.password

        if not username or not password:
            # No credentials configured; caller must rely on public/unauthenticated APIs.
            return None

        pwd = password.strip()
        if not _looks_like_md5(pwd):
            pwd = hashlib.md5(pwd.encode("utf-8")).hexdigest()

        url = f"{self.base_url}/api/auth/login"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                url,
                json={"username": username, "password": pwd},
            )
            # If login fails, raise for clarity
            resp.raise_for_status()
            data = resp.json()
            if data.get("status") != "ok":
                raise RuntimeError(
                    f"Login failed: {data.get('message') or 'unknown error'}"
                )
            token = (data.get("data") or {}).get("token")
            if not token:
                raise RuntimeError("Login succeeded but token is missing in response.")
            self._token = token
            return token

    async def _get_auth_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        token = await self.ensure_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Dict[str, Any] | None = None,
        headers: Dict[str, str] | None = None,
        json_body: Any | None = None,
        files: Dict[str, Any] | None = None,
        stream: bool = False,
    ) -> httpx.Response:
        url = f"{self.base_url}{path}"
        if headers is None:
            headers = {}

        # Attach Authorization header if we have a token
        auth_headers = await self._get_auth_headers()
        headers = {**headers, **auth_headers}

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            if stream:
                return await client.build_request(method, url, params=params, json=json_body, files=files)  # type: ignore[return-value]
            response = await client.request(
                method,
                url,
                params=params,
                headers=headers,
                json=json_body,
                files=files,
            )
            response.raise_for_status()
            return response

    async def _stream_sse(
        self,
        method: str,
        path: str,
        *,
        params: Dict[str, Any] | None = None,
        json_body: Any | None = None,
        max_seconds: Optional[int] = None,
        max_events: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Consume a simple SSE endpoint and return parsed JSON payloads.

        AstrBot's SSE endpoints use `data: {...}\\n\\n` format per event.

        `max_seconds` is a soft upper bound for how long we wait:
        - 如果持续有事件流入，最多等待约 `max_seconds` 秒；
        - 如果在这一段时间内**完全没有任何事件**，也会在超时后返回，
          避免长时间挂起导致 MCP 端工具调用超时。
        """
        url = f"{self.base_url}{path}"
        events: List[Dict[str, Any]] = []

        headers = await self._get_auth_headers()

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream(
                method,
                url,
                params=params,
                headers=headers,
                json=json_body,
            ) as response:
                response.raise_for_status()
                content_type = (response.headers.get("content-type") or "").lower()
                if "text/event-stream" not in content_type:
                    raw = await response.aread()
                    raw_text = raw.decode("utf-8", errors="replace").strip()
                    try:
                        payload = json.loads(raw_text) if raw_text else None
                    except json.JSONDecodeError:
                        payload = None

                    if isinstance(payload, dict):
                        status = payload.get("status")
                        message = payload.get("message") or payload.get("error") or raw_text
                        raise RuntimeError(
                            f"Expected SSE but got JSON ({status or 'unknown'}): {message}"
                        )

                    raise RuntimeError(
                        f"Expected SSE but got {content_type or 'unknown content-type'}: {raw_text}"
                    )

                async def consume() -> None:
                    async for line in response.aiter_lines():
                        if not line:
                            # Heartbeats / blank lines
                            continue

                        if not line.startswith("data:"):
                            continue

                        _, data_str = line.split("data:", 1)
                        data_str = data_str.strip()

                        if not data_str:
                            continue

                        try:
                            payload = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue

                        if isinstance(payload, dict):
                            events.append(payload)

                        if max_events is not None and len(events) >= max_events:
                            # Enough events collected; stop consuming.
                            break

                if max_seconds is not None and max_seconds > 0:
                    try:
                        await asyncio.wait_for(consume(), timeout=max_seconds)
                    except asyncio.TimeoutError:
                        # Time window elapsed; return whatever we collected so far.
                        pass
                else:
                    await consume()

        return events

    # ---- Log APIs -----------------------------------------------------

    async def get_log_history(self) -> Dict[str, Any]:
        """Call /api/log-history and return the parsed JSON."""
        response = await self._request("GET", "/api/log-history")
        return response.json()

    async def get_live_logs(
        self,
        wait_seconds: int,
        max_events: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Stream logs from /api/live-log for up to wait_seconds.

        Returns a list of SSE event payloads (dicts).
        """
        if wait_seconds <= 0:
            return []
        return await self._stream_sse(
            "GET",
            "/api/live-log",
            max_seconds=wait_seconds,
            max_events=max_events,
        )

    # ---- Platform / config APIs --------------------------------------

    async def get_platform_list(self) -> Dict[str, Any]:
        """Call /api/config/platform/list and return the parsed JSON."""
        response = await self._request("GET", "/api/config/platform/list")
        return response.json()

    # ---- Plugin / market APIs ----------------------------------------

    async def get_plugin_market_list(
        self,
        *,
        custom_registry: str | None = None,
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        """
        Get plugin market list via /api/plugin/market_list.

        Args:
            custom_registry: Optional custom registry URL (AstrBot will fetch from it).
            force_refresh: If True, bypass AstrBot's local cache.
        """
        params: Dict[str, Any] = {}
        if custom_registry:
            params["custom_registry"] = custom_registry
        if force_refresh:
            params["force_refresh"] = "true"
        response = await self._request("GET", "/api/plugin/market_list", params=params or None)
        return response.json()

    # ---- Chat / platform session APIs --------------------------------

    async def create_platform_session(
        self,
        platform_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Create a new platform session via /api/chat/new_session.

        If platform_id is None, AstrBot's default ('webchat') is used.
        """
        params: Dict[str, Any] | None = None
        if platform_id:
            params = {"platform_id": platform_id}
        response = await self._request("GET", "/api/chat/new_session", params=params)
        return response.json()

    async def get_platform_session( 
        self, 
        session_id: str, 
    ) -> Dict[str, Any]: 
        """ 
        Get a platform session's history via /api/chat/get_session. 
        """ 
        response = await self._request( 
            "GET", 
            "/api/chat/get_session", 
            params={"session_id": session_id}, 
        ) 
        return response.json() 

    async def list_active_umos(self) -> Dict[str, Any]:
        """
        List active UMOs (unified message origins) via /api/session/active-umos.
        """
        response = await self._request("GET", "/api/session/active-umos")
        return response.json()

    async def list_conversations(
        self,
        *,
        page: int = 1,
        page_size: int = 20,
        platforms: str | None = None,
        message_types: str | None = None,
        search: str | None = None,
    ) -> Dict[str, Any]:
        """
        List conversations via /api/conversation/list (dashboard API).

        `platforms` and `message_types` are comma-separated strings (as expected by AstrBot).
        """
        params: Dict[str, Any] = {
            "page": page,
            "page_size": page_size,
        }
        if platforms:
            params["platforms"] = platforms
        if message_types:
            params["message_types"] = message_types
        if search:
            params["search"] = search
        response = await self._request("GET", "/api/conversation/list", params=params)
        return response.json()

    async def get_conversation_detail(
        self,
        *,
        user_id: str,
        cid: str,
    ) -> Dict[str, Any]:
        """
        Get a conversation detail (including history) via /api/conversation/detail.
        """
        payload = {"user_id": user_id, "cid": cid}
        response = await self._request("POST", "/api/conversation/detail", json_body=payload)
        return response.json()

    async def post_attachment_file(
        self,
        file_path: str,
        *,
        file_name: str | None = None,
        mime_type: str | None = None,
    ) -> Dict[str, Any]:
        """
        Upload a file via /api/chat/post_file and return the response JSON.

        AstrBot will create an attachment record and return attachment_id.
        """
        content_type = mime_type
        if content_type:
            content_type = content_type.split(";", 1)[0].strip() or None
        if not content_type:
            guessed_type, _ = mimetypes.guess_type(file_path)
            content_type = guessed_type or "application/octet-stream"

        send_name = file_name or os.path.basename(file_path)

        with open(file_path, "rb") as f:
            files = {
                "file": (send_name, f, content_type),
            }
            url = f"{self.base_url}/api/chat/post_file"
            headers = await self._get_auth_headers()
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(url, files=files, headers=headers)
                response.raise_for_status()
                return response.json()

    async def post_attachment_url(
        self,
        url: str,
        *,
        file_name: str | None = None,
        mime_type: str | None = None,
    ) -> Dict[str, Any]:
        """
        Download a remote URL and upload it via /api/chat/post_file.

        This is useful when the caller can only provide an http(s) URL
        (e.g. LLM-generated image links) but AstrBot requires an uploaded attachment.
        """
        temp_path: str | None = None
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
            ) as http_client:
                async with http_client.stream("GET", url) as response:
                    response.raise_for_status()

                    if not mime_type:
                        content_type = response.headers.get("content-type") or ""
                        content_type = content_type.split(";", 1)[0].strip()
                        mime_type = content_type or None

                    if not file_name:
                        cd = response.headers.get("content-disposition") or ""
                        file_name = _filename_from_content_disposition(cd)

                    if not file_name:
                        parsed = urlparse(str(response.url))
                        file_name = os.path.basename(parsed.path) or "download"

                    with tempfile.NamedTemporaryFile(delete=False) as tmp:
                        temp_path = tmp.name
                        async for chunk in response.aiter_bytes():
                            tmp.write(chunk)

            return await self.post_attachment_file(
                temp_path,
                file_name=file_name,
                mime_type=mime_type,
            )
        finally:
            if temp_path:
                try:
                    os.remove(temp_path)
                except OSError:
                    pass

    async def send_chat_message_sse(
        self,
        session_id: str,
        message_parts: List[Dict[str, Any]],
        *,
        selected_provider: Optional[str] = None,
        selected_model: Optional[str] = None,
        enable_streaming: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        Send a chat message via /api/chat/send and consume the SSE response.

        Returns a list of SSE event payloads from AstrBot.
        """
        payload: Dict[str, Any] = {
            "message": message_parts,
            "session_id": session_id,
            "selected_provider": selected_provider,
            "selected_model": selected_model,
            "enable_streaming": enable_streaming,
        }
        return await self._stream_sse(
            "POST",
            "/api/chat/send",
            json_body=payload,
        )

    async def send_platform_message_direct(
        self,
        *,
        platform_id: str,
        message_type: str,
        session_id: str,
        message_chain: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Send a message via AstrBot platform adapter (bypass LLM).

        Calls /api/platform/send_message (requires AstrBot >= version that includes this route).
        """
        payload: Dict[str, Any] = {
            "platform_id": platform_id,
            "message_type": message_type,
            "session_id": session_id,
            "message_chain": message_chain,
        }
        response = await self._request("POST", "/api/platform/send_message", json_body=payload)
        return response.json()

    # ---- Stat / lifecycle APIs ---------------------------------------

    async def restart_core(self) -> Dict[str, Any]:
        """
        Restart AstrBot core via /api/stat/restart-core.
        """
        response = await self._request("POST", "/api/stat/restart-core")
        return response.json()

    async def get_version(self) -> Dict[str, Any]:
        """
        Get AstrBot version via /api/stat/version.
        """
        response = await self._request("GET", "/api/stat/version")
        return response.json()
