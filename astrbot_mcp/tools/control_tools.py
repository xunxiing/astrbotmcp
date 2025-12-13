from __future__ import annotations

import asyncio
from typing import Any, Dict

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


async def restart_astrbot() -> Dict[str, Any]:
    """
    重启 AstrBot Core，对应 /api/stat/restart-core。
    重启后会等待 AstrBot 重新启动并可用。
    """
    client = AstrBotClient.from_env()
    try:
        # 先调用重启接口
        restart_resp = await client.restart_core()
        
        # 如果重启接口返回错误，直接返回
        if restart_resp.get("status") != "ok":
            return restart_resp
            
        # 等待 AstrBot 重启完成
        # 通过轮询 /api/stat/version 接口来检测 AstrBot 是否已经重启完成
        max_wait_time = 60  # 最大等待时间 60 秒
        check_interval = 2  # 每 2 秒检查一次
        elapsed_time = 0
        
        while elapsed_time < max_wait_time:
            try:
                # 尝试获取版本信息，如果成功说明 AstrBot 已经重启完成
                version_resp = await client.get_version()
                if version_resp.get("status") == "ok":
                    return {
                        "status": "ok",
                        "message": "AstrBot 重启成功",
                        "restart_response": restart_resp,
                        "wait_time": elapsed_time
                    }
            except Exception:
                # 如果请求失败，说明 AstrBot 还在重启中，继续等待
                pass
            
            # 等待一段时间后再次检查
            await asyncio.sleep(check_interval)
            elapsed_time += check_interval
        
        # 如果等待超时，返回错误
        return {
            "status": "error",
            "message": f"AstrBot 重启超时（等待 {max_wait_time} 秒后仍未响应）",
            "restart_response": restart_resp,
            "wait_time": elapsed_time
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
        }