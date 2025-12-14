from __future__ import annotations

from typing import Any, Dict, List, Union

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


JsonPathSegment = Union[str, int]


def _type_name(value: Any) -> str:
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return type(value).__name__


def _to_pointer(path: List[JsonPathSegment]) -> str:
    def esc(seg: str) -> str:
        return seg.replace("~", "~0").replace("/", "~1")

    parts: List[str] = []
    for seg in path:
        if isinstance(seg, int):
            parts.append(str(seg))
        else:
            parts.append(esc(seg))
    return "/" + "/".join(parts)


def _to_dot(path: List[JsonPathSegment]) -> str:
    return ".".join(str(seg) for seg in path)


def _match_text(haystack: str, needle: str, *, case_sensitive: bool) -> bool:
    if not needle:
        return False
    if case_sensitive:
        return needle in haystack
    return needle.lower() in haystack.lower()


def _value_to_text(value: Any) -> str | None:
    if value is None or isinstance(value, (bool, int, float, str)):
        return str(value)
    return None


def _walk_find(
    node: Any,
    path: List[JsonPathSegment],
    *,
    key_query: str,
    value_query: str | None,
    case_sensitive: bool,
    max_results: int,
    results: List[Dict[str, Any]],
) -> None:
    if len(results) >= max_results:
        return

    if isinstance(node, dict):
        for k, v in node.items():
            if len(results) >= max_results:
                return
            if not isinstance(k, str):
                continue

            key_ok = _match_text(k, key_query, case_sensitive=case_sensitive)
            value_ok = True
            if value_query is not None:
                text = _value_to_text(v)
                value_ok = text is not None and _match_text(
                    text, value_query, case_sensitive=case_sensitive
                )

            if key_ok and value_ok:
                full_path = path + [k]
                results.append(
                    {
                        "path": full_path,
                        "path_pointer": _to_pointer(full_path),
                        "path_dot": _to_dot(full_path),
                        "type": _type_name(v),
                    }
                )

            _walk_find(
                v,
                path + [k],
                key_query=key_query,
                value_query=value_query,
                case_sensitive=case_sensitive,
                max_results=max_results,
                results=results,
            )
        return

    if isinstance(node, list):
        for i, v in enumerate(node):
            if len(results) >= max_results:
                return
            _walk_find(
                v,
                path + [i],
                key_query=key_query,
                value_query=value_query,
                case_sensitive=case_sensitive,
                max_results=max_results,
                results=results,
            )
        return


async def search_astrbot_config_paths(
    *,
    conf_id: str | None = None,
    system_config: bool = False,
    key_query: str,
    value_query: str | None = None,
    case_sensitive: bool = False,
    max_results: int = 50,
) -> Dict[str, Any]:
    """
    Search AstrBot config and return only matched key paths (no big values).

    Modes:
      - key only: provide key_query
      - key + value: provide key_query and value_query (matches leaf values of primitive types)

    Returns:
      - results: [{path, path_pointer, path_dot, type}, ...]
    """
    client = AstrBotClient.from_env()

    if system_config and conf_id:
        return {"status": "error", "message": "Do not pass conf_id when system_config=true"}
    if not system_config and not conf_id:
        return {"status": "error", "message": "conf_id is required unless system_config=true"}
    if not isinstance(key_query, str) or not key_query.strip():
        return {"status": "error", "message": "key_query must be a non-empty string"}
    if value_query is not None and (not isinstance(value_query, str) or not value_query.strip()):
        return {"status": "error", "message": "value_query must be a non-empty string or null"}
    if max_results <= 0:
        return {"status": "error", "message": "max_results must be > 0"}

    try:
        api_result = await client.get_abconf(conf_id=conf_id, system_config=system_config)
    except Exception as e:
        return {
            "status": "error",
            "message": _astrbot_connect_hint(client),
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
        }

    status = api_result.get("status")
    if status != "ok":
        return {"status": status, "message": api_result.get("message"), "raw": api_result}

    config = (api_result.get("data") or {}).get("config")
    if not isinstance(config, dict):
        return {"status": "error", "message": "AstrBot returned invalid config payload", "raw": api_result}

    results: List[Dict[str, Any]] = []
    _walk_find(
        config,
        [],
        key_query=key_query.strip(),
        value_query=value_query.strip() if isinstance(value_query, str) else None,
        case_sensitive=case_sensitive,
        max_results=max_results,
        results=results,
    )

    return {
        "conf_id": conf_id,
        "system_config": system_config,
        "key_query": key_query,
        "value_query": value_query,
        "case_sensitive": case_sensitive,
        "max_results": max_results,
        "count": len(results),
        "results": results,
    }

