from __future__ import annotations

from typing import Any, Dict, List, Tuple, Union

from ..astrbot_client import AstrBotClient
from .helpers import _astrbot_connect_hint, _httpx_error_detail


JsonPathSegment = Union[str, int]


def _is_sensitive_key(key: str) -> bool:
    lowered = key.strip().lower()
    if not lowered:
        return False
    return any(
        token in lowered
        for token in (
            "password",
            "passwd",
            "secret",
            "token",
            "api_key",
            "apikey",
            "access_key",
            "private_key",
            "jwt",
            "key",
        )
    )


def _parse_path(path: str | List[Any] | None) -> List[JsonPathSegment]:
    """
    Parse a JSON path.

    Supported formats:
      - None / "" -> []
      - List segments: ["provider", 0, "model_config", "temperature"]
      - JSON Pointer: "/provider/0/model_config/temperature"
      - Dot path: "provider.0.model_config.temperature"

    Note:
      - JSON Pointer unescapes "~1" -> "/" and "~0" -> "~".
      - Numeric segments are converted to int.
      - "-" is kept as string (used for list append in some ops).
    """
    if path is None or path == "":
        return []

    if isinstance(path, list):
        segments: List[JsonPathSegment] = []
        for seg in path:
            if isinstance(seg, bool):
                raise ValueError("Path segment cannot be bool")
            if isinstance(seg, int):
                if seg < 0:
                    raise ValueError("List index cannot be negative")
                segments.append(seg)
                continue
            if isinstance(seg, str):
                s = seg.strip()
                if s == "":
                    raise ValueError("Path segment cannot be empty string")
                if s.isdigit():
                    segments.append(int(s))
                else:
                    segments.append(s)
                continue
            raise ValueError(f"Unsupported path segment type: {type(seg).__name__}")
        return segments

    if not isinstance(path, str):
        raise ValueError(f"Unsupported path type: {type(path).__name__}")

    raw = path.strip()
    if raw == "":
        return []

    # JSON Pointer
    if raw.startswith("/"):
        parts = raw.split("/")[1:]
        out: List[JsonPathSegment] = []
        for part in parts:
            part = part.replace("~1", "/").replace("~0", "~")
            if part == "":
                raise ValueError("Invalid JSON pointer: empty segment")
            if part != "-" and part.isdigit():
                out.append(int(part))
            else:
                out.append(part)
        return out

    # Dot path
    parts = raw.split(".")
    out = []
    for part in parts:
        part = part.strip()
        if part == "":
            raise ValueError("Invalid dot path: empty segment")
        if part.isdigit():
            out.append(int(part))
        else:
            out.append(part)
    return out


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


def _truncate_string(value: str, max_len: int) -> tuple[str, bool]:
    if max_len <= 0:
        return "", True
    if len(value) <= max_len:
        return value, False
    return value[:max_len], True


def _get_node(root: Any, path: List[JsonPathSegment]) -> Any:
    node = root
    for seg in path:
        if isinstance(seg, int):
            if not isinstance(node, list):
                raise TypeError(f"Expected array at segment {seg!r}, got {_type_name(node)}")
            if seg >= len(node):
                raise IndexError(f"Index out of range: {seg}")
            node = node[seg]
            continue
        if seg == "-":
            raise ValueError("'-' is only valid for append operations, not for reading")
        if not isinstance(node, dict):
            raise TypeError(f"Expected object at segment {seg!r}, got {_type_name(node)}")
        if seg not in node:
            raise KeyError(f"Key not found: {seg}")
        node = node[seg]
    return node


def _ensure_container(next_seg: JsonPathSegment) -> Any:
    if isinstance(next_seg, int):
        return []
    return {}


def _get_parent_for_write(
    root: Any,
    path: List[JsonPathSegment],
    *,
    create_missing: bool,
) -> Tuple[Any, JsonPathSegment]:
    if not path:
        raise ValueError("Path cannot be empty for write operations")

    node = root
    for i, seg in enumerate(path[:-1]):
        next_seg = path[i + 1]
        if isinstance(seg, int):
            if not isinstance(node, list):
                raise TypeError(f"Expected array at segment {seg!r}, got {_type_name(node)}")
            if seg < 0:
                raise ValueError("List index cannot be negative")
            if seg >= len(node):
                if not create_missing:
                    raise IndexError(f"Index out of range: {seg}")
                while len(node) <= seg:
                    node.append(None)
            child = node[seg]
            if child is None:
                if not create_missing:
                    raise ValueError(f"Null at path segment {seg}; set create_missing=true to create containers")
                child = _ensure_container(next_seg)
                node[seg] = child
            elif isinstance(next_seg, int) and not isinstance(child, list):
                raise TypeError(f"Expected array at segment {seg!r}, got {_type_name(child)}")
            elif isinstance(next_seg, str) and next_seg != "-" and not isinstance(child, dict):
                raise TypeError(f"Expected object at segment {seg!r}, got {_type_name(child)}")
            node = child
            continue

        if seg == "-":
            raise ValueError("'-' is only valid for final segment in append operations")

        if not isinstance(node, dict):
            raise TypeError(f"Expected object at segment {seg!r}, got {_type_name(node)}")
        if seg not in node or node[seg] is None:
            if not create_missing:
                raise KeyError(f"Key not found: {seg}")
            node[seg] = _ensure_container(next_seg)
        child = node[seg]
        if isinstance(next_seg, int) and not isinstance(child, list):
            raise TypeError(f"Expected array at segment {seg!r}, got {_type_name(child)}")
        if isinstance(next_seg, str) and next_seg != "-" and not isinstance(child, dict):
            raise TypeError(f"Expected object at segment {seg!r}, got {_type_name(child)}")
        node = child

    return node, path[-1]


def _set_value(
    root: Any,
    path: List[JsonPathSegment],
    value: Any,
    *,
    create_missing: bool,
) -> None:
    parent, last = _get_parent_for_write(root, path, create_missing=create_missing)

    if isinstance(last, int):
        if not isinstance(parent, list):
            raise TypeError(f"Expected array parent, got {_type_name(parent)}")
        if last < 0:
            raise ValueError("List index cannot be negative")
        if last >= len(parent):
            if not create_missing:
                raise IndexError(f"Index out of range: {last}")
            while len(parent) <= last:
                parent.append(None)
        parent[last] = value
        return

    if last == "-":
        if not isinstance(parent, list):
            raise TypeError(f"Expected array parent for append, got {_type_name(parent)}")
        parent.append(value)
        return

    if not isinstance(parent, dict):
        raise TypeError(f"Expected object parent, got {_type_name(parent)}")
    parent[last] = value


def _add_key(
    root: Any,
    parent_path: List[JsonPathSegment],
    *,
    key: str,
    value: Any,
    create_missing: bool,
) -> None:
    if parent_path:
        if create_missing:
            parent, last = _get_parent_for_write(
                root,
                parent_path,
                create_missing=True,
            )
            if isinstance(last, int):
                if not isinstance(parent, list):
                    raise TypeError(f"Expected array parent, got {_type_name(parent)}")
                if last >= len(parent):
                    while len(parent) <= last:
                        parent.append(None)
                if parent[last] is None:
                    parent[last] = {}
                parent = parent[last]
            else:
                if not isinstance(parent, dict):
                    raise TypeError(f"Expected object parent, got {_type_name(parent)}")
                if last not in parent or parent[last] is None:
                    parent[last] = {}
                parent = parent[last]
        else:
            parent = _get_node(root, parent_path)
    else:
        parent = root
    if not isinstance(parent, dict):
        raise TypeError(f"Expected object at parent_path, got {_type_name(parent)}")
    if key in parent:
        raise ValueError(f"Key already exists: {key}")
    parent[key] = value


def _append_list_item(
    root: Any,
    list_path: List[JsonPathSegment],
    *,
    value: Any,
    create_missing: bool,
) -> None:
    if not list_path:
        node = root
    elif create_missing:
        parent, last = _get_parent_for_write(root, list_path, create_missing=True)
        if isinstance(last, int):
            if not isinstance(parent, list):
                raise TypeError(f"Expected array parent, got {_type_name(parent)}")
            if last >= len(parent):
                while len(parent) <= last:
                    parent.append(None)
            if parent[last] is None:
                parent[last] = []
            node = parent[last]
        else:
            if not isinstance(parent, dict):
                raise TypeError(f"Expected object parent, got {_type_name(parent)}")
            if last not in parent or parent[last] is None:
                parent[last] = []
            node = parent[last]
    else:
        node = _get_node(root, list_path)
    if not isinstance(node, list):
        raise TypeError(f"Expected array at path, got {_type_name(node)}")
    node.append(value)


def _summarize_node(
    node: Any,
    *,
    max_children: int,
    include_value: bool,
    redact_secrets: bool,
    leaf_name: str | None,
    max_string_length: int,
) -> Dict[str, Any]:
    if isinstance(node, dict):
        keys = list(node.keys())
        keys.sort(key=lambda x: str(x))
        children = []
        for k in keys[: max(0, max_children)]:
            v = node.get(k)
            child: Dict[str, Any] = {"key": k, "type": _type_name(v)}
            if include_value:
                if redact_secrets and isinstance(k, str) and _is_sensitive_key(k):
                    child["value"] = "<redacted>"
                elif isinstance(v, str):
                    preview, truncated = _truncate_string(v, max_string_length)
                    child["value"] = preview
                    if truncated:
                        child["value_truncated"] = True
                        child["value_length"] = len(v)
                elif isinstance(v, dict):
                    child["preview"] = {
                        "type": "object",
                        "key_count": len(v),
                        "keys_preview": sorted(list(v.keys()))[:10],
                        "truncated": len(v) > 10,
                    }
                elif isinstance(v, list):
                    child["preview"] = {
                        "type": "array",
                        "length": len(v),
                    }
                else:
                    child["value"] = v
            children.append(child)
        return {
            "type": "object",
            "key_count": len(keys),
            "truncated": len(keys) > max_children,
            "children": children,
        }

    if isinstance(node, list):
        length = len(node)
        children = []
        for i in range(min(length, max(0, max_children))):
            v = node[i]
            child: Dict[str, Any] = {"index": i, "type": _type_name(v)}
            if include_value:
                if isinstance(v, str):
                    preview, truncated = _truncate_string(v, max_string_length)
                    child["value"] = preview
                    if truncated:
                        child["value_truncated"] = True
                        child["value_length"] = len(v)
                elif isinstance(v, dict):
                    preview: Dict[str, Any] = {"keys_preview": sorted(list(v.keys()))[:10]}
                    for preferred in ("id", "name", "type", "provider", "provider_type"):
                        if preferred in v and not (
                            redact_secrets
                            and isinstance(preferred, str)
                            and _is_sensitive_key(preferred)
                        ):
                            preview[preferred] = v.get(preferred)
                    child["preview"] = preview
                elif isinstance(v, list):
                    child["preview"] = {"type": "array", "length": len(v)}
                else:
                    child["value"] = v
            children.append(child)
        return {
            "type": "array",
            "length": length,
            "truncated": length > max_children,
            "children": children,
        }

    if include_value:
        if redact_secrets and leaf_name is not None and _is_sensitive_key(leaf_name):
            value = "<redacted>"
        elif isinstance(node, str):
            preview, truncated = _truncate_string(node, max_string_length)
            value = preview
        else:
            value = node
        out: Dict[str, Any] = {"type": _type_name(node), "value": value}
        if isinstance(node, str) and "value" in out:
            if len(node) > max_string_length:
                out["value_truncated"] = True
                out["value_length"] = len(node)
        return out
    return {"type": _type_name(node)}


async def list_astrbot_config_files() -> Dict[str, Any]:
    """
    List AstrBot config files (abconfs), via /api/config/abconfs.
    """
    client = AstrBotClient.from_env()
    try:
        result = await client.get_abconf_list()
    except Exception as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
        }

    status = result.get("status")
    if status != "ok":
        return {"status": status, "message": result.get("message"), "raw": result}

    return {"info_list": (result.get("data") or {}).get("info_list", [])}


async def inspect_astrbot_config(
    *,
    conf_id: str | None = None,
    system_config: bool = False,
    path: str | List[Any] | None = None,
    include_value: bool = False,
    max_children: int = 50,
    redact_secrets: bool = True,
    max_string_length: int = 200,
) -> Dict[str, Any]:
    """
    Inspect a node in an AstrBot config JSON.

    This tool is designed for step-by-step exploration:
    - Start with path=None to list top-level keys.
    - Then drill down by providing a deeper path.
    """
    client = AstrBotClient.from_env()

    if system_config and conf_id:
        return {"status": "error", "message": "Do not pass conf_id when system_config=true"}
    if not system_config and not conf_id:
        return {"status": "error", "message": "conf_id is required unless system_config=true"}

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

    try:
        path_segments = _parse_path(path)
        node = _get_node(config, path_segments)
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
        return {
            "conf_id": conf_id,
            "system_config": system_config,
            "path": path_segments,
            "node": summary,
        }
    except Exception as e:
        return {
            "status": "error",
            "message": str(e),
            "conf_id": conf_id,
            "system_config": system_config,
            "path": path,
        }


async def apply_astrbot_config_ops(
    *,
    conf_id: str,
    ops: List[Dict[str, Any]],
    create_missing: bool = False,
) -> Dict[str, Any]:
    """
    Apply multiple edits to an AstrBot config, then save + hot reload.

    Supported ops (batch in a single tool call):
      - {"op":"set","path":<path>,"value":<any>}
      - {"op":"add_key","path":<parent_path>,"key":<str>,"value":<any>}
      - {"op":"append","path":<list_path>,"value":<any>}

    `path` accepts dot path, JSON Pointer, or segment list.
    """
    client = AstrBotClient.from_env()

    if not conf_id:
        return {"status": "error", "message": "conf_id is required"}
    if not isinstance(ops, list) or not ops:
        return {"status": "error", "message": "ops must be a non-empty list"}

    try:
        api_result = await client.get_abconf(conf_id=conf_id, system_config=False)
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

    changed: List[List[JsonPathSegment]] = []
    counters = {"set": 0, "add_key": 0, "append": 0}
    try:
        for i, op in enumerate(ops):
            if not isinstance(op, dict):
                raise ValueError(f"ops[{i}] must be an object")
            op_name = (op.get("op") or "").strip()
            if op_name == "set":
                path_segments = _parse_path(op.get("path"))
                if not path_segments:
                    raise ValueError("set op requires non-empty path")
                _set_value(
                    config,
                    path_segments,
                    op.get("value"),
                    create_missing=create_missing,
                )
                changed.append(path_segments)
                counters["set"] += 1
            elif op_name == "add_key":
                parent_segments = _parse_path(op.get("path"))
                key = op.get("key")
                if not isinstance(key, str) or not key.strip():
                    raise ValueError("add_key op requires non-empty string 'key'")
                _add_key(
                    config,
                    parent_segments,
                    key=key,
                    value=op.get("value"),
                    create_missing=create_missing,
                )
                changed.append(parent_segments + [key])
                counters["add_key"] += 1
            elif op_name == "append":
                list_segments = _parse_path(op.get("path"))
                _append_list_item(
                    config,
                    list_segments,
                    value=op.get("value"),
                    create_missing=create_missing,
                )
                changed.append(list_segments + ["-"])
                counters["append"] += 1
            else:
                raise ValueError(f"Unsupported op: {op_name!r}")
    except Exception as e:
        return {"status": "error", "message": str(e), "op_index": i, "op": ops[i]}

    try:
        update_result = await client.update_astrbot_config(conf_id=conf_id, config=config)
    except Exception as e:
        return {
            "status": "error",
            "message": f"AstrBot API error: {e.response.status_code if hasattr(e, 'response') else 'Unknown'}",
            "base_url": client.base_url,
            "detail": _httpx_error_detail(e),
        }

    status = update_result.get("status")
    if status != "ok":
        return {"status": status, "message": update_result.get("message"), "raw": update_result}

    return {
        "message": update_result.get("message") or "ok",
        "conf_id": conf_id,
        "applied": counters,
        "changed_paths": changed,
    }
