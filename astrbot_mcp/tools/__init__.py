"""
AstrBot MCP Tools

This module provides a collection of tools for interacting with AstrBot instances.
The tools are organized into separate modules by functionality:

- types: Type definitions for message parts
- helpers: Helper functions for file handling and error processing
- log_tools: Tools for retrieving AstrBot logs
- platform_tools: Tools for managing message platforms
- message_tools: Tools for sending messages to platforms
- session_tools: Tools for managing platform sessions
- control_tools: Tools for controlling AstrBot (restart, etc.)

All functions are re-exported from this module for convenience.
"""

# 导入所有工具函数，保持向后兼容
from .control_tools import restart_astrbot
from .log_tools import get_astrbot_logs
from .message_tools import (
    send_platform_message,
    send_platform_message_direct,
)
from .platform_tools import get_message_platforms
from .session_tools import get_platform_session_messages
from .plugin_market_tools import browse_plugin_market
from .config_tools import (
    list_astrbot_config_files,
    inspect_astrbot_config,
    apply_astrbot_config_ops,
)
from .config_search_tool import search_astrbot_config_paths

# 导入类型定义
from .types import MessagePart

# 导入辅助函数（内部使用）
from .helpers import (
    _as_file_uri,
    _attachment_download_url,
    _astrbot_connect_hint,
    _direct_media_mode,
    _httpx_error_detail,
    _resolve_local_file_path,
)

__all__ = [
    # 工具函数
    "get_astrbot_logs",
    "get_message_platforms",
    "send_platform_message_direct",
    "send_platform_message",
    "restart_astrbot",
    "get_platform_session_messages",
    "browse_plugin_market",
    "list_astrbot_config_files",
    "inspect_astrbot_config",
    "apply_astrbot_config_ops",
    "search_astrbot_config_paths",
    
    # 类型定义
    "MessagePart",
    
    # 辅助函数（内部使用）
    "_resolve_local_file_path",
    "_attachment_download_url",
    "_astrbot_connect_hint",
    "_httpx_error_detail",
    "_direct_media_mode",
    "_as_file_uri",
]
