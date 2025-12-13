from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List, Optional, Tuple

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


async def get_platform_session_messages(
    target_id: str,
    platform_id: Optional[str] = None,
    message_type: str = "GroupMessage",
    wait_seconds: int = 0,
    max_messages: int = 50,
    poll_interval_seconds: float = 1.0,
) -> Dict[str, Any]:
    """
    Get a platform target's conversation history (group/user) from AstrBot dashboard APIs.

    Notes:
      - /api/chat/get_session only covers WebChat sessions created by AstrBot.
      - For real platform targets (e.g. Napcat group_id), AstrBot stores history under a UMO
        (unified message origin) and can be queried via:
        /api/session/active-umos + /api/conversation/list + /api/conversation/detail.

    Args:
      - target_id: Platform target ID (e.g. group_id like "1030223077").
      - platform_id: Optional platform id (e.g. "napcat"). If omitted, use the first enabled platform.
      - message_type: "GroupMessage" or "FriendMessage" (default: "GroupMessage").
      - wait_seconds: If > 0, poll and return SSE-like events for up to this many seconds.
      - max_messages: Max number of history items to return (from the tail).
      - poll_interval_seconds: Poll interval when wait_seconds > 0.
    """
    client = AstrBotClient.from_env()

    if not target_id or not str(target_id).strip():
        return {"status": "error", "message": "Missing key: target_id"}

    if max_messages <= 0:
        return {"status": "error", "message": "max_messages must be > 0"}
    if max_messages > 5000:
        max_messages = 5000

    if wait_seconds < 0:
        wait_seconds = 0
    if poll_interval_seconds <= 0:
        poll_interval_seconds = 1.0

    resolved_platform_id = platform_id
    if not resolved_platform_id:
        try:
            plist = await client.get_platform_list()
        except Exception as e:
            return {
                "status": "error",
                "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
                "base_url": client.base_url,
                "detail": _httpx_error_detail(e),
                "hint": _astrbot_connect_hint(client),
            }
        if plist.get("status") != "ok":
            return {
                "status": plist.get("status"),
                "message": plist.get("message"),
                "raw": plist,
            }
        platforms = (plist.get("data") or {}).get("platforms", [])
        enabled = [p for p in platforms if p.get("enable") is True]
        if not enabled:
            return {
                "status": "error",
                "message": "No enabled platforms found; pass platform_id explicitly.",
                "platforms": platforms,
            }
        resolved_platform_id = str(enabled[0].get("id") or "").strip() or None
        if not resolved_platform_id:
            return {
                "status": "error",
                "message": "Failed to resolve platform_id from AstrBot platform list.",
                "platforms": platforms,
            }

    async def fetch_umo_candidates() -> Tuple[List[str], Dict[str, Any] | None]:
        try:
            umos_resp = await client.list_active_umos()
        except Exception as e:
            return [], {
                "status": "error",
                "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
                "base_url": client.base_url,
                "detail": _httpx_error_detail(e),
                "hint": "AstrBot may require authentication for /api/session/active-umos.",
            }
        if umos_resp.get("status") != "ok":
            return [], {
                "status": umos_resp.get("status"),
                "message": umos_resp.get("message"),
                "raw": umos_resp,
            }
        data = umos_resp.get("data") or {}
        umos = data.get("umos") or umos_resp.get("umos") or []
        if not isinstance(umos, list):
            return [], {
                "status": "error",
                "message": "Unexpected /api/session/active-umos response shape (umos is not a list).",
                "raw": umos_resp,
            }
        return [str(x) for x in umos if isinstance(x, (str, int))], None

    def score_umo(umo: str) -> Tuple[int, int]:
        prefix = f"{resolved_platform_id}:{message_type}:"
        score = 0
        if umo.startswith(prefix):
            score += 100
        if target_id in umo:
            score += 50
        if f":{target_id}" in umo or umo.endswith(target_id):
            score += 10
        if f"!{target_id}" in umo:
            score += 5
        return (score, -len(umo))

    umos, umos_err = await fetch_umo_candidates()
    if umos_err:
        return {
            **umos_err,
            "platform_id": resolved_platform_id,
            "message_type": message_type,
            "target_id": target_id,
        }

    matching_umos = [u for u in umos if (resolved_platform_id in u and target_id in u)]
    matching_umos.sort(key=score_umo, reverse=True)

    try:
        convs_resp = await client.list_conversations(
            page=1,
            page_size=50,
            platforms=resolved_platform_id,
            message_types=message_type,
            search=target_id,
        )
    except Exception as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
            "platform_id": resolved_platform_id,
            "message_type": message_type,
            "target_id": target_id,
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
        }

    if convs_resp.get("status") != "ok":
        return {
            "status": convs_resp.get("status"),
            "message": convs_resp.get("message"),
            "platform_id": resolved_platform_id,
            "message_type": message_type,
            "target_id": target_id,
            "raw": convs_resp,
        }

    convs_data = convs_resp.get("data") or convs_resp
    conv_list = convs_data.get("conversations") if isinstance(convs_data, dict) else None
    if not isinstance(conv_list, list):
        conv_list = []

    def pick_cid(conv: Dict[str, Any]) -> Optional[str]:
        for key in ("cid", "conversation_id", "id"):
            val = conv.get(key)
            if val is None:
                continue
            s = str(val).strip()
            if s:
                return s
        return None

    def pick_user_id(conv: Dict[str, Any]) -> Optional[str]:
        for key in ("user_id", "umo", "origin"):
            val = conv.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        return None

    best_umo = matching_umos[0] if matching_umos else None
    selected_cid: str | None = None
    selected_user_id: str | None = None

    if best_umo:
        for conv in conv_list:
            if not isinstance(conv, dict):
                continue
            uid = pick_user_id(conv)
            if uid == best_umo:
                cid = pick_cid(conv)
                if cid:
                    selected_user_id = uid
                    selected_cid = cid
                    break

    if not selected_cid:
        for conv in conv_list:
            if not isinstance(conv, dict):
                continue
            uid = pick_user_id(conv) or ""
            if target_id not in uid:
                continue
            cid = pick_cid(conv)
            if not cid:
                continue
            selected_user_id = uid or best_umo
            selected_cid = cid
            break

    if not selected_cid or not selected_user_id:
        return {
            "status": "error",
            "message": "No matching conversation found for this target_id. Ensure AstrBot has recorded messages for this group/user.",
            "platform_id": resolved_platform_id,
            "message_type": message_type,
            "target_id": target_id,
            "umo_candidates": matching_umos[:10],
            "conversation_candidates": conv_list[:10],
            "hint": "If you only used /api/chat/send (WebChat), it creates a WebChat session; for real platform targets use send_platform_message_direct so AstrBot records under the target UMO.",
        }

    async def fetch_history() -> Dict[str, Any] | None:
        try:
            detail_resp = await client.get_conversation_detail(
                user_id=selected_user_id,
                cid=selected_cid,
            )
        except Exception as e:
            return {
                "status": "error",
                "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
                "platform_id": resolved_platform_id,
                "message_type": message_type,
                "target_id": target_id,
                "umo": selected_user_id,
                "cid": selected_cid,
                "base_url": client.base_url,
                "detail": _httpx_error_detail(e),
            }

        if detail_resp.get("status") != "ok":
            return {
                "status": detail_resp.get("status"),
                "message": detail_resp.get("message"),
                "platform_id": resolved_platform_id,
                "message_type": message_type,
                "target_id": target_id,
                "umo": selected_user_id,
                "cid": selected_cid,
                "raw": detail_resp,
            }

        data = detail_resp.get("data") or {}
        history = data.get("history", [])
        if not isinstance(history, list):
            history = []
        return {"status": "ok", "history": history}

    sse_events: List[Dict[str, Any]] = []
    started = time.monotonic()
    last_len: int | None = None
    last_history: List[Any] = []

    while True:
        fetched = await fetch_history()
        if not fetched or fetched.get("status") != "ok":
            return fetched or {
                "status": "error",
                "message": "Failed to fetch conversation history.",
                "platform_id": resolved_platform_id,
                "message_type": message_type,
                "target_id": target_id,
                "umo": selected_user_id,
                "cid": selected_cid,
            }

        history = fetched.get("history") or []
        if not isinstance(history, list):
            history = []

        if last_len is None:
            last_len = len(history)
            last_history = history
            sse_events.append({"type": "snapshot", "data": history[-max_messages:]})
        elif len(history) > last_len:
            delta = history[last_len:]
            sse_events.append({"type": "delta", "data": delta})
            last_len = len(history)
            last_history = history

        elapsed = time.monotonic() - started
        if wait_seconds <= 0 or elapsed >= wait_seconds:
            break

        await asyncio.sleep(poll_interval_seconds)

    final_history = (last_history or [])[-max_messages:]
    return {
        "status": "ok",
        "platform_id": resolved_platform_id,
        "message_type": message_type,
        "target_id": target_id,
        "umo": selected_user_id,
        "cid": selected_cid,
        "wait_seconds": wait_seconds,
        "max_messages": max_messages,
        "poll_interval_seconds": poll_interval_seconds,
        "sse_events": sse_events,
        "history": final_history,
    }

