from __future__ import annotations

import os
from pathlib import Path

from ..astrbot_client import AstrBotClient


def _resolve_local_file_path(client: AstrBotClient, file_path: str) -> str:
    """
    解析本地文件路径，确保路径在允许的目录范围内。
    
    Args:
        client: AstrBotClient 实例
        file_path: 文件路径（相对或绝对）
    
    Returns:
        解析后的绝对路径
    
    Raises:
        FileNotFoundError: 文件不存在
        ValueError: 路径超出允许范围
    """
    expanded = os.path.expanduser(file_path)
    candidate = Path(expanded)

    base: Path | None = None
    if not candidate.is_absolute():
        root = client.settings.file_root
        base = Path(root) if root else Path.cwd()
        candidate = base / candidate

    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as e:
        raise FileNotFoundError(str(candidate)) from e

    if base is not None:
        base_resolved = base.resolve()
        if not resolved.is_relative_to(base_resolved):
            raise ValueError(f"file_path escapes base directory: {file_path!r}")

    return str(resolved)


def _attachment_download_url(client: AstrBotClient, attachment_id: str) -> str:
    """构建附件下载 URL"""
    return f"{client.base_url}/api/chat/get_attachment?attachment_id={attachment_id}"


def _astrbot_connect_hint(client: AstrBotClient) -> str:
    """返回连接 AstrBot 的提示信息"""
    return (
        f"Cannot connect to AstrBot at {client.base_url!r}. "
        "Check ASTRBOT_BASE_URL, ensure AstrBot is running, and that the host/port is reachable."
    )


def _httpx_error_detail(exc: Exception) -> str:
    """从 httpx 异常中提取详细错误信息"""
    try:
        # 尝试从 HTTPStatusError 中获取 JSON 响应
        if hasattr(exc, 'response') and hasattr(exc.response, 'json'):
            return exc.response.json()
        elif hasattr(exc, 'response') and hasattr(exc.response, 'text'):
            return exc.response.text
    except Exception:
        pass
    return str(exc)


def _direct_media_mode(client: AstrBotClient) -> str:
    """
    获取直接媒体模式配置。
    
    返回值：
      - auto: 先尝试本地路径，然后回退到上传+URL
      - local: 始终发送本地绝对路径
      - upload: 始终先上传到 AstrBot，然后发送 http(s) URL
    """
    raw = (
        os.getenv("ASTRBOTMCP_DIRECT_MEDIA_MODE")
        or os.getenv("ASTRBOT_MCP_DIRECT_MEDIA_MODE")
        or getattr(client.settings, "direct_media_mode", None)
        or ""
    )
    mode = raw.strip().lower()
    if not mode:
        return "auto"
    if mode in ("auto", "local", "upload"):
        return mode
    raise ValueError(
        "Invalid ASTRBOTMCP_DIRECT_MEDIA_MODE; expected 'auto', 'local', or 'upload'."
    )


def _as_file_uri(path: str) -> str | None:
    """将路径转换为 file:// URI"""
    try:
        return Path(path).resolve().as_uri()
    except Exception:
        return None