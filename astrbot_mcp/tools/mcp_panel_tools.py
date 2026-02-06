from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


async def _get_astrbot_log_tail(
    client: AstrBotClient,
    *,
    limit: int = 120,
) -> Dict[str, Any] | None:
    try:
        hist = await client.get_log_history()
    except Exception as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {getattr(getattr(e, 'response', None), 'status_code', None) or 'Unknown'}",
            "detail": _httpx_error_detail(e),
        }

    if hist.get("status") != "ok":
        return {
            "status": hist.get("status"),
            "message": hist.get("message"),
            "raw": hist,
        }

    logs = (hist.get("data") or {}).get("logs", [])
    if not isinstance(logs, list):
        return {
            "status": "error",
            "message": "Unexpected /api/log-history response shape (logs is not a list).",
            "raw": hist,
        }
    return {"status": "ok", "logs": logs[-max(1, int(limit)) :]}


async def manage_mcp_config_panel(
    action: Literal["list", "add", "update", "delete", "test"] = "list",
    name: Optional[str] = None,
    server_config: Optional[Dict[str, Any]] = None,
    active: Optional[bool] = None,
    include_logs: bool = True,
    log_tail_limit: int = 120,
) -> Dict[str, Any]:
    """
    Manage AstrBot MCP config panel APIs.

    Actions:
      - list:   GET /api/tools/mcp/servers
      - add:    POST /api/tools/mcp/add
      - update: POST /api/tools/mcp/update
      - delete: POST /api/tools/mcp/delete
      - test:   POST /api/tools/mcp/test
    """
    client = AstrBotClient.from_env()

    try:
        if action == "list":
            raw = await client.get_mcp_servers()
        elif action == "add":
            if not name or not str(name).strip():
                return {"status": "error", "message": "name is required for action='add'."}
            if not isinstance(server_config, dict) or not server_config:
                return {
                    "status": "error",
                    "message": "server_config is required for action='add'.",
                }
            payload = {"name": str(name).strip(), **server_config}
            if active is not None:
                payload["active"] = bool(active)
            raw = await client.add_mcp_server(payload)
        elif action == "update":
            if not name or not str(name).strip():
                return {"status": "error", "message": "name is required for action='update'."}
            payload = {"name": str(name).strip()}
            if isinstance(server_config, dict):
                payload.update(server_config)
            if active is not None:
                payload["active"] = bool(active)
            raw = await client.update_mcp_server(payload)
        elif action == "delete":
            if not name or not str(name).strip():
                return {
                    "status": "error",
                    "message": "name is required for action='delete'.",
                }
            raw = await client.delete_mcp_server(name=str(name).strip())
        else:  # test
            if not isinstance(server_config, dict) or not server_config:
                return {
                    "status": "error",
                    "message": "server_config is required for action='test'.",
                }
            raw = await client.test_mcp_server_connection(
                mcp_server_config=server_config
            )
    except Exception as e:
        payload = {
            "status": "error",
            "message": _astrbot_connect_hint(client),
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
            "action": action,
            "name": name,
        }
        if include_logs:
            payload["astrbot_logs_tail"] = await _get_astrbot_log_tail(
                client, limit=log_tail_limit
            )
        return payload

    payload: Dict[str, Any] = {
        "status": raw.get("status", "ok"),
        "message": raw.get("message"),
        "action": action,
        "name": name,
        "raw": raw,
    }
    if action == "list" and raw.get("status") == "ok":
        servers = raw.get("data") if isinstance(raw.get("data"), list) else []
        payload["servers"] = servers
        payload["mcp_server_errlogs"] = [
            {"name": s.get("name"), "errlogs": s.get("errlogs")}
            for s in servers
            if isinstance(s, dict) and s.get("errlogs")
        ]

    if include_logs:
        payload["astrbot_logs_tail"] = await _get_astrbot_log_tail(
            client, limit=log_tail_limit
        )
    return payload
