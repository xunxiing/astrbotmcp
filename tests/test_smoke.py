import subprocess
import sys


def test_imports() -> None:
    import astrbot_mcp.server as server_mod
    import astrbot_mcp.tools as tools_mod

    assert hasattr(server_mod, "server")
    assert callable(server_mod.main)
    assert tools_mod.__spec__ is not None
    assert tools_mod.__spec__.submodule_search_locations is not None
    assert hasattr(tools_mod, "get_astrbot_logs")


def test_cli_version_flag_exits() -> None:
    result = subprocess.run(
        [sys.executable, "-c", "from astrbot_mcp.server import main; main()", "--version"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert result.stdout.strip()
