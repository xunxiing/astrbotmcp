from __future__ import annotations

import textwrap
from typing import Any, Dict, List


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