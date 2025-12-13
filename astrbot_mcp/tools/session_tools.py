from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(text: str) -> str:
    if not text:
        return ""
    return _ANSI_RE.sub("", text)


def _extract_log_text(entry: Any) -> str:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        for key in ("message", "msg", "text", "content", "event", "data"):
            val = entry.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        try:
            return json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
        except Exception:
            return str(entry)
    return str(entry)


def _extract_log_time(entry: Any) -> str | None:
    if isinstance(entry, dict):
        for key in ("time", "timestamp", "ts", "created_at", "datetime"):
            val = entry.get(key)
            if val is None:
                continue
            s = str(val).strip()
            if s:
                return s
    return None


def _extract_log_level(entry: Any) -> str | None:
    if isinstance(entry, dict):
        for key in ("level", "lvl", "severity"):
            val = entry.get(key)
            if val is None:
                continue
            s = str(val).strip()
            if s:
                return s
    return None


def _extract_time_from_text(text: str) -> str | None:
    if not text:
        return None
    match = re.search(r"\[(\d{2}:\d{2}:\d{2})\]", text)
    if match:
        return match.group(1)
    return None


def _maybe_parse_embedded_json(text: str) -> Dict[str, Any] | None:
    if not text:
        return None
    if text.lstrip().startswith("{") and text.rstrip().endswith("}"):
        try:
            val = json.loads(text)
            return val if isinstance(val, dict) else None
        except Exception:
            return None

    start = text.find("{")
    if start < 0:
        return None
    try:
        decoder = json.JSONDecoder()
        val, _end = decoder.raw_decode(text[start:])
        return val if isinstance(val, dict) else None
    except Exception:
        return None


_LTM_LINE_RE = re.compile(
    r"ltm\s*\|\s*(?P<umo>[^|]+?)\s*\|\s*\[(?P<sender>[^/\]]+?)/(?P<time>\d{2}:\d{2}:\d{2})\]\s*:\s*(?P<content>.*)$"
)


def _parse_ltm_line(text: str) -> Dict[str, Any] | None:
    match = _LTM_LINE_RE.search(text)
    if not match:
        return None
    return {
        "umo": match.group("umo").strip(),
        "sender": match.group("sender").strip(),
        "time": match.group("time").strip(),
        "content": (match.group("content") or "").strip(),
    }


def _normalize_aiocqhttp_content(raw_message: str) -> str:
    raw_message = (raw_message or "").strip()
    if not raw_message:
        return raw_message
    lowered = raw_message.lower()
    if "[cq:image" in lowered:
        return "[Image]"
    if "[cq:record" in lowered:
        return "[Record]"
    if "[cq:video" in lowered:
        return "[Video]"
    if "[cq:file" in lowered:
        return "[File]"
    return raw_message


def _parse_aiocqhttp_rawmessage(text: str) -> Dict[str, Any] | None:
    """
    Parse aiocqhttp RawMessage <Event, {...}> log line (best-effort).
    """
    if "rawmessage" not in text.lower():
        return None
    if "<Event" not in text and "<event" not in text.lower():
        return None

    def pick_int(pattern: str) -> int | None:
        match = re.search(pattern, text)
        if not match:
            return None
        try:
            return int(match.group(1))
        except Exception:
            return None

    def pick_str(pattern: str) -> str | None:
        match = re.search(pattern, text)
        if not match:
            return None
        return match.group(1)

    group_id = pick_int(r"'group_id'\s*:\s*(\d+)")
    user_id = pick_int(r"'user_id'\s*:\s*(\d+)")
    message_id = pick_int(r"'message_id'\s*:\s*(\d+)")
    nickname = pick_str(r"'nickname'\s*:\s*'([^']*)'")
    raw_message = pick_str(r"'raw_message'\s*:\s*'([^']*)'")
    if raw_message is None:
        raw_message = ""

    return {
        "group_id": group_id,
        "user_id": user_id,
        "message_id": message_id,
        "sender": nickname,
        "raw_message": raw_message,
        "content": _normalize_aiocqhttp_content(raw_message),
    }


def _log_entry_matches(
    entry: Any,
    *,
    platform_id: str,
    message_type: str,
    target_id: str,
    umo: str,
) -> bool:
    text = _extract_log_text(entry)

    # Fast path: direct substring matches (covers most plaintext logs).
    if target_id in text and (platform_id in text or message_type in text or umo in text):
        return True
    if umo in text:
        return True
    if target_id.isdigit() and len(target_id) >= 6 and target_id in text:
        # Group/user IDs are usually long numeric strings; matching them alone is often good enough.
        return True

    # Structured path: some log brokers embed event dicts / json strings.
    parsed = _maybe_parse_embedded_json(text)
    if isinstance(entry, dict) and not parsed:
        parsed = entry

    if not isinstance(parsed, dict):
        return False

    candidates = [
        parsed.get("umo"),
        parsed.get("unified_msg_origin"),
        parsed.get("origin"),
        parsed.get("user_id"),
        parsed.get("target_id"),
        parsed.get("group_id"),
        parsed.get("room_id"),
        parsed.get("channel_id"),
    ]
    for v in candidates:
        if v is None:
            continue
        sv = str(v)
        if sv == target_id or target_id in sv:
            # Try to reduce false positives by checking platform/type too (when present).
            p = parsed.get("platform_id") or parsed.get("platform") or ""
            mt = parsed.get("message_type") or parsed.get("type") or ""
            if (not p and not mt) or (platform_id in str(p) and message_type in str(mt)):
                return True
            return True

    return False


async def _fallback_history_from_logs(
    client: AstrBotClient,
    *,
    platform_id: str,
    message_type: str,
    target_id: str,
    max_messages: int,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any] | None]:
    """
    Best-effort fallback: derive recent messages from AstrBot log broker history.

    This is a pragmatic workaround for cases where AstrBot does not persist platform
    conversations (conversation.history is empty) but logs still contain message events.
    """
    try:
        log_resp = await client.get_log_history()
    except Exception as e:
        return [], {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
            "hint": "Failed to fetch /api/log-history for log fallback.",
        }

    if log_resp.get("status") != "ok":
        return [], {
            "status": log_resp.get("status"),
            "message": log_resp.get("message"),
            "raw": log_resp,
        }

    logs = (log_resp.get("data") or {}).get("logs", [])
    if not isinstance(logs, list) or not logs:
        return [], None

    umo = f"{platform_id}:{message_type}:{target_id}"
    target_id_int: int | None = int(target_id) if str(target_id).isdigit() else None
    scan_limit = min(len(logs), max(max_messages * 50, max_messages))
    tail = logs[-scan_limit:]

    kept: List[Dict[str, Any] | None] = []
    seen_keys: set[tuple] = set()
    raw_sig_to_idx: Dict[tuple, int] = {}
    ltm_sig: set[tuple] = set()
    dropped_duplicates = 0
    dropped_raw_due_to_ltm = 0

    for entry in reversed(tail):
        if not _log_entry_matches(
            entry,
            platform_id=platform_id,
            message_type=message_type,
            target_id=target_id,
            umo=umo,
        ):
            continue

        text = _strip_ansi(_extract_log_text(entry))
        entry_time = _extract_log_time(entry) or _extract_time_from_text(text)
        level = _extract_log_level(entry)

        kind = "log"
        sender: str | None = None
        content: str | None = None
        message_id: int | None = None
        user_id: int | None = None
        group_id: int | None = None

        ltm_parsed = _parse_ltm_line(text)
        if ltm_parsed and ltm_parsed.get("umo") == umo:
            kind = "ltm"
            sender = ltm_parsed.get("sender")
            content = ltm_parsed.get("content")
            entry_time = entry_time or ltm_parsed.get("time")
        else:
            raw_parsed = _parse_aiocqhttp_rawmessage(text)
            if raw_parsed and target_id_int is not None and raw_parsed.get("group_id") == target_id_int:
                kind = "raw_message"
                sender = raw_parsed.get("sender")
                content = raw_parsed.get("content")
                message_id = raw_parsed.get("message_id")
                user_id = raw_parsed.get("user_id")
                group_id = raw_parsed.get("group_id")

        # Dedup heuristics:
        # - Prefer ltm over raw_message when same (umo,time,sender).
        sig = (umo, entry_time, sender)
        if kind == "ltm":
            ltm_sig.add(sig)
            raw_idx = raw_sig_to_idx.pop(sig, None)
            if raw_idx is not None and 0 <= raw_idx < len(kept) and kept[raw_idx] is not None:
                kept[raw_idx] = None
                dropped_raw_due_to_ltm += 1
        elif kind == "raw_message":
            if sig in ltm_sig:
                dropped_raw_due_to_ltm += 1
                continue

        content_norm = (content or "").strip()
        key = (umo, entry_time, sender, content_norm)
        if key in seen_keys:
            dropped_duplicates += 1
            continue
        seen_keys.add(key)

        item: Dict[str, Any] = {"kind": kind, "time": entry_time, "sender": sender, "content": content, "text": text, "raw": entry}
        if level:
            item["level"] = level
        if message_id is not None:
            item["message_id"] = message_id
        if user_id is not None:
            item["user_id"] = user_id
        if group_id is not None:
            item["group_id"] = group_id

        if kind == "raw_message":
            raw_sig_to_idx[sig] = len(kept)

        kept.append(item)

    matched = [x for x in reversed(kept) if x is not None]
    compacted = matched[-max_messages:]
    compaction = {
        "scan_limit": scan_limit,
        "dropped_duplicates": dropped_duplicates,
        "dropped_raw_due_to_ltm": dropped_raw_due_to_ltm,
    }
    return compacted, {"status": "ok", "compaction": compaction}


async def get_platform_session_messages(
    target_id: str,
    platform_id: Optional[str] = None,
    message_type: str = "GroupMessage",
    wait_seconds: int = 0,
    max_messages: int = 50,
    poll_interval_seconds: float = 1.0,
) -> Dict[str, Any]:
    """
    Get a platform target's recent messages from AstrBot logs.

    This tool intentionally uses AstrBot's log broker history (/api/log-history) as the
    source of truth, since some AstrBot builds do not persist platform conversation history
    under /api/conversation/detail for group/user targets.

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

    # Primary: use /api/log-history
    history_source = "astrbot_log"
    log_fallback_used = True
    cid: str | None = None
    umo = f"{resolved_platform_id}:{message_type}:{target_id}"

    history, history_meta = await _fallback_history_from_logs(
        client,
        platform_id=resolved_platform_id,
        message_type=message_type,
        target_id=target_id,
        max_messages=max_messages,
    )

    log_fallback_error: Dict[str, Any] | None = None
    log_fallback_compaction: Dict[str, Any] | None = None
    if history_meta and history_meta.get("status") == "ok":
        log_fallback_compaction = (history_meta.get("compaction") or None)
    elif history_meta:
        log_fallback_error = history_meta

    # Optional: wait for new logs and return as delta
    live_error: Dict[str, Any] | None = None
    delta_items: List[Dict[str, Any]] = []
    if wait_seconds > 0:
        try:
            live_events = await client.get_live_logs(
                wait_seconds=wait_seconds,
                max_events=min(max_messages * 50, 2000),
            )
            # Reuse compaction by treating the live events list as a log tail.
            # Seed with existing keys to avoid duplicates.
            seed_seen: set[tuple] = set()
            seed_ltm: set[tuple] = set()
            seed_raw_sig_to_idx: Dict[tuple, int] = {}
            for it in history:
                t = it.get("time")
                s = it.get("sender")
                c = (it.get("content") or "").strip()
                seed_seen.add((umo, t, s, c))
                if it.get("kind") == "ltm":
                    seed_ltm.add((umo, t, s))
            # Inline-compaction of live events (reverse scan to prefer ltm).
            scan_limit = len(live_events)
            kept: List[Dict[str, Any] | None] = []
            raw_sig_to_idx = dict(seed_raw_sig_to_idx)
            ltm_sig = set(seed_ltm)
            seen_keys = set(seed_seen)
            dropped_duplicates = 0
            dropped_raw_due_to_ltm = 0

            target_id_int: int | None = int(target_id) if str(target_id).isdigit() else None
            for entry in reversed(live_events):
                if not _log_entry_matches(
                    entry,
                    platform_id=resolved_platform_id,
                    message_type=message_type,
                    target_id=target_id,
                    umo=umo,
                ):
                    continue

                text = _strip_ansi(_extract_log_text(entry))
                entry_time = _extract_log_time(entry) or _extract_time_from_text(text)
                level = _extract_log_level(entry)

                kind = "log"
                sender: str | None = None
                content: str | None = None
                message_id: int | None = None
                user_id: int | None = None
                group_id: int | None = None

                ltm_parsed = _parse_ltm_line(text)
                if ltm_parsed and ltm_parsed.get("umo") == umo:
                    kind = "ltm"
                    sender = ltm_parsed.get("sender")
                    content = ltm_parsed.get("content")
                    entry_time = entry_time or ltm_parsed.get("time")
                else:
                    raw_parsed = _parse_aiocqhttp_rawmessage(text)
                    if (
                        raw_parsed
                        and target_id_int is not None
                        and raw_parsed.get("group_id") == target_id_int
                    ):
                        kind = "raw_message"
                        sender = raw_parsed.get("sender")
                        content = raw_parsed.get("content")
                        message_id = raw_parsed.get("message_id")
                        user_id = raw_parsed.get("user_id")
                        group_id = raw_parsed.get("group_id")

                sig = (umo, entry_time, sender)
                if kind == "ltm":
                    ltm_sig.add(sig)
                    raw_idx = raw_sig_to_idx.pop(sig, None)
                    if raw_idx is not None and 0 <= raw_idx < len(kept) and kept[raw_idx] is not None:
                        kept[raw_idx] = None
                        dropped_raw_due_to_ltm += 1
                elif kind == "raw_message":
                    if sig in ltm_sig:
                        dropped_raw_due_to_ltm += 1
                        continue

                content_norm = (content or "").strip()
                key = (umo, entry_time, sender, content_norm)
                if key in seen_keys:
                    dropped_duplicates += 1
                    continue
                seen_keys.add(key)

                item: Dict[str, Any] = {"kind": kind, "time": entry_time, "sender": sender, "content": content, "text": text, "raw": entry}
                if level:
                    item["level"] = level
                if message_id is not None:
                    item["message_id"] = message_id
                if user_id is not None:
                    item["user_id"] = user_id
                if group_id is not None:
                    item["group_id"] = group_id

                if kind == "raw_message":
                    raw_sig_to_idx[sig] = len(kept)
                kept.append(item)

            delta_items = [x for x in reversed(kept) if x is not None]
            if log_fallback_compaction is not None:
                log_fallback_compaction = {
                    **log_fallback_compaction,
                    "live_scan_limit": scan_limit,
                    "live_dropped_duplicates": dropped_duplicates,
                    "live_dropped_raw_due_to_ltm": dropped_raw_due_to_ltm,
                }
        except Exception as e:
            live_error = {
                "status": "error",
                "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
                "base_url": client.base_url,
                "detail": _httpx_error_detail(e),
                "hint": "Failed to fetch /api/live-log for wait_seconds mode.",
            }

    merged_history = (history + delta_items)[-max_messages:]
    levels = {it.get("level") for it in merged_history if it.get("level")}
    log_level: str | None = None
    if len(levels) == 1:
        log_level = next(iter(levels))
        for it in merged_history:
            it.pop("level", None)
        for it in history:
            it.pop("level", None)
        for it in delta_items:
            it.pop("level", None)

    sse_events: List[Dict[str, Any]] = [{"type": "snapshot", "data": history}]
    if delta_items:
        sse_events.append({"type": "delta", "data": delta_items})

    return {
        "status": "ok",
        "platform_id": resolved_platform_id,
        "message_type": message_type,
        "target_id": target_id,
        "umo": umo,
        "cid": cid,
        "wait_seconds": wait_seconds,
        "max_messages": max_messages,
        "poll_interval_seconds": poll_interval_seconds,
        "history_source": history_source,
        "log_fallback_used": log_fallback_used,
        "log_fallback_error": log_fallback_error,
        "log_fallback_compaction": log_fallback_compaction,
        "log_level": log_level,
        "live_log_error": live_error,
        "sse_events": sse_events,
        "history": merged_history,
    }
