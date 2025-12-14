"""
AstrBot MCP Tools

This module provides a collection of tools for interacting with AstrBot instances.
The tools are now organized into separate modules under astrbot_mcp/tools/ for better maintainability.

For backward compatibility, all functions are still available from this module.
However, it is recommended to import from astrbot_mcp.tools directly.

Example:
    # Old way (still works)
    from astrbot_mcp.tools import get_astrbot_logs
    
    # New way (recommended)
    from astrbot_mcp.tools.log_tools import get_astrbot_logs
"""

# 导入所有工具函数，保持向后兼容
from .tools import (
    get_astrbot_logs,
    get_message_platforms,
    send_platform_message_direct,
    send_platform_message,
    restart_astrbot,
    get_platform_session_messages,
    list_astrbot_config_files,
    inspect_astrbot_config,
    apply_astrbot_config_ops,
    search_astrbot_config_paths,
    MessagePart,
)

__all__ = [
    "get_astrbot_logs",
    "get_message_platforms",
    "send_platform_message_direct",
    "send_platform_message",
    "restart_astrbot",
    "get_platform_session_messages",
    "list_astrbot_config_files",
    "inspect_astrbot_config",
    "apply_astrbot_config_ops",
    "search_astrbot_config_paths",
    "MessagePart",
]
