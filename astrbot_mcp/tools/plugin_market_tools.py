from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Literal, Tuple

import httpx

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


def _parse_iso_datetime(value: Any) -> datetime:
    if value is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return datetime.min.replace(tzinfo=timezone.utc)
    # Handle trailing Z (UTC) which datetime.fromisoformat doesn't accept on older versions.
    text = text.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return datetime.min.replace(tzinfo=timezone.utc)


def _as_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except Exception:
        return default


def _normalize_plugin_items(raw: Any) -> List[Dict[str, Any]]:
    """
    Normalize plugin market JSON into a list of plugin dicts with an `id` field.

    Supports both:
      - dict mapping plugin_id -> plugin_info
      - list of plugin_info (best-effort)
    """
    items: List[Dict[str, Any]] = []
    if isinstance(raw, dict):
        for plugin_id, info in raw.items():
            if not isinstance(info, dict):
                continue
            items.append({"id": str(plugin_id), **info})
        return items
    if isinstance(raw, list):
        for idx, info in enumerate(raw):
            if isinstance(info, dict):
                plugin_id = str(info.get("id") or info.get("name") or idx)
                items.append({"id": plugin_id, **info})
        return items
    return items


def _plugin_haystack(item: Dict[str, Any]) -> str:
    parts: List[str] = []
    for key in ("id", "display_name", "name", "desc", "description", "author", "repo"):
        val = item.get(key)
        if val is None:
            continue
        s = str(val).strip()
        if s:
            if key == "repo":
                # Avoid every result matching "http"/"https" queries.
                s = s.removeprefix("https://").removeprefix("http://")
            parts.append(s)
    tags = item.get("tags")
    if isinstance(tags, list):
        parts.extend(str(t).strip() for t in tags if str(t).strip())
    return " ".join(parts).lower()


def _matches_query(item: Dict[str, Any], query: str) -> bool:
    query = (query or "").strip()
    if not query:
        return True
    hay = _plugin_haystack(item)
    for token in query.lower().split():
        if token and token not in hay:
            return False
    return True


async def _fetch_default_registry(timeout: float = 30.0) -> Dict[str, Any]:
    url = "https://api.soulter.top/astrbot/plugins"
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, dict):
            raise ValueError("Unexpected registry response format (expected JSON object).")
        return data


async def browse_plugin_market(
    mode: Literal["latest", "search"] = "latest",
    query: str | None = None,
    start: int = 1,
    count: int = 20,
    custom_registry: str | None = None,
    force_refresh: bool = False,
) -> Dict[str, Any]:
    """
    查看 AstrBot 插件市场（支持搜索与按时间排序）。

    用法：
      - mode="latest": 按 `updated_at` 倒序，返回第 start ~ start+count-1 条（start 从 1 开始）
      - mode="search": 按 query 搜索（名称/简介/标签/作者/仓库），再按 `updated_at` 倒序

    返回字段：
      - total_plugins: 插件市场总数（未过滤）
      - matched_plugins: 搜索命中数（mode=search）
      - plugins: 列表（包含 name/desc/tags/stars/updated_at）
    """
    if start < 1:
        return {"status": "error", "message": "start must be >= 1"}
    if count < 1 or count > 200:
        return {"status": "error", "message": "count must be in [1, 200]"}
    if mode not in ("latest", "search"):
        return {"status": "error", "message": "mode must be 'latest' or 'search'"}
    if mode == "search" and not (query or "").strip():
        return {"status": "error", "message": "query is required when mode='search'"}

    client = AstrBotClient.from_env()
    source = "astrbot"
    raw_data: Any | None = None

    try:
        result = await client.get_plugin_market_list(
            custom_registry=custom_registry,
            force_refresh=force_refresh,
        )
        if result.get("status") != "ok":
            return {
                "status": result.get("status") or "error",
                "message": result.get("message") or "AstrBot returned non-ok status.",
                "raw": result,
            }
        raw_data = (result.get("data") or {})
    except Exception as e:
        source = "remote"
        try:
            raw_data = await _fetch_default_registry(timeout=client.timeout)
        except Exception as fallback_exc:
            return {
                "status": "error",
                "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
                "base_url": client.base_url,
                "detail": _httpx_error_detail(e),
                "hint": _astrbot_connect_hint(client),
                "fallback_error": str(fallback_exc),
            }

    items = _normalize_plugin_items(raw_data)
    total = len(items)

    if mode == "search":
        items = [it for it in items if _matches_query(it, query or "")]

    def sort_key(it: Dict[str, Any]) -> Tuple[datetime, int, str]:
        dt = _parse_iso_datetime(it.get("updated_at") or it.get("update_time") or it.get("updated"))
        stars = _as_int(it.get("stars") or it.get("star") or 0)
        pid = str(it.get("id") or "")
        return (dt, stars, pid)

    items.sort(key=sort_key, reverse=True)

    matched = len(items)
    offset = start - 1
    page = items[offset : offset + count]

    plugins: List[Dict[str, Any]] = []
    for idx, it in enumerate(page, start=start):
        plugin_id = str(it.get("id") or "")
        display_name = it.get("display_name") or it.get("name") or plugin_id
        tags = it.get("tags") if isinstance(it.get("tags"), list) else []
        plugins.append(
            {
                "rank": idx,
                "id": plugin_id,
                "name": str(display_name),
                "desc": str(it.get("desc") or it.get("description") or ""),
                "tags": [str(t) for t in tags],
                "stars": _as_int(it.get("stars") or it.get("star") or 0),
                "updated_at": it.get("updated_at"),
            }
        )

    return {
        "status": "ok",
        "source": source,
        "mode": mode,
        "query": query,
        "start": start,
        "count": count,
        "total_plugins": total,
        "matched_plugins": matched if mode == "search" else total,
        "returned_plugins": len(plugins),
        "plugins": plugins,
    }
