from __future__ import annotations

import os
from typing import Any, Dict, List, Literal, Optional, Union

from ..astrbot_client import AstrBotClient
from .config_tools import (
    _add_key,
    _append_list_item,
    _get_node,
    _parse_path,
    _set_value,
    _summarize_node,
)
from .helpers import _astrbot_connect_hint, _httpx_error_detail, _resolve_local_file_path

DEFAULT_PLUGIN_PROXY = "https://gh-proxy.com"


def _looks_like_plugin_url(source: str) -> bool:
    s = source.strip().lower()
    return s.startswith(("http://", "https://", "git@", "ssh://"))


def _resolve_plugin_name(plugin_path: Union[str, List[Any]]) -> str:
    segs = _parse_path(plugin_path)
    if not segs:
        raise ValueError("plugin_path must not be empty.")
    first = segs[0]
    if not isinstance(first, str) or not first.strip():
        raise ValueError("plugin_path must start with plugin name string.")
    return first.strip()


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


async def install_astrbot_plugin(
    source: str,
    proxy: Optional[str] = None,
    prefer_proxy: bool = True,
    include_logs: bool = True,
    log_tail_limit: int = 120,
) -> Dict[str, Any]:
    """
    Install an AstrBot plugin via repository URL or local zip path.

    - URL source: POST /api/plugin/install
    - Local zip source: POST /api/plugin/install-upload
    """
    client = AstrBotClient.from_env()

    if not isinstance(source, str) or not source.strip():
        return {"status": "error", "message": "source must be a non-empty string."}
    source = source.strip()

    install_mode = "url" if _looks_like_plugin_url(source) else "zip_upload"

    try:
        if install_mode == "url":
            effective_proxy = proxy.strip() if isinstance(proxy, str) and proxy.strip() else None
            if prefer_proxy and not effective_proxy:
                effective_proxy = (
                    os.getenv("ASTRBOTMCP_PLUGIN_PROXY")
                    or os.getenv("ASTRBOT_MCP_PLUGIN_PROXY")
                    or DEFAULT_PLUGIN_PROXY
                ).strip()
            result = await client.install_plugin_from_url(
                url=source,
                proxy=(effective_proxy if prefer_proxy else None),
            )
        else:
            resolved = _resolve_local_file_path(client, source)
            if not resolved.lower().endswith(".zip"):
                return {
                    "status": "error",
                    "message": "Local plugin source must be a .zip file path.",
                    "source": source,
                    "resolved_path": resolved,
                }
            result = await client.install_plugin_from_file(resolved)
            effective_proxy = None
    except FileNotFoundError:
        return {
            "status": "error",
            "message": f"Local zip file_path does not exist: {source!r}",
            "hint": "If you passed a relative path, set ASTRBOTMCP_FILE_ROOT or run MCP in the expected working directory.",
        }
    except ValueError as e:
        return {"status": "error", "message": str(e)}
    except Exception as e:
        payload = {
            "status": "error",
            "message": _astrbot_connect_hint(client),
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
            "source": source,
            "install_mode": install_mode,
        }
        if include_logs:
            payload["astrbot_logs_tail"] = await _get_astrbot_log_tail(
                client, limit=log_tail_limit
            )
        return payload

    payload: Dict[str, Any] = {
        "status": result.get("status", "ok"),
        "message": result.get("message"),
        "install_mode": install_mode,
        "source": source,
        "proxy": effective_proxy if install_mode == "url" and prefer_proxy else None,
        "raw": result,
    }
    if include_logs:
        payload["astrbot_logs_tail"] = await _get_astrbot_log_tail(
            client, limit=log_tail_limit
        )
    return payload


async def configure_astrbot_plugin_json(
    conf_id: str,
    plugin_path: Union[str, List[Any]],
    action: Literal["inspect", "apply"] = "inspect",
    path: Union[str, List[Any], None] = None,
    include_value: bool = True,
    max_children: int = 80,
    redact_secrets: bool = True,
    max_string_length: int = 400,
    ops: Optional[List[Dict[str, Any]]] = None,
    create_missing: bool = True,
    include_logs: bool = True,
    log_tail_limit: int = 120,
) -> Dict[str, Any]:
    """
    Configure plugin JSON by reusing AstrBot config-tool style operations.

    Internally this uses plugin-specific endpoints:
      - GET  /api/config/get?plugin_name=<name>
      - POST /api/config/plugin/update?plugin_name=<name>
    """
    client = AstrBotClient.from_env()
    try:
        plugin_name = _resolve_plugin_name(plugin_path)
    except Exception as e:
        return {
            "status": "error",
            "message": str(e),
            "action": action,
            "conf_id": conf_id,
            "plugin_path": plugin_path,
        }
    try:
        plugin_resp = await client.get_plugin_config(plugin_name=plugin_name)
    except Exception as e:
        payload = {
            "status": "error",
            "message": _astrbot_connect_hint(client),
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
            "action": action,
            "conf_id": conf_id,
            "plugin_name": plugin_name,
        }
        if include_logs:
            payload["astrbot_logs_tail"] = await _get_astrbot_log_tail(
                client, limit=log_tail_limit
            )
        return payload

    if plugin_resp.get("status") != "ok":
        payload = {
            "status": plugin_resp.get("status") or "error",
            "message": plugin_resp.get("message") or "Failed to load plugin config.",
            "action": action,
            "conf_id": conf_id,
            "plugin_name": plugin_name,
            "raw": plugin_resp,
        }
        if include_logs:
            payload["astrbot_logs_tail"] = await _get_astrbot_log_tail(
                client, limit=log_tail_limit
            )
        return payload

    data = plugin_resp.get("data") or {}
    plugin_config = data.get("config")
    plugin_metadata = data.get("metadata")
    if not isinstance(plugin_config, dict):
        payload = {
            "status": "error",
            "message": (
                f"Plugin {plugin_name!r} has no configurable JSON payload in "
                "/api/config/get."
            ),
            "action": action,
            "conf_id": conf_id,
            "plugin_name": plugin_name,
            "raw": plugin_resp,
        }
        if include_logs:
            payload["astrbot_logs_tail"] = await _get_astrbot_log_tail(
                client, limit=log_tail_limit
            )
        return payload

    try:
        if action == "inspect":
            path_segments = _parse_path(path)
            node = _get_node(plugin_config, path_segments)
            leaf_name = None
            if path_segments and isinstance(path_segments[-1], str):
                leaf_name = path_segments[-1]
            summary = _summarize_node(
                node,
                max_children=max_children,
                include_value=include_value,
                redact_secrets=redact_secrets,
                leaf_name=leaf_name,
                max_string_length=max_string_length,
            )
            payload = {
                "status": "ok",
                "action": action,
                "conf_id": conf_id,
                "conf_id_ignored_for_plugin_api": True,
                "plugin_name": plugin_name,
                "plugin_path": _parse_path(plugin_path),
                "effective_path": path_segments,
                "node": summary,
                "metadata": plugin_metadata,
            }
        else:
            if not isinstance(ops, list) or not ops:
                return {
                    "status": "error",
                    "message": "ops must be a non-empty list when action='apply'.",
                }
            changed: List[List[Any]] = []
            counters = {"set": 0, "add_key": 0, "append": 0}
            for idx, op in enumerate(ops):
                if not isinstance(op, dict):
                    return {"status": "error", "message": f"ops[{idx}] must be an object."}
                op_name = (op.get("op") or "").strip()
                path_segments = _parse_path(op.get("path"))
                if op_name == "set":
                    if not path_segments:
                        return {"status": "error", "message": "set op requires non-empty path"}
                    _set_value(
                        plugin_config,
                        path_segments,
                        op.get("value"),
                        create_missing=create_missing,
                    )
                    changed.append(path_segments)
                    counters["set"] += 1
                elif op_name == "add_key":
                    key = op.get("key")
                    if not isinstance(key, str) or not key.strip():
                        return {
                            "status": "error",
                            "message": "add_key op requires non-empty string 'key'",
                        }
                    _add_key(
                        plugin_config,
                        path_segments,
                        key=key,
                        value=op.get("value"),
                        create_missing=create_missing,
                    )
                    changed.append(path_segments + [key])
                    counters["add_key"] += 1
                elif op_name == "append":
                    _append_list_item(
                        plugin_config,
                        path_segments,
                        value=op.get("value"),
                        create_missing=create_missing,
                    )
                    changed.append(path_segments + ["-"])
                    counters["append"] += 1
                else:
                    return {"status": "error", "message": f"Unsupported op: {op_name!r}"}

            update_result = await client.update_plugin_config(
                plugin_name=plugin_name,
                config=plugin_config,
            )
            payload = {
                "status": update_result.get("status", "ok"),
                "message": update_result.get("message"),
                "action": action,
                "conf_id": conf_id,
                "conf_id_ignored_for_plugin_api": True,
                "plugin_name": plugin_name,
                "plugin_path": _parse_path(plugin_path),
                "applied": counters,
                "changed_paths": changed,
                "raw": update_result,
            }
    except Exception as e:
        payload = {
            "status": "error",
            "message": str(e),
            "action": action,
            "conf_id": conf_id,
            "plugin_name": plugin_name,
            "plugin_path": _parse_path(plugin_path),
            "path": path,
        }

    if include_logs:
        payload["astrbot_logs_tail"] = await _get_astrbot_log_tail(
            client, limit=log_tail_limit
        )
    return payload
