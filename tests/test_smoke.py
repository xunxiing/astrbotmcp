import subprocess
import sys
import asyncio
import pytest


def test_imports() -> None:
    import astrbot_mcp.server as server_mod
    import astrbot_mcp.tools as tools_mod

    assert hasattr(server_mod, "server")
    assert callable(server_mod.main)
    assert tools_mod.__spec__ is not None
    assert tools_mod.__spec__.submodule_search_locations is not None
    assert hasattr(tools_mod, "get_astrbot_logs")
    assert not hasattr(tools_mod, "send_platform_message_direct")
    assert hasattr(tools_mod, "install_astrbot_plugin")
    assert hasattr(tools_mod, "configure_astrbot_plugin_json")
    assert hasattr(tools_mod, "manage_mcp_config_panel")
    tools = asyncio.run(server_mod.server.get_tools())
    assert "send_platform_message" in tools
    assert "send_platform_message_direct" not in tools
    assert "install_astrbot_plugin" in tools
    assert "configure_astrbot_plugin_json" in tools
    assert "manage_mcp_config_panel" in tools


def test_cli_version_flag_exits() -> None:
    result = subprocess.run(
        [sys.executable, "-c", "from astrbot_mcp.server import main; main()", "--version"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert result.stdout.strip()


def test_send_platform_message_rejects_target_id(monkeypatch) -> None:
    from astrbot_mcp.tools.message import webchat as webchat_mod

    class _DummyClient:
        pass

    monkeypatch.setattr(
        webchat_mod.AstrBotClient,
        "from_env",
        classmethod(lambda cls: _DummyClient()),
    )

    result = asyncio.run(
        webchat_mod.send_platform_message(
            platform_id="napcat",
            target_id="123456",
            message="hello",
        )
    )

    assert result["status"] == "error"
    assert "deprecated" in result["message"]
    assert result["platform_id"] == "webchat"


def test_normalize_media_sources_supports_json_string() -> None:
    from astrbot_mcp.tools.message import webchat as webchat_mod

    assert webchat_mod._normalize_media_sources(
        '["test_image.png"]',
        field_name="images",
    ) == ["test_image.png"]
    assert webchat_mod._normalize_media_sources(
        "test_image.png",
        field_name="images",
    ) == ["test_image.png"]

    with pytest.raises(ValueError):
        webchat_mod._normalize_media_sources('[1, "ok"]', field_name="images")


def test_plugin_admin_path_helpers() -> None:
    from astrbot_mcp.tools import plugin_admin_tools as plugin_tools

    assert plugin_tools._looks_like_plugin_url("https://example.com/repo.git")
    assert not plugin_tools._looks_like_plugin_url(r".\plugins\demo.zip")
    assert plugin_tools._resolve_plugin_name("astrbot_plugin_wifepicker") == "astrbot_plugin_wifepicker"
    assert plugin_tools._resolve_plugin_name(["astrbot_plugin_wifepicker"]) == "astrbot_plugin_wifepicker"


def test_plugin_market_prefers_repo_as_url() -> None:
    from astrbot_mcp.tools import plugin_market_tools as market_tools

    assert (
        market_tools._plugin_url(
            {"repo": "https://github.com/advent259141/astrbot_plugin_astrbook"}
        )
        == "https://github.com/advent259141/astrbot_plugin_astrbook"
    )
