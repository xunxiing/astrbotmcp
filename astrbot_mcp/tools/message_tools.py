from __future__ import annotations

import asyncio
import os
import textwrap
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional, Tuple, TypedDict

from ..astrbot_client import AstrBotClient
from .helpers import (
    _as_file_uri,
    _attachment_download_url,
    _astrbot_connect_hint,
    _direct_media_mode,
    _httpx_error_detail,
    _resolve_local_file_path,
)
from .types import MessagePart


_SESSION_CACHE_LOCK = asyncio.Lock()
_SESSION_CACHE: Dict[Tuple[str, str, str], str] = {}

_LAST_SAVED_MESSAGE_ID_LOCK = asyncio.Lock()
_LAST_SAVED_MESSAGE_ID_BY_SESSION: Dict[Tuple[str, str, str], str] = {}

_LAST_USER_MESSAGE_ID_LOCK = asyncio.Lock()
_LAST_USER_MESSAGE_ID_BY_SESSION: Dict[Tuple[str, str, str], str] = {}


def _session_cache_key(client: AstrBotClient, platform_id: str) -> Tuple[str, str, str]:
    return (client.base_url, client.settings.username or "", platform_id)


def _last_saved_key(client: AstrBotClient, session_id: str) -> Tuple[str, str, str]:
    return (client.base_url, client.settings.username or "", session_id)


def _extract_plain_text_from_history_item(item: Dict[str, Any]) -> str:
    content = item.get("content") or {}
    if not isinstance(content, dict):
        return str(content)
    message = content.get("message") or []
    if not isinstance(message, list):
        return str(message)

    chunks: List[str] = []
    for part in message:
        if not isinstance(part, dict):
            continue
        p_type = part.get("type")
        if p_type == "plain":
            txt = part.get("text")
            if isinstance(txt, str) and txt:
                chunks.append(txt)
        elif p_type in ("image", "file", "record", "video"):
            name = part.get("filename") or part.get("attachment_id") or ""
            if name:
                chunks.append(f"[{p_type}:{name}]")
            else:
                chunks.append(f"[{p_type}]")
        else:
            if p_type:
                chunks.append(f"[{p_type}]")
    return "".join(chunks).strip()


def _format_quote_block(*, message_id: str, sender: str, text: str) -> str:
    sender = (sender or "unknown").strip() or "unknown"
    text = (text or "").strip()
    if not text:
        text = "<empty>"
    text = textwrap.shorten(text, width=800, placeholder="…")
    return f"[引用消息 {message_id} | {sender}] {text}\n"


def _normalize_history_message_id(value: Any) -> Any:
    """
    AstrBot WebChat reply expects `message_id` to be the history record primary key (usually int).
    Keep original value if it cannot be safely converted.
    """
    if value is None:
        return None
    if isinstance(value, int):
        return value
    s = str(value).strip()
    if not s:
        return value
    if s.isdigit():
        try:
            return int(s)
        except Exception:
            return value
    return value


async def _resolve_webchat_quotes(
    client: AstrBotClient, *, session_id: str, reply_ids: List[str]
) -> Tuple[str, Dict[str, Any]]:
    """
    Resolve WebChat `message_saved.id` -> quoted text by calling /api/chat/get_session.
    Best-effort: returns a quote prefix text and debug info.
    """
    cleaned: List[str] = []
    for rid in reply_ids:
        s = str(rid).strip()
        if s:
            cleaned.append(s)
    if not cleaned:
        return "", {"resolved": {}, "missing": []}

    try:
        resp = await client.get_platform_session(session_id=session_id)
    except Exception as e:
        return "", {"error": str(e), "resolved": {}, "missing": cleaned}

    if resp.get("status") != "ok":
        return "", {"status": resp.get("status"), "message": resp.get("message"), "raw": resp}

    data = resp.get("data") or {}
    history = data.get("history") or []
    if not isinstance(history, list):
        return "", {"resolved": {}, "missing": cleaned, "raw_history_type": str(type(history))}

    index: Dict[str, Dict[str, Any]] = {}
    for item in history:
        if not isinstance(item, dict):
            continue
        mid = item.get("id")
        if mid is None:
            continue
        index[str(mid)] = item

    resolved: Dict[str, str] = {}
    missing: List[str] = []
    blocks: List[str] = []
    for rid in cleaned:
        item = index.get(str(rid))
        if not item:
            missing.append(rid)
            blocks.append(
                _format_quote_block(
                    message_id=str(rid),
                    sender="missing",
                    text="<not found in /api/chat/get_session history>",
                )
            )
            continue
        sender = (
            item.get("sender_name")
            or item.get("sender_id")
            or "unknown"
        )
        txt = _extract_plain_text_from_history_item(item)
        block = _format_quote_block(message_id=str(rid), sender=str(sender), text=txt)
        resolved[str(rid)] = block
        blocks.append(block)

    return "".join(blocks), {"resolved": resolved, "missing": missing}


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
    NOTE:
      - If you provide `target_id`, this tool sends to a real platform target (bypass LLM).
      - If you do NOT provide `target_id`, this tool uses AstrBot WebChat `/api/chat/send` (LLM required).
      - Quoting in WebChat uses history numeric ids:
        - `last_user_message_id`: the id of the user message you just sent (preferred for quoting your own message).
        - `last_saved_message_id`: the id of the bot message saved by AstrBot (from SSE `message_saved`).

    NOTE:
      - If you provide `target_id`, this tool will call AstrBot dashboard API `/api/platform/send_message`
        (bypass LLM) to send to a real group/user.
      - If you do NOT provide `target_id`, this tool uses AstrBot WebChat `/api/chat/send` (LLM required),
        and will always create/reuse a `webchat` session even if you pass another platform_id.
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


async def send_platform_message(
    platform_id: str,
    message_chain: Optional[List[MessagePart]] = None,
    message: Optional[str] = None,
    images: Optional[List[str]] = None,
    files: Optional[List[str]] = None,
    videos: Optional[List[str]] = None,
    records: Optional[List[str]] = None,
    target_id: Optional[str] = None,
    message_type: Literal["GroupMessage", "FriendMessage"] = "GroupMessage",
    session_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
    use_last_session: bool = True,
    new_session: bool = False,
    reply_to_message_id: Optional[str] = None,
    reply_to_last_saved_message: bool = False,
    reply_to_last_user_message: bool = False,
    selected_provider: Optional[str] = None,
    selected_model: Optional[str] = None,
    enable_streaming: bool = True,
) -> Dict[str, Any]:
    """
    通过 AstrBot 的 Web Chat API 发送消息链（支持文本、图片、文件等）。

    参数：
      - platform_id: 平台 ID，例如 "webchat" 或配置中的平台 ID。
      - message_chain: 消息链，由 MessagePart 列表组成。
        - 文本:  {"type": "plain", "text": "..."}
        - 回复:  {"type": "reply", "message_id": "..."}
        - 图片/文件/语音/视频: {"type": "image"|"file"|"record"|"video", "file_path": "本地路径或URL"} 或 {"type": "...", "url": "http(s) URL"}
      - message / images / files / videos / records: 可选便捷参数；当未传 message_chain 时，会自动拼成消息链。
      - session_id: 可选的平台会话 ID；如果为空，会自动为该平台创建新会话。
      - selected_provider / selected_model: 可选，指定 AstrBot 内部的 provider/model。
      - enable_streaming: 是否启用流式回复（影响 AstrBot 返回的 SSE 事件类型）。
    """
    client = AstrBotClient.from_env()

    if target_id:
        direct_result = await send_platform_message_direct(
            platform_id=platform_id,
            target_id=str(target_id),
            message_chain=message_chain,
            message=message,
            images=images,
            files=files,
            videos=videos,
            records=records,
            message_type=message_type,
        )
        if isinstance(direct_result, dict):
            direct_result.setdefault("mode", "direct")
        return direct_result

    mode = "webchat"
    session_platform_id = "webchat"
    routing_debug: Dict[str, Any] = {}
    send_started_at = datetime.now(timezone.utc)

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
    explicit_session_id = session_id or conversation_id
    used_session_id: str | None = None
    session_reused = False

    if (
        explicit_session_id
        and isinstance(explicit_session_id, str)
        and explicit_session_id.strip()
    ):
        used_session_id = explicit_session_id.strip()
        async with _SESSION_CACHE_LOCK:
            _SESSION_CACHE[_session_cache_key(client, session_platform_id)] = used_session_id
    elif use_last_session and not new_session:
        async with _SESSION_CACHE_LOCK:
            cached = _SESSION_CACHE.get(_session_cache_key(client, session_platform_id))
        if cached:
            used_session_id = cached
            session_reused = True

    if new_session or not used_session_id:
        try:
            session_resp = await client.create_platform_session(
                platform_id=session_platform_id
            )
        except Exception as e:
            return {
                "status": "error",
                "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
                "mode": mode,
                "platform_id": session_platform_id,
                "requested_platform_id": platform_id,
                "base_url": client.base_url,
                "detail": _httpx_error_detail(e),
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
        used_session_id = str(used_session_id)
        async with _SESSION_CACHE_LOCK:
            _SESSION_CACHE[_session_cache_key(client, session_platform_id)] = used_session_id
        session_reused = False

    used_session_id = str(used_session_id)

    if client.settings.username:
        username = client.settings.username.strip() or "astrbot"
        umo = f"webchat:FriendMessage:webchat!{username}!{used_session_id}"
        routing_debug["umo"] = umo

        # 1) Ensure UMO -> abconf route exists (the dashboard does this automatically).
        try:
            ucr_resp = await client.get_umo_abconf_routes()
            routing_debug["ucr_get"] = ucr_resp if ucr_resp.get("status") != "ok" else None
            if ucr_resp.get("status") == "ok":
                routing = (ucr_resp.get("data") or {}).get("routing") or {}
                if isinstance(routing, dict):
                    if umo in routing:
                        routing_debug["ucr_has_route"] = True
                    else:
                        routing_debug["ucr_has_route"] = False
                        prefix = f"webchat:FriendMessage:webchat!{username}!"
                        conf_id: str | None = None
                        for k, v in routing.items():
                            if isinstance(k, str) and k.startswith(prefix):
                                conf_id = str(v)
                                break

                        if not conf_id:
                            abconfs = await client.get_abconf_list()
                            info_list = (abconfs.get("data") or {}).get("info_list") or []
                            if isinstance(info_list, list):
                                # Prefer an active/current config if present.
                                for item in info_list:
                                    if not isinstance(item, dict):
                                        continue
                                    if item.get("active") or item.get("current") or item.get("is_current"):
                                        cid = item.get("id") or item.get("conf_id")
                                        if cid:
                                            conf_id = str(cid)
                                            break
                                if not conf_id:
                                    for item in info_list:
                                        if not isinstance(item, dict):
                                            continue
                                        cid = item.get("id") or item.get("conf_id")
                                        if cid:
                                            conf_id = str(cid)
                                            break
                            routing_debug["abconf_pick"] = conf_id

                        if conf_id:
                            upd = await client.update_umo_abconf_route(umo=umo, conf_id=conf_id)
                            routing_debug["ucr_update"] = upd
        except Exception as e:
            routing_debug["ucr_exception"] = str(e)

        # 2) Copy provider_perf rule from an existing webchat UMO (avoids "no provider supported" on fresh sessions).
        try:
            rules_resp = await client.list_session_rules(
                page=1, page_size=100, search=f"webchat!{username}!"
            )
            routing_debug["session_rules_get"] = (
                rules_resp if rules_resp.get("status") != "ok" else None
            )
            if rules_resp.get("status") == "ok":
                data = rules_resp.get("data") or {}
                rules_list = data.get("rules") or []
                if isinstance(rules_list, list):
                    source_umo = None
                    source_key = None
                    source_val = None
                    for item in rules_list:
                        if not isinstance(item, dict):
                            continue
                        rules = item.get("rules") or {}
                        if not isinstance(rules, dict):
                            continue
                        for k, v in rules.items():
                            if isinstance(k, str) and k.startswith("provider_perf_") and "chat" in k:
                                source_umo = item.get("umo")
                                source_key = k
                                source_val = v
                                break
                        if source_key:
                            break

                    if source_key and source_val is not None:
                        upd = await client.update_session_rule(
                            umo=umo, rule_key=source_key, rule_value=source_val
                        )
                        routing_debug["provider_rule_copied_from"] = source_umo
                        routing_debug["provider_rule_key"] = source_key
                        routing_debug["provider_rule_update"] = upd
        except Exception as e:
            routing_debug["session_rules_exception"] = str(e)
    else:
        routing_debug["skipped"] = "No ASTRBOT_USERNAME configured; cannot mirror dashboard session routing."

    if reply_to_last_user_message and not reply_to_message_id:
        async with _LAST_USER_MESSAGE_ID_LOCK:
            reply_to_message_id = _LAST_USER_MESSAGE_ID_BY_SESSION.get(
                _last_saved_key(client, used_session_id)
            )

    # reply_to_last_saved_message historically points to the last saved bot message (message_saved.id).
    # With user_message_saved supported, callers can prefer last_user_message_id from the response.
    if reply_to_last_saved_message and not reply_to_message_id:
        async with _LAST_SAVED_MESSAGE_ID_LOCK:
            reply_to_message_id = _LAST_SAVED_MESSAGE_ID_BY_SESSION.get(
                _last_saved_key(client, used_session_id)
            )

    # 2. 把 message_chain 转成 AstrBot chat/send 需要的 message_parts
    explicit_reply_present = False
    for part in message_chain:
        if not isinstance(part, dict):
            continue
        if part.get("type") in ("reply", "quote", "reference"):
            msg_id = part.get("message_id") or part.get("id")
            if msg_id is not None and str(msg_id).strip():
                explicit_reply_present = True
                break

    message_parts: List[Dict[str, Any]] = []
    reply_ids: List[str] = []
    if reply_to_message_id and not explicit_reply_present:
        message_parts.append(
            {
                "type": "reply",
                "message_id": _normalize_history_message_id(reply_to_message_id),
            }
        )
        reply_ids.append(str(reply_to_message_id))

    quote_debug: Dict[str, Any] | None = None
    uploaded_attachments: List[Dict[str, Any]] = []

    for part in message_chain:
        p_type = part.get("type")

        if p_type == "plain":
            text = part.get("text", "")
            message_parts.append({"type": "plain", "text": text})
        elif p_type in ("reply", "quote", "reference"):
            msg_id = part.get("message_id") or part.get("id")
            if msg_id is None:
                continue
            msg_id_str = str(msg_id).strip()
            if not msg_id_str:
                continue
            message_parts.append(
                {"type": "reply", "message_id": _normalize_history_message_id(msg_id)}
            )
            reply_ids.append(msg_id_str)
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
                    from urllib.parse import urlparse
                    parsed = urlparse(src)
                    file_name = os.path.basename(parsed.path) or None
                try:
                    attach_resp = await client.post_attachment_url(
                        src,
                        file_name=file_name,
                        mime_type=mime_type,
                    )
                except Exception as e:
                    return {
                        "status": "error",
                        "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
                        "platform_id": platform_id,
                        "session_id": used_session_id,
                        "base_url": client.base_url,
                        "detail": _httpx_error_detail(e),
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
                except Exception as e:
                    return {
                        "status": "error",
                        "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
                        "platform_id": platform_id,
                        "session_id": used_session_id,
                        "base_url": client.base_url,
                        "detail": _httpx_error_detail(e),
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

    if reply_ids:
        try:
            _ignored, quote_debug = await _resolve_webchat_quotes(
                client, session_id=used_session_id, reply_ids=reply_ids
            )
        except Exception as e:
            quote_debug = {"error": str(e), "resolved": {}, "missing": reply_ids}

    if not message_parts:
        return {
            "status": "error",
            "message": "message_chain did not produce any valid message parts",
            "mode": mode,
            "platform_id": session_platform_id,
            "requested_platform_id": platform_id,
            "quote_debug": quote_debug,
            "routing_debug": routing_debug,
        }

    # 3. 调用 /api/chat/send 并消费 SSE 回复
    # Mirror dashboard behavior: prefer session rules and UMO routing.
    # If we cannot infer/copy provider rules for a brand-new session, fall back to env defaults.
    effective_provider = selected_provider
    effective_model = selected_model
    if (
        effective_provider is None
        and effective_model is None
        and not routing_debug.get("provider_rule_key")
    ):
        effective_provider = client.settings.default_provider
        effective_model = client.settings.default_model

    try:
        events = await client.send_chat_message_sse(
            session_id=used_session_id,
            message_parts=message_parts,
            selected_provider=effective_provider,
            selected_model=effective_model,
            enable_streaming=enable_streaming,
        )
    except Exception as e:
        status_code = getattr(getattr(e, "response", None), "status_code", None)
        return {
            "status": "error",
            "message": (
                f"AstrBot API error: HTTP {status_code}"
                if status_code is not None
                else f"AstrBot API error: {e}"
            ),
            "mode": mode,
            "platform_id": session_platform_id,
            "requested_platform_id": platform_id,
            "session_id": used_session_id,
            "selected_provider": effective_provider,
            "selected_model": effective_model,
            "request_message_parts": message_parts,
            "detail": _httpx_error_detail(e),
            "hint": (
                "If you see 'has no provider supported' in AstrBot logs, "
                "set selected_provider/selected_model (or env ASTRBOT_DEFAULT_PROVIDER/ASTRBOT_DEFAULT_MODEL)."
            ),
            "quote_debug": quote_debug,
            "routing_debug": routing_debug,
        }

    # 简单聚合文本回复（仅供参考，保留原始事件）
    reply_text_chunks: List[str] = []
    saved_message_ids: List[str] = []
    user_message_ids: List[str] = []
    if not events:
        return {
            "status": "error",
            "message": "AstrBot returned no SSE events for /api/chat/send",
            "mode": mode,
            "platform_id": session_platform_id,
            "requested_platform_id": platform_id,
            "session_id": used_session_id,
            "selected_provider": effective_provider,
            "selected_model": effective_model,
            "request_message_parts": message_parts,
            "hint": "Check AstrBot logs for the root cause (often provider/model config).",
            "quote_debug": quote_debug,
            "routing_debug": routing_debug,
        }

    # If we only got bookkeeping events (e.g., user_message_saved) but no response stream at all,
    # treat it as an error while still returning useful ids.
    response_types = {"plain", "complete", "image", "record", "file", "message_saved", "end", "break"}
    has_response = any(ev.get("type") in response_types for ev in events if isinstance(ev, dict))
    if not has_response:
        user_ids = []
        for ev in events:
            if not isinstance(ev, dict):
                continue
            if ev.get("type") == "user_message_saved":
                data = ev.get("data") or {}
                mid = data.get("id")
                if mid is not None:
                    user_ids.append(str(mid))
        return {
            "status": "error",
            "message": "AstrBot produced no reply events for /api/chat/send (check AstrBot logs for provider/model errors).",
            "mode": mode,
            "platform_id": session_platform_id,
            "requested_platform_id": platform_id,
            "session_id": used_session_id,
            "selected_provider": effective_provider,
            "selected_model": effective_model,
            "request_message_parts": message_parts,
            "user_message_ids": user_ids,
            "last_user_message_id": (user_ids[-1] if user_ids else None),
            "quote_debug": quote_debug,
            "routing_debug": routing_debug,
            "reply_events": events,
        }

    for ev in events:
        if ev.get("type") == "user_message_saved":
            data = ev.get("data") or {}
            saved_id = data.get("id")
            if saved_id is not None:
                user_message_ids.append(str(saved_id))
                async with _LAST_USER_MESSAGE_ID_LOCK:
                    _LAST_USER_MESSAGE_ID_BY_SESSION[_last_saved_key(client, used_session_id)] = str(
                        saved_id
                    )
        if ev.get("type") == "message_saved":
            data = ev.get("data") or {}
            saved_id = data.get("id")
            if saved_id is not None:
                saved_message_ids.append(str(saved_id))
        if ev.get("type") in ("plain", "complete"):
            data = ev.get("data")
            if isinstance(data, str):
                reply_text_chunks.append(data)

    # Fallback: some AstrBot versions do not emit `user_message_saved`.
    # Try to infer the latest user message id by fetching /api/chat/get_session and scanning history.
    if not user_message_ids:
        match_hint = None
        for part in message_parts:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "plain":
                txt = part.get("text")
                if isinstance(txt, str) and txt.strip():
                    match_hint = txt.strip()
                    break

        try:
            sess = await client.get_platform_session(session_id=used_session_id)
            if sess.get("status") == "ok":
                history = (sess.get("data") or {}).get("history") or []
                if isinstance(history, list):
                    expected_sender = (client.settings.username or "").strip() or None

                    def is_recent_user_record(item: Dict[str, Any]) -> bool:
                        if not isinstance(item, dict):
                            return False
                        content = item.get("content") or {}
                        if not isinstance(content, dict) or content.get("type") != "user":
                            return False
                        if expected_sender and item.get("sender_name") != expected_sender:
                            return False
                        if match_hint:
                            extracted = _extract_plain_text_from_history_item(item)
                            if match_hint[:32] not in extracted:
                                return False
                        created_at = item.get("created_at")
                        if isinstance(created_at, str) and created_at:
                            try:
                                # e.g. 2025-12-18T21:47:07.684801+08:00
                                dt = datetime.fromisoformat(created_at)
                                if dt.tzinfo is None:
                                    dt = dt.replace(tzinfo=timezone.utc)
                                # accept a small clock skew window
                                return dt.astimezone(timezone.utc) >= send_started_at.replace(
                                    microsecond=0
                                ) - timedelta(seconds=5)
                            except Exception:
                                pass
                        return True

                    # Look from newest to oldest for a likely match.
                    for item in reversed(history):
                        if not isinstance(item, dict):
                            continue
                        if not is_recent_user_record(item):
                            continue
                        mid = item.get("id")
                        if mid is None:
                            continue
                        user_message_ids.append(str(mid))
                        async with _LAST_USER_MESSAGE_ID_LOCK:
                            _LAST_USER_MESSAGE_ID_BY_SESSION[_last_saved_key(client, used_session_id)] = str(
                                mid
                            )
                        break
        except Exception as e:
            routing_debug["user_id_fallback_exception"] = str(e)

    last_saved_message_id: str | None = (
        saved_message_ids[-1] if saved_message_ids else None
    )
    last_user_message_id: str | None = (
        user_message_ids[-1] if user_message_ids else None
    )
    if last_saved_message_id:
        async with _LAST_SAVED_MESSAGE_ID_LOCK:
            _LAST_SAVED_MESSAGE_ID_BY_SESSION[_last_saved_key(client, used_session_id)] = (
                last_saved_message_id
            )

    return {
        "status": "ok",
        "mode": mode,
        "platform_id": session_platform_id,
        "requested_platform_id": platform_id,
        "session_id": used_session_id,
        "conversation_id": used_session_id,
        "session_reused": session_reused,
        "selected_provider": effective_provider,
        "selected_model": effective_model,
        "request_message_parts": message_parts,
        "uploaded_attachments": uploaded_attachments,
        "reply_events": events,
        "reply_text": "".join(reply_text_chunks),
        "user_message_ids": user_message_ids,
        "last_user_message_id": last_user_message_id,
        "saved_message_ids": saved_message_ids,
        "last_saved_message_id": last_saved_message_id,
        "quote_debug": quote_debug,
        "routing_debug": routing_debug,
    }
