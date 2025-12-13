from __future__ import annotations

from typing import Any, Dict

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


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
            # 避免异常直接向 MCP 宿主抛出导致 "Error calling tool"，
            # 而是把错误信息封装到正常的返回结构中，方便前端展示。
            return {
                "mode": "live",
                "wait_seconds": wait_seconds,
                "status": "error",
                "message": str(e),
            }

    try:
        history = await client.get_log_history()
    except Exception as e:
        return {
            "mode": "history",
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
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