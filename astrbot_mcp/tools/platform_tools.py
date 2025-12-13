from __future__ import annotations

from typing import Any, Dict

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


async def get_message_platforms() -> Dict[str, Any]:
    """
    获取 AstrBot 中配置的消息平台列表，对应 /api/config/platform/list。
    """
    client = AstrBotClient.from_env()
    try:
        result = await client.get_platform_list()
    except Exception as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
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

    return {
        "platforms": result.get("data", {}).get("platforms", []),
    }