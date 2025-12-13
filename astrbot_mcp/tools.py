from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

import httpx
from typing import Any, Dict, List, Literal, Optional, TypedDict

from .astrbot_client import AstrBotClient


class MessagePart(TypedDict, total=False):
    """
    A single message part for send_platform_message.

    Types:
      - plain:  {\"type\": \"plain\", \"text\": \"...\"}
      - reply:  {\"type\": \"reply\", \"message_id\": \"...\"}
      - image:  {\"type\": \"image\", \"file_path\": \"...\"} or {\"type\": \"image\", \"url\": \"https://...\"}
      - file:   {\"type\": \"file\", \"file_path\": \"...\"}  or {\"type\": \"file\", \"url\": \"https://...\"}
      - record: {\"type\": \"record\", \"file_path\": \"...\"} or {\"type\": \"record\", \"url\": \"https://...\"}
      - video:  {\"type\": \"video\", \"file_path\": \"...\"} or {\"type\": \"video\", \"url\": \"https://...\"}
    """

    type: Literal["plain", "reply", "image", "file", "record", "video"]
    text: str
    message_id: str
    file_path: str
    url: str
    file_name: str
    mime_type: str


def _resolve_local_file_path(client: AstrBotClient, file_path: str) -> str:
    expanded = os.path.expanduser(file_path)
    candidate = Path(expanded)

    base: Path | None = None
    if not candidate.is_absolute():
        root = client.settings.file_root
        base = Path(root) if root else Path.cwd()
        candidate = base / candidate

    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as e:
        raise FileNotFoundError(str(candidate)) from e

    if base is not None:
        base_resolved = base.resolve()
        if not resolved.is_relative_to(base_resolved):
            raise ValueError(f"file_path escapes base directory: {file_path!r}")

    return str(resolved)


def _attachment_download_url(client: AstrBotClient, attachment_id: str) -> str:
    return f"{client.base_url}/api/chat/get_attachment?attachment_id={attachment_id}"


def _astrbot_connect_hint(client: AstrBotClient) -> str:
    return (
        f"Cannot connect to AstrBot at {client.base_url!r}. "
        "Check ASTRBOT_BASE_URL, ensure AstrBot is running, and that the host/port is reachable."
    )


def _httpx_error_detail(exc: httpx.HTTPStatusError) -> Any:
    try:
        return exc.response.json()
    except Exception:
        return exc.response.text


def _direct_media_mode(client: AstrBotClient) -> str:
    """
    How send_platform_message_direct handles local media.

    Values:
      - auto: try local path first, then fallback to upload+URL
      - local: always send local absolute paths
      - upload: always upload to AstrBot first and send an http(s) URL
    """
    raw = (
        os.getenv("ASTRBOTMCP_DIRECT_MEDIA_MODE")
        or os.getenv("ASTRBOT_MCP_DIRECT_MEDIA_MODE")
        or getattr(client.settings, "direct_media_mode", None)
        or ""
    )
    mode = raw.strip().lower()
    if not mode:
        return "auto"
    if mode in ("auto", "local", "upload"):
        return mode
    raise ValueError(
        "Invalid ASTRBOTMCP_DIRECT_MEDIA_MODE; expected 'auto', 'local', or 'upload'."
    )


def _as_file_uri(path: str) -> str | None:
    try:
        return Path(path).resolve().as_uri()
    except Exception:
        return None


async def get_astrbot_logs(
    wait_seconds: int = 0,
    max_events: int = 200,
) -> Dict[str, Any]:
    """
    获取 AstrBot 日志。

    - 如果 wait_seconds <= 0：立即返回 /api/log-history 的数据。
    - 如果 wait_seconds > 0：通过 /api/live-log SSE 持续读取指定秒数内的新日志。
    """
    client = AstrBotClient.from_env()

    if wait_seconds > 0:
        try:
            events = await client.get_live_logs(
                wait_seconds=wait_seconds,
                max_events=max_events,
            )
            return {
                "mode": "live",
                "wait_seconds": wait_seconds,
                "events": events,
            }
        except Exception as e:
            # 避免异常直接向 MCP 宿主抛出导致 “Error calling tool”，
            # 而是把错误信息封装到正常的返回结构中，方便前端展示。
            return {
                "mode": "live",
                "wait_seconds": wait_seconds,
                "status": "error",
                "message": str(e),
            }

    try:
        history = await client.get_log_history()
    except httpx.HTTPStatusError as e:
        return {
            "mode": "history",
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code}",
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
        }
    except httpx.RequestError as e:
        return {
            "mode": "history",
            "status": "error",
            "message": f"AstrBot request error: {e!s}",
            "base_url": client.base_url,
            "hint": _astrbot_connect_hint(client),
        }
    status = history.get("status")
    if status != "ok":
        return {
            "mode": "history",
            "status": status,
            "message": history.get("message"),
            "raw": history,
        }

    return {
        "mode": "history",
        "logs": history.get("data", {}).get("logs", []),
    }


async def get_message_platforms() -> Dict[str, Any]:
    """
    获取 AstrBot 中配置的消息平台列表，对应 /api/config/platform/list。
    """
    client = AstrBotClient.from_env()
    try:
        result = await client.get_platform_list()
    except httpx.HTTPStatusError as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code}",
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
        }
    except httpx.RequestError as e:
        return {
            "status": "error",
            "message": f"AstrBot request error: {e!s}",
            "base_url": client.base_url,
            "hint": _astrbot_connect_hint(client),
        }

    status = result.get("status")
    if status != "ok":
        return {
            "status": status,
            "message": result.get("message"),
            "raw": result,
        }

    return {
        "platforms": result.get("data", {}).get("platforms", []),
    }


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
        except httpx.HTTPStatusError as e:
            return {
                "status": "error",
                "message": f"AstrBot API error: {e.response.status_code}",
                "platform_id": platform_id,
                "session_id": str(target_id),
                "message_type": message_type,
                "base_url": client.base_url,
                "detail": _httpx_error_detail(e),
            }
        except httpx.RequestError as e:
            return {
                "status": "error",
                "message": f"AstrBot request error: {e!s}",
                "platform_id": platform_id,
                "session_id": str(target_id),
                "message_type": message_type,
                "base_url": client.base_url,
                "hint": _astrbot_connect_hint(client),
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
        except httpx.HTTPStatusError as e:
            detail: Any
            try:
                detail = e.response.json()
            except Exception:
                detail = e.response.text
            return {
                "status": "error",
                "message": f"AstrBot API error: {e.response.status_code}",
                "platform_id": platform_id,
                "session_id": str(target_id),
                "message_type": message_type,
                "attempt_mode": attempt_mode,
                "detail": detail,
                "hint": "Ensure AstrBot includes /api/platform/send_message and you are authenticated.",
            }
        except httpx.RequestError as e:
            return {
                "status": "error",
                "message": f"AstrBot request error: {e!s}",
                "platform_id": platform_id,
                "session_id": str(target_id),
                "message_type": message_type,
                "attempt_mode": attempt_mode,
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


async def send_platform_message(
    platform_id: str,
    message_chain: Optional[List[MessagePart]] = None,
    message: Optional[str] = None,
    images: Optional[List[str]] = None,
    files: Optional[List[str]] = None,
    videos: Optional[List[str]] = None,
    records: Optional[List[str]] = None,
    session_id: Optional[str] = None,
    selected_provider: Optional[str] = None,
    selected_model: Optional[str] = None,
    enable_streaming: bool = True,
) -> Dict[str, Any]:
    """
    通过 AstrBot 的 Web Chat API 发送消息链（支持文本、图片、文件等）。

    参数：
      - platform_id: 平台 ID，例如 \"webchat\" 或配置中的平台 ID。
      - message_chain: 消息链，由 MessagePart 列表组成。
        - 文本:  {\"type\": \"plain\", \"text\": \"...\"}
        - 回复:  {\"type\": \"reply\", \"message_id\": \"...\"}
        - 图片/文件/语音/视频: {\"type\": \"image\"|\"file\"|\"record\"|\"video\", \"file_path\": \"本地路径或URL\"} 或 {\"type\": \"...\", \"url\": \"http(s) URL\"}
      - message / images / files / videos / records: 可选便捷参数；当未传 message_chain 时，会自动拼成消息链。
      - session_id: 可选的平台会话 ID；如果为空，会自动为该平台创建新会话。
      - selected_provider / selected_model: 可选，指定 AstrBot 内部的 provider/model。
      - enable_streaming: 是否启用流式回复（影响 AstrBot 返回的 SSE 事件类型）。
    """
    client = AstrBotClient.from_env()

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

    # 1. 确保有 session_id
    used_session_id = session_id
    if not used_session_id:
        try:
            session_resp = await client.create_platform_session(platform_id=platform_id)
        except httpx.HTTPStatusError as e:
            return {
                "status": "error",
                "message": f"AstrBot API error: {e.response.status_code}",
                "platform_id": platform_id,
                "base_url": client.base_url,
                "detail": _httpx_error_detail(e),
            }
        except httpx.RequestError as e:
            return {
                "status": "error",
                "message": f"AstrBot request error: {e!s}",
                "platform_id": platform_id,
                "base_url": client.base_url,
                "hint": _astrbot_connect_hint(client),
            }
        if session_resp.get("status") != "ok":
            return {
                "status": session_resp.get("status"),
                "message": session_resp.get("message"),
                "raw": session_resp,
            }
        data = session_resp.get("data") or {}
        used_session_id = data.get("session_id")
        if not used_session_id:
            return {
                "status": "error",
                "message": "Failed to create platform session: missing session_id",
                "raw": session_resp,
            }

    # 2. 把 message_chain 转成 AstrBot chat/send 需要的 message_parts
    message_parts: List[Dict[str, Any]] = []
    uploaded_attachments: List[Dict[str, Any]] = []

    for part in message_chain:
        p_type = part.get("type")

        if p_type == "plain":
            text = part.get("text", "")
            message_parts.append({"type": "plain", "text": text})
        elif p_type == "reply":
            msg_id = part.get("message_id")
            if msg_id:
                message_parts.append({"type": "reply", "message_id": msg_id})
        elif p_type in ("image", "file", "record", "video"):
            file_path = part.get("file_path")
            url = part.get("url")
            file_name = part.get("file_name")
            mime_type = part.get("mime_type")

            src = url or file_path
            if not src:
                continue

            if isinstance(src, str) and src.startswith(("http://", "https://")):
                if not file_name:
                    parsed = urlparse(src)
                    file_name = os.path.basename(parsed.path) or None
                try:
                    attach_resp = await client.post_attachment_url(
                        src,
                        file_name=file_name,
                        mime_type=mime_type,
                    )
                except httpx.HTTPStatusError as e:
                    return {
                        "status": "error",
                        "message": f"AstrBot API error: {e.response.status_code}",
                        "platform_id": platform_id,
                        "session_id": used_session_id,
                        "base_url": client.base_url,
                        "detail": _httpx_error_detail(e),
                    }
                except httpx.RequestError as e:
                    return {
                        "status": "error",
                        "message": f"AstrBot request error: {e!s}",
                        "platform_id": platform_id,
                        "session_id": used_session_id,
                        "base_url": client.base_url,
                        "hint": _astrbot_connect_hint(client),
                    }
            else:
                if not isinstance(src, str):
                    return {
                        "status": "error",
                        "message": f"Invalid local file_path: {src!r}",
                        "platform_id": platform_id,
                        "session_id": used_session_id,
                        "part": dict(part),
                    }
                try:
                    src = _resolve_local_file_path(client, src)
                except ValueError as e:
                    return {
                        "status": "error",
                        "message": str(e),
                        "platform_id": platform_id,
                        "session_id": used_session_id,
                        "part": dict(part),
                        "hint": "Set ASTRBOTMCP_FILE_ROOT to control how relative paths are resolved.",
                    }
                except FileNotFoundError:
                    return {
                        "status": "error",
                        "message": f"Local file_path does not exist: {src!r}",
                        "platform_id": platform_id,
                        "session_id": used_session_id,
                        "part": dict(part),
                        "hint": "If you passed a relative path, set ASTRBOTMCP_FILE_ROOT (or run the server in the correct working directory).",
                    }
                try:
                    attach_resp = await client.post_attachment_file(
                        src,
                        file_name=file_name,
                        mime_type=mime_type,
                    )
                except httpx.HTTPStatusError as e:
                    return {
                        "status": "error",
                        "message": f"AstrBot API error: {e.response.status_code}",
                        "platform_id": platform_id,
                        "session_id": used_session_id,
                        "base_url": client.base_url,
                        "detail": _httpx_error_detail(e),
                    }
                except httpx.RequestError as e:
                    return {
                        "status": "error",
                        "message": f"AstrBot request error: {e!s}",
                        "platform_id": platform_id,
                        "session_id": used_session_id,
                        "base_url": client.base_url,
                        "hint": _astrbot_connect_hint(client),
                    }
            if attach_resp.get("status") != "ok":
                return {
                    "status": attach_resp.get("status"),
                    "message": attach_resp.get("message"),
                    "raw": attach_resp,
                }
            attach_data = attach_resp.get("data") or {}
            attachment_id = attach_data.get("attachment_id")
            if not attachment_id:
                return {
                    "status": "error",
                    "message": "Attachment upload succeeded but attachment_id is missing",
                    "raw": attach_resp,
                }
            # /api/chat/send has a pre-check based on `type`, so include media type
            # alongside attachment_id (otherwise it may treat the message as empty).
            attachment_type = attach_data.get("type") or p_type
            message_parts.append({"type": attachment_type, "attachment_id": attachment_id})
            uploaded_attachments.append(attach_data)
        else:
            # 忽略未知类型
            continue

    if not message_parts:
        return {
            "status": "error",
            "message": "message_chain did not produce any valid message parts",
        }

    # 3. 调用 /api/chat/send 并消费 SSE 回复
    effective_provider = selected_provider or client.settings.default_provider
    effective_model = selected_model or client.settings.default_model

    try:
        events = await client.send_chat_message_sse(
            session_id=used_session_id,
            message_parts=message_parts,
            selected_provider=effective_provider,
            selected_model=effective_model,
            enable_streaming=enable_streaming,
        )
    except httpx.HTTPStatusError as e:
        detail: Any
        try:
            detail = e.response.json()
        except Exception:
            detail = e.response.text

        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code}",
            "platform_id": platform_id,
            "session_id": used_session_id,
            "selected_provider": effective_provider,
            "selected_model": effective_model,
            "request_message_parts": message_parts,
            "detail": detail,
            "hint": (
                "If you see 'has no provider supported' in AstrBot logs, "
                "set selected_provider/selected_model (or env ASTRBOT_DEFAULT_PROVIDER/ASTRBOT_DEFAULT_MODEL)."
            ),
        }
    except httpx.RequestError as e:
        return {
            "status": "error",
            "message": f"AstrBot request error: {e!s}",
            "platform_id": platform_id,
            "session_id": used_session_id,
            "selected_provider": effective_provider,
            "selected_model": effective_model,
            "request_message_parts": message_parts,
        }
    except Exception as e:
        return {
            "status": "error",
            "message": str(e),
            "platform_id": platform_id,
            "session_id": used_session_id,
            "selected_provider": effective_provider,
            "selected_model": effective_model,
            "request_message_parts": message_parts,
        }

    # 简单聚合文本回复（仅供参考，保留原始事件）
    reply_text_chunks: List[str] = []
    if not events:
        return {
            "status": "error",
            "message": "AstrBot returned no SSE events for /api/chat/send",
            "platform_id": platform_id,
            "session_id": used_session_id,
            "selected_provider": effective_provider,
            "selected_model": effective_model,
            "request_message_parts": message_parts,
            "hint": "Check AstrBot logs for the root cause (often provider/model config).",
        }

    for ev in events:
        if ev.get("type") in ("plain", "complete"):
            data = ev.get("data")
            if isinstance(data, str):
                reply_text_chunks.append(data)

    return {
        "status": "ok",
        "platform_id": platform_id,
        "session_id": used_session_id,
        "selected_provider": effective_provider,
        "selected_model": effective_model,
        "request_message_parts": message_parts,
        "uploaded_attachments": uploaded_attachments,
        "reply_events": events,
        "reply_text": "".join(reply_text_chunks),
    }


async def restart_astrbot() -> Dict[str, Any]:
    """
    重启 AstrBot Core，对应 /api/stat/restart-core。
    """
    client = AstrBotClient.from_env()
    try:
        return await client.restart_core()
    except httpx.HTTPStatusError as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code}",
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
        }
    except httpx.RequestError as e:
        return {
            "status": "error",
            "message": f"AstrBot request error: {e!s}",
            "base_url": client.base_url,
            "hint": _astrbot_connect_hint(client),
        }


async def get_platform_session_messages(
    session_id: str,
) -> Dict[str, Any]:
    """
    获取指定聊天平台会话的消息历史，对应 /api/chat/get_session。

    参数：
      - session_id: 平台会话 ID（可从 send_platform_message 的返回值中获得）。
    """
    client = AstrBotClient.from_env()
    try:
        result = await client.get_platform_session(session_id=session_id)
    except httpx.HTTPStatusError as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code}",
            "session_id": session_id,
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
        }
    except httpx.RequestError as e:
        return {
            "status": "error",
            "message": f"AstrBot request error: {e!s}",
            "session_id": session_id,
            "base_url": client.base_url,
            "hint": _astrbot_connect_hint(client),
        }

    status = result.get("status")
    if status != "ok":
        return {
            "status": status,
            "message": result.get("message"),
            "raw": result,
        }

    data = result.get("data") or {}
    return {
        "status": "ok",
        "session_id": session_id,
        "history": data.get("history", []),
        "is_running": data.get("is_running", False),
    }
