from __future__ import annotations

from typing import Any, Dict, List, Tuple

from ...astrbot_client import AstrBotClient
from .utils import _extract_plain_text_from_history_item, _format_quote_block


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