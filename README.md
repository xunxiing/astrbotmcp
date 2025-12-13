## AstrBot MCP Server

本项目是一个基于 FastMCP 的 AstrBot MCP 服务器，通过 HTTP 与已有的 AstrBot 实例交互。

### 本地运行

在项目根目录执行（需要安装 `uv`）：

```bash
uv sync
uv run --project . astrbot-mcp
```

如果看到 FastMCP 的 banner，说明服务启动成功。

### MCP 配置（使用 uv + console script）

在支持 MCP 的客户端中，推荐使用如下配置来启动本服务（示例为 JSON）：

```json
{
  "mcpServers": {
    "astrbot-mcp": {
      "command": "uvx",
      "args": [
        "--from",
        "astrbotmcp",
        "astrbot-mcp.exe"
      ],
      "env": {
        "ASTRBOT_BASE_URL": "http://127.0.0.1:6185",
        "ASTRBOT_TIMEOUT": "30",
        "ASTRBOT_USERNAME": "your_username",
        "ASTRBOT_PASSWORD": "your_password"
      }
    }
  }
}
```

```json{
"mcpServers": {
"astrbot-mcp": {
"command": "uv",
"args": [
"run",
"--project",
"D:/程序/astrbotmcp",
"python",
"-m",
"astrbot_mcp.server"
],
"env": {
"ASTRBOT_BASE_URL": "http://127.0.0.1:6185",
"ASTRBOT_TIMEOUT": "30",
"ASTRBOT_USERNAME": "user",
"ASTRBOT_PASSWORD": "password"
}
}
}
}
```

注意：

- 使用 `uv` 而不是系统 `python`，避免跑到全局 Python 3.13 环境。
- 使用 `--project /path/to/astrbotmcp` 指定项目路径。
- 使用 `astrbot-mcp`（console script），它会调用 `astrbot_mcp.server:main`。
- 请您务必配置pypl代理：setx UV_INDEX_URL https://pypi.tuna.tsinghua.edu.cn/simple

