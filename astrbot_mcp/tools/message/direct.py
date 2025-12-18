from __future__ import annotations

import os
from typing import Any, Dict, List, Literal, Optional

from ...astrbot_client import AstrBotClient
from ..helpers import (
    _as_file_uri,
    _attachment_download_url,
    _direct_media_mode,
    _httpx_error_detail,
    _resolve_local_file_path,
)
from ..types import MessagePart


async def send_platform_message_direct(
    platform_id: str,
    target_id: str,
    message_chain: Optional[List[MessagePart]] = None,
    message: Optional[str] = None,
    images: Optional[List[str]] = None,
    files: Optional[List[str]] = None,
    videos: Optional[List[str]] = None,
    records: Optional[List[str]] = None,
    message_type: Literal["GroupMessage", "FriendMessage"] = "GroupMessage",
) -> Dict[str, Any]:
    """
    Directly send a message chain to a platform group/user (bypass LLM).

    This calls AstrBot dashboard endpoint: POST /api/platform/send_message

    Notes:
      - This is for sending to a real platform target (group/user), not WebChat.
      - Media parts:
        - If `file_path` is a local path, this tool will upload it to AstrBot first, then send it as an AstrBot-hosted URL.
        - If `file_path`/`url` is an http(s) URL, it will be forwarded as-is.
    """
    client = AstrBotClient.from_env()
    onebot_like = platform_id.strip().lower() in {
        "napcat",
        "onebot",
        "cqhttp",
        "gocqhttp",
        "llonebot",
    }

    if message_chain is None:
        message_chain = []
        if message:
            message_chain.append({"type": "plain", "text": message})
        for src in images or []:
            message_chain.append({"type": "image", "file_path": src})
        for src in files or []:
            message_chain.append({"type": "file", "file_path": src})
        for src in records or []:
            message_chain.append({"type": "record", "file_path": src})
        for src in videos or []:
            message_chain.append({"type": "video", "file_path": src})

    async def build_chain(mode: str) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        normalized_chain: List[Dict[str, Any]] = []
        uploaded_attachments: List[Dict[str, Any]] = []

        for part in message_chain or []:
            p_type = part.get("type")
            if p_type in ("image", "file", "record", "video"):
                file_path = part.get("file_path")
                url = part.get("url")
                file_name = part.get("file_name")
                mime_type = part.get("mime_type")
                src = url or file_path
                if not src:
                    continue

                normalized = dict(part)
                if not isinstance(src, str):
                    raise ValueError(f"Invalid media source (expected str): {src!r}")

                if src.startswith(("http://", "https://")):
                    normalized["file_path"] = src
                    if onebot_like:
                        normalized.setdefault("file", src)
                    normalized.pop("url", None)
                    normalized_chain.append(normalized)
                    continue

                try:
                    local_path = _resolve_local_file_path(client, src)
                except ValueError as e:
                    raise ValueError(str(e)) from e
                except FileNotFoundError as e:
                    raise FileNotFoundError(f"Local file_path does not exist: {src!r}") from e

                if mode == "local":
                    normalized["file_path"] = local_path
                    normalized.pop("url", None)
                    if onebot_like:
                        uri = _as_file_uri(local_path)
                        normalized.setdefault("file", uri or local_path)
                    normalized_chain.append(normalized)
                    continue

                if mode != "upload":
                    raise ValueError(f"Unknown direct media mode: {mode!r}")

                if not file_name:
                    file_name = os.path.basename(local_path) or None

                attach_resp = await client.post_attachment_file(
                    local_path,
                    file_name=file_name,
                    mime_type=mime_type,
                )

                if attach_resp.get("status") != "ok":
                    raise RuntimeError(attach_resp.get("message") or "Attachment upload failed")

                attach_data = attach_resp.get("data") or {}
                attachment_id = attach_data.get("attachment_id")
                if not attachment_id:
                    raise RuntimeError(
                        "Attachment upload succeeded but attachment_id is missing"
                    )

                download_url = _attachment_download_url(client, str(attachment_id))
                normalized["file_path"] = download_url
                if onebot_like:
                    normalized.setdefault("file", download_url)
                normalized.pop("url", None)
                normalized.pop("file_name", None)
                normalized.pop("mime_type", None)
                uploaded_attachments.append(attach_data)
                normalized_chain.append(normalized)
            else:
                normalized_chain.append(dict(part))

        return normalized_chain, uploaded_attachments

    # Prefer local paths (more compatible with Napcat / Windows), but keep an upload fallback.
    try:
        mode = _direct_media_mode(client)
    except ValueError as e:
        return {
            "status": "error",
            "message": str(e),
            "platform_id": platform_id,
            "session_id": str(target_id),
            "message_type": message_type,
        }
    modes_to_try = ["local", "upload"] if mode == "auto" else [mode]
    last_error: Dict[str, Any] | None = None

    for attempt_mode in modes_to_try:
        try:
            normalized_chain, uploaded_attachments = await build_chain(attempt_mode)
        except FileNotFoundError as e:
            return {
                "status": "error",
                "message": str(e),
                "platform_id": platform_id,
                "session_id": str(target_id),
                "message_type": message_type,
                "hint": "If you passed a relative path, set ASTRBOTMCP_FILE_ROOT (or run the server in the correct working directory).",
            }
        except ValueError as e:
            return {
                "status": "error",
                "message": str(e),
                "platform_id": platform_id,
                "session_id": str(target_id),
                "message_type": message_type,
                "hint": "Set ASTRBOTMCP_FILE_ROOT to control how relative paths are resolved.",
            }
        except Exception as e:
            return {
                "status": "error",
                "message": str(e),
                "platform_id": platform_id,
                "session_id": str(target_id),
                "message_type": message_type,
                "attempt_mode": attempt_mode,
            }

        if not normalized_chain:
            return {
                "status": "error",
                "message": "message_chain did not produce any valid message parts",
                "platform_id": platform_id,
                "session_id": str(target_id),
                "message_type": message_type,
            }

        try:
            direct_resp = await client.send_platform_message_direct(
                platform_id=platform_id,
                message_type=message_type,
                session_id=str(target_id),
                message_chain=normalized_chain,
            )
        except Exception as e:
            status_code = getattr(getattr(e, "response", None), "status_code", None)
            hint = "Ensure AstrBot includes /api/platform/send_message and you are authenticated."
            if status_code in (404, 405):
                hint = (
                    "Your AstrBot may not expose /api/platform/send_message (some versions only provide "
                    "/api/platform/stats and /api/platform/webhook). Upgrade AstrBot or add an HTTP route for sending."
                )
            return {
                "status": "error",
                "message": (
                    f"AstrBot API error: HTTP {status_code}"
                    if status_code is not None
                    else f"AstrBot API error: {e}"
                ),
                "platform_id": platform_id,
                "session_id": str(target_id),
                "message_type": message_type,
                "attempt_mode": attempt_mode,
                "detail": _httpx_error_detail(e),
                "hint": hint,
            }

        status = direct_resp.get("status")
        if status == "ok":
            data = direct_resp.get("data") or {}
            return {
                "status": "ok",
                "platform_id": data.get("platform_id", platform_id),
                "session_id": data.get("session_id", str(target_id)),
                "message_type": data.get("message_type", message_type),
                "attempt_mode": attempt_mode,
                "uploaded_attachments": uploaded_attachments,
            }

        last_error = {
            "status": status,
            "platform_id": platform_id,
            "session_id": str(target_id),
            "message_type": message_type,
            "attempt_mode": attempt_mode,
            "message": direct_resp.get("message"),
            "raw": direct_resp,
        }

    return last_error or {
        "status": "error",
        "message": "Failed to send message",
        "platform_id": platform_id,
        "session_id": str(target_id),
        "message_type": message_type,
    }