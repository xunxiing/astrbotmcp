from __future__ import annotations

from typing import Any, Dict

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


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
    except Exception as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
            "session_id": session_id,
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
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