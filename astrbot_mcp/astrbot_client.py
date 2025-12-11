from __future__ import annotations

import asyncio
import json
import mimetypes
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from .config import AstrBotSettings, get_settings


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
        """
        if self._token is not None:
            return self._token

        username = self.settings.username
        password = self.settings.password

        if not username or not password:
            # No credentials configured; caller must rely on public/unauthenticated APIs.
            return None

        url = f"{self.base_url}/api/auth/login"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                url,
                json={"username": username, "password": password},
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
        """
        url = f"{self.base_url}{path}"
        events: List[Dict[str, Any]] = []

        start_time = asyncio.get_event_loop().time()

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
                        break

                    if max_seconds is not None:
                        now = asyncio.get_event_loop().time()
                        if now - start_time >= max_seconds:
                            break

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

    async def post_attachment_file(self, file_path: str) -> Dict[str, Any]:
        """
        Upload a file via /api/chat/post_file and return the response JSON.

        AstrBot will create an attachment record and return attachment_id.
        """
        guessed_type, _ = mimetypes.guess_type(file_path)
        content_type = guessed_type or "application/octet-stream"

        with open(file_path, "rb") as f:
            files = {
                "file": (file_path.split("/")[-1].split("\\")[-1], f, content_type),
            }
            url = f"{self.base_url}/api/chat/post_file"
            headers = await self._get_auth_headers()
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(url, files=files, headers=headers)
                response.raise_for_status()
                return response.json()

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

    # ---- Stat / lifecycle APIs ---------------------------------------

    async def restart_core(self) -> Dict[str, Any]:
        """
        Restart AstrBot core via /api/stat/restart-core.
        """
        response = await self._request("POST", "/api/stat/restart-core")
        return response.json()

