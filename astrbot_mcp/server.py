from __future__ import annotations

import argparse
from importlib.metadata import PackageNotFoundError, version

from fastmcp.server import FastMCP

from . import tools as astrbot_tools

server = FastMCP(
    name="astrbot-mcp",
    instructions=(
        "MCP server for interacting with an existing AstrBot instance. "
        "Provides tools to read logs, list configured message platforms, "
        "send message chains (including files) via the web chat API, "
        "restart AstrBot core, read platform session message history, "
        "and browse the AstrBot plugin market."
    ),
)

# Register tools with FastMCP
server.tool(astrbot_tools.get_astrbot_logs, name="get_astrbot_logs")
server.tool(astrbot_tools.get_message_platforms, name="get_message_platforms")
server.tool(astrbot_tools.send_platform_message_direct, name="send_platform_message_direct")
server.tool(astrbot_tools.send_platform_message, name="send_platform_message")
server.tool(astrbot_tools.restart_astrbot, name="restart_astrbot")
server.tool(
    astrbot_tools.get_platform_session_messages,
    name="get_platform_session_messages",
)
server.tool(astrbot_tools.browse_plugin_market, name="browse_plugin_market")
server.tool(astrbot_tools.list_astrbot_config_files, name="list_astrbot_config_files")
server.tool(astrbot_tools.inspect_astrbot_config, name="inspect_astrbot_config")
server.tool(astrbot_tools.apply_astrbot_config_ops, name="apply_astrbot_config_ops")
server.tool(astrbot_tools.search_astrbot_config_paths, name="search_astrbot_config_paths")


@server.resource("astrbot://info")
def astrbot_info():
    """
    Basic info resource to allow MCP hosts to discover this server.
    """
    return {
        "name": "astrbot-mcp",
        "type": "tool-provider",
        "tools": [
            "get_astrbot_logs",
            "get_message_platforms",
            "send_platform_message",
            "send_platform_message_direct",
            "restart_astrbot",
            "get_platform_session_messages",
            "browse_plugin_market",
            "list_astrbot_config_files",
            "inspect_astrbot_config",
            "apply_astrbot_config_ops",
            "search_astrbot_config_paths",
        ],
    }


def main() -> None:
    """
    Entry point for running the MCP server.

    By default this runs in stdio mode, which is what most MCP hosts expect.
    """
    parser = argparse.ArgumentParser(prog="astrbot-mcp")
    parser.add_argument(
        "--version",
        action="store_true",
        help="Print package version and exit.",
    )
    args = parser.parse_args()

    if args.version:
        try:
            print(version("astrbotmcp"))
        except PackageNotFoundError:
            print("unknown")
        return

    server.run(transport="stdio")


if __name__ == "__main__":
    main()
