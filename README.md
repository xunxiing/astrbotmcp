## AstrBot MCP

[![MCP Badge](https://lobehub.com/badge/mcp/xunxiing-astrbotmcp)](https://lobehub.com/mcp/xunxiing-astrbotmcp)

> **AstrBot 无法通过 MCP 控制自身。本项目填补了这一空白。**

### 警告与免责声明

⚠️ **本项目提供的是运维级控制能力，使用时请注意：**

1. **重启风险** - `restart_astrbot` 会中断所有正在进行的对话
2. **权限管理** - 确保 MCP 客户端的访问权限受控
3. **生产环境** - 建议仅在开发/测试环境使用控制面功能
4. **数据安全** - 日志可能包含敏感信息，注意脱敏处理

**本项目与 AstrBot 官方无直接关联，由社区独立维护。**

---

### 这个项目到底在干什么

#### AstrBot 自身的 MCP 控制面

通过 MCP tool 实现：

- **重启 AstrBot Core** - 进程级控制，直接调用 `/api/stat/restart-core`
- **运行状态监听** - 实时日志流、平台状态监控
- **配置热加载** - 动态读取/修改配置
- **发送信息** -自动化测试插件
- **浏览插件市场**

#### 为astrbot开发者提供AI AGENT时代调试插件的自动化工具

---

### 快速开始

#### 安装

```bash
# 通过 PyPI 安装（推荐）
pip install astrbotmcp

# 或通过 uv
uv add astrbotmcp
```

#### MCP 客户端配置

在 Cursor、Cline、Claude Desktop 等支持 MCP 的客户端中配置：

```json
{
  "mcpServers": {
    "astrbot-mcp": {
      "command": "uvx",
      "args": [
        "--from",
        "astrbotmcp",
        "astrbot-mcp"
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

#### 环境变量说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ASTRBOT_BASE_URL` | AstrBot Dashboard 地址 | `http://127.0.0.1:6185` |
| `ASTRBOT_TIMEOUT` | HTTP 请求超时时间 | `30` |
| `ASTRBOT_USERNAME` | Dashboard 用户名 | - |
| `ASTRBOT_PASSWORD` | Dashboard 密码 | - |
| `ASTRBOT_LOG_LEVEL` | 日志级别 | `INFO` |

---

### 可用 MCP Tools

#### 控制面工具

- `restart_astrbot` - 重启 AstrBot Core
- `get_astrbot_logs` - 获取实时/历史日志
- `get_message_platforms` - 列出已配置的消息平台

#### 配置工具

- `list_astrbot_config_files` - 列出所有 AstrBot 配置文件（`/api/config/abconfs`）
- `inspect_astrbot_config` - 分层查看 JSON 配置节点（key / array length / value）
- `apply_astrbot_config_ops` - 批量 `set` / `add_key` / `append`，并自动保存 + 热重载（`/api/config/astrbot/update`）
- `search_astrbot_config_paths` - 按 key（可选再按 value）搜索配置，返回匹配项的路径（不返回大段内容）

#### 消息工具

- `send_platform_message` - 通过 Web Chat API 发送消息链
- `send_platform_message_direct` - 直接发送到平台（绕过 LLM）
- `get_platform_session_messages` - 读取会话消息历史

#### 插件市场

- `browse_plugin_market` - 浏览插件市场（搜索/排序）

---

### 使用示例

#### 在 Agent 中重启 AstrBot

```python
# Agent 可以直接调用
restart_astrbot()
```

#### 监控 AstrBot 日志

```python
# 实时获取最新日志
logs = get_astrbot_logs(wait_seconds=10)
```

#### 发送消息到指定平台

```python
# 发送带图片的消息链
send_platform_message(
    platform_id="webchat",
    message="Hello from MCP",
    images=["/path/to/image.png"]
)
```

---

### 技术架构

```
┌─────────────────┐      HTTP API      ┌──────────────────┐
│   MCP Client    │───────────────────>│  astrbot-mcp     │
│ (Cursor/Cline)  │   (MCP Protocol)   │  (FastMCP Server)│
└─────────────────┘                    └────────┬─────────┘
                                                │
                                                │ HTTP
                                                ↓
┌─────────────────┐                    ┌──────────────────┐
│   AstrBot Core  │<───────────────────│  AstrBot         │
│   + Plugins     │   (Dashboard API)  │  Dashboard       │
└─────────────────┘                    └──────────────────┘
```

---

### 开发与贡献

```bash
# 克隆项目
git clone https://github.com/yourusername/astrbot-mcp.git
cd astrbot-mcp

# 安装依赖
uv sync

# 本地运行
uv run --project . astrbot-mcp
```

---

### 许可证

MIT License - 详见 [LICENSE](LICENSE.txt) 文件。

