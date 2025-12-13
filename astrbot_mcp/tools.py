from __future__ import annotations

import httpx
from typing import Any, Dict, List, Literal, Optional, TypedDict

from .astrbot_client import AstrBotClient


class MessagePart(TypedDict, total=False):
    """
    A single message part for send_platform_message.

    Types:
      - plain:  {\"type\": \"plain\", \"text\": \"...\"}
      - reply:  {\"type\": \"reply\", \"message_id\": \"...\"}
      - image:  {\"type\": \"image\", \"file_path\": \"...\"}
      - file:   {\"type\": \"file\", \"file_path\": \"...\"}
      - record: {\"type\": \"record\", \"file_path\": \"...\"}
      - video:  {\"type\": \"video\", \"file_path\": \"...\"}
    """

    type: Literal["plain", "reply", "image", "file", "record", "video"]
    text: str
    message_id: str
    file_path: str


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

    history = await client.get_log_history()
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
    result = await client.get_platform_list()

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
    message_chain: List[MessagePart],
    message_type: Literal["GroupMessage", "FriendMessage"] = "GroupMessage",
) -> Dict[str, Any]:
    """
    Directly send a message to a platform session/group/user without invoking LLM.

    This calls AstrBot dashboard endpoint: POST /api/platform/send_message
    """
    client = AstrBotClient.from_env()

    for part in message_chain:
        p_type = part.get("type")
        if p_type in ("image", "file", "record", "video"):
            file_path = part.get("file_path")
            url = part.get("url")
            src = file_path or url
            if src and isinstance(src, str) and not src.startswith(("http://", "https://")):
                return {
                    "status": "error",
                    "message": (
                        "Direct-send does not support local file_path (AstrBot cannot access MCP local files). "
                        "Use http(s) URLs in 'url' or 'file_path', or use send_platform_message (webchat) instead."
                    ),
                    "platform_id": platform_id,
                    "session_id": str(target_id),
                    "message_type": message_type,
                }

    try:
        direct_resp = await client.send_platform_message_direct(
            platform_id=platform_id,
            message_type=message_type,
            session_id=str(target_id),
            message_chain=[dict(p) for p in message_chain],
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
        }

    status = direct_resp.get("status")
    if status != "ok":
        return {
            "status": status,
            "platform_id": platform_id,
            "session_id": str(target_id),
            "message_type": message_type,
            "message": direct_resp.get("message"),
            "raw": direct_resp,
        }

    data = direct_resp.get("data") or {}
    return {
        "status": "ok",
        "platform_id": data.get("platform_id", platform_id),
        "session_id": data.get("session_id", str(target_id)),
        "message_type": data.get("message_type", message_type),
    }


async def send_platform_message(
    platform_id: str,
    message_chain: List[MessagePart],
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
        - 图片/文件/语音/视频: {\"type\": \"image\"|\"file\"|\"record\"|\"video\", \"file_path\": \"本地文件路径\"}
      - session_id: 可选的平台会话 ID；如果为空，会自动为该平台创建新会话。
      - selected_provider / selected_model: 可选，指定 AstrBot 内部的 provider/model。
      - enable_streaming: 是否启用流式回复（影响 AstrBot 返回的 SSE 事件类型）。
    """
    client = AstrBotClient.from_env()

    # 1. 确保有 session_id
    used_session_id = session_id
    if not used_session_id:
        session_resp = await client.create_platform_session(platform_id=platform_id)
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
            if not file_path:
                continue
            attach_resp = await client.post_attachment_file(file_path)
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
    result = await client.restart_core()
    return result


async def get_platform_session_messages(
    session_id: str,
) -> Dict[str, Any]:
    """
    获取指定聊天平台会话的消息历史，对应 /api/chat/get_session。

    参数：
      - session_id: 平台会话 ID（可从 send_platform_message 的返回值中获得）。
    """
    client = AstrBotClient.from_env()
    result = await client.get_platform_session(session_id=session_id)

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
