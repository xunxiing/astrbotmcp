# AstrBot MCP 服务部署说明

本说明文档介绍如何在本仓库中部署和运行基于 **fastmcp** 的 AstrBot MCP 服务。

该 MCP 服务通过 AstrBot 的 HTTP API 提供以下 5 个工具：

1. `get_astrbot_logs`  
   获取 AstrBot 日志，支持等待指定秒数：
   - `wait_seconds <= 0`：立即返回 `/api/log-history` 的日志历史；
   - `wait_seconds > 0`：通过 `/api/live-log` SSE 在指定时间内持续拉取实时日志。

2. `get_message_platforms`  
   调用 `/api/config/platform/list`，获取 AstrBot 中配置的所有消息平台。

3. `send_platform_message`  
   通过 AstrBot 的 Web Chat 接口 `/api/chat/send` 发送消息链（支持文本、图片、文件等），内部流程：
   - 可选地为指定 `platform_id` 创建新的会话（`/api/chat/new_session`）；
   - 对于带有 `file_path` 的消息段，先通过 `/api/chat/post_file` 上传文件，获得 `attachment_id`；
   - 使用生成的 `message_parts` 调用 `/api/chat/send`，以 SSE 方式读取回复事件；
   - 返回使用的 `session_id`、上传的附件信息以及聚合后的回复文本。

4. `restart_astrbot`  
   调用 `/api/stat/restart-core`，重启 AstrBot Core。

5. `get_platform_session_messages`  
   通过 `/api/chat/get_session` 获取指定平台会话（`session_id`）的消息历史。

---

## 目录结构

本 MCP 服务代码位于：

- `astrbot_mcp/__init__.py`：包入口，导出 `server` 实例；
- `astrbot_mcp/config.py`：读取 AstrBot 连接配置（环境变量）；
- `astrbot_mcp/astrbot_client.py`：对 AstrBot HTTP API 的简单封装（日志、平台、会话、重启等）；
- `astrbot_mcp/tools.py`：5 个工具的具体实现逻辑；
- `astrbot_mcp/server.py`：基于 `FastMCP` 注册工具并提供运行入口 `main()`。

架构分成多个文件，便于后续扩展，但整体仍然保持简单。

---

## 环境准备

1. **Python 版本**

   建议使用 Python 3.10 或更高版本。

2. **安装依赖**

   在仓库根目录执行：

   ```bash
   pip install fastmcp httpx
   ```

   如果你使用虚拟环境，请先创建并激活虚拟环境。

3. **配置 AstrBot API 地址**

   MCP 服务通过 HTTP 调用已有的 AstrBot DashBoard / API，因此需要设置：

   - `ASTRBOT_BASE_URL`：AstrBot HTTP API 的基地址，例如：

     ```bash
     # 示例（端口号请按你的实际配置修改）
     export ASTRBOT_BASE_URL="http://127.0.0.1:8000"
     ```

    - 可选：`ASTRBOT_TIMEOUT`（默认 30 秒），设置 HTTP 请求超时时间：

      ```bash
      export ASTRBOT_TIMEOUT="30"
      ```

    - 可选：`ASTRBOT_DEFAULT_PROVIDER` / `ASTRBOT_DEFAULT_MODEL`：为 `send_platform_message` 默认指定 provider / model（不传 `selected_provider` / `selected_model` 时使用）：

      ```bash
      export ASTRBOT_DEFAULT_PROVIDER="your-provider-id"
      export ASTRBOT_DEFAULT_MODEL="your-model-id"
      ```

    在 Windows PowerShell 中可以使用：

    ```powershell
    $env:ASTRBOT_BASE_URL = "http://127.0.0.1:8000"
    $env:ASTRBOT_TIMEOUT = "30"
    $env:ASTRBOT_DEFAULT_PROVIDER = "your-provider-id"
    $env:ASTRBOT_DEFAULT_MODEL = "your-model-id"
    ```

---

## 启动 MCP 服务

在仓库根目录下运行：

```bash
python -m astrbot_mcp.server
```

或：

```bash
python astrbot_mcp/server.py
```

默认以 **stdio** 方式运行，这是大多数 MCP 宿主（例如 AstrBot 自身、支持 MCP 的编辑器或代理程序）使用的模式。

---

## 在 AstrBot 中注册此 MCP 服务（示例）

AstrBot 已经内置了 MCP 客户端管理逻辑（参见 `routes/tools.py`），可以通过 DashBoard 或 API 将本服务注册为一个 MCP Server。下面给出一个典型的配置示例，实际字段名请以 AstrBot 当前版本的文档为准。

### 1. 通过 DashBoard 配置（推荐）

在 AstrBot 后台的 MCP 配置界面中新建一条 MCP 服务，例如：

- 名称：`astrbot-mcp`
- 命令：`python -m astrbot_mcp.server`
- 传输方式：`stdio`
- 其它参数：根据你的 AstrBot 版本 UI 要求填写

保存后可以通过 DashBoard 中的「测试 MCP 连接」按钮来验证配置是否正确。

### 2. 通过 API 配置（示例）

也可以直接调用 AstrBot 的 MCP 管理接口（见 `routes/tools.py`），例如向 `/api/tools/mcp/add` 发送类似的 JSON：

```json
{
  "name": "astrbot-mcp",
  "active": true,
  "command": ["python", "-m", "astrbot_mcp.server"],
  "transport": "stdio"
}
```

实际字段（如 `command`、`transport` 等）需要与你当前 AstrBot 版本的 `llm_tools` 配置格式保持一致，此处仅给出一个参考形态。

---

## 工具参数与使用要点

### 1. `get_astrbot_logs`

- 参数：
  - `wait_seconds`（int，可选，默认 0）
  - `max_events`（int，可选，默认 200）
- 行为：
  - `wait_seconds <= 0`：调用 `/api/log-history`，返回 `{"mode": "history", "logs": [...]}`；
  - `wait_seconds > 0`：调用 `/api/live-log`，返回 `{"mode": "live", "events": [...]}`。

### 2. `get_message_platforms`

- 无参数；
- 返回值示例：

```json
{
  "platforms": [
    {
      "id": "webchat",
      "type": "webchat",
      "name": "Web Chat"
    }
  ]
}
```

具体字段取决于 AstrBot 配置文件的内容。

### 3. `send_platform_message`

- 主要参数：
  - `platform_id`：平台 ID，例如 `"webchat"` 或其它配置中的平台；
  - `message_chain`（可选）：消息链，列表形式，每个元素为：

    ```json
    { "type": "plain", "text": "你好" }
    { "type": "image", "file_path": "relative/path/to/image.png" }
    { "type": "image", "url": "https://example.com/image.png" }
    { "type": "file",  "file_path": "relative/path/to/file.pdf" }
    { "type": "video", "url": "https://example.com/video.mp4", "file_name": "video.mp4" }
    ```

    说明：
    - `file_path` 支持本地路径（绝对/相对）或 http(s) URL；相对路径会按 `ASTRBOTMCP_FILE_ROOT`（或进程工作目录）解析；
    - `url` 用于显式传入 http(s) URL；
    - `file_name` / `mime_type`（可选）用于覆盖上传时的文件名/类型。

  - `message` / `images` / `files` / `videos` / `records`（可选）：便捷参数；当未传 `message_chain` 时，会自动拼成消息链。
  - `session_id`（可选）：已有的平台会话 ID；
  - `selected_provider` / `selected_model`（可选）：AstrBot 内部 provider / model；
    - 若不传，将使用 MCP 服务端环境变量 `ASTRBOT_DEFAULT_PROVIDER` / `ASTRBOT_DEFAULT_MODEL`（如已设置），否则交由 AstrBot 使用其默认配置。
  - `enable_streaming`（bool，可选，默认 true）。

- 返回值概要：

```json
{
  "status": "ok",
  "platform_id": "webchat",
  "session_id": "xxxx",
  "request_message_parts": [...],
  "uploaded_attachments": [...],
  "reply_events": [...],
  "reply_text": "聚合后的文本回复"
}
```

你可以从返回的 `session_id` 中获取后续会话的标识，用于调用 `get_platform_session_messages`。

### 3.1 `send_platform_message_direct`

- 用途：绕过 LLM，直接调用 AstrBot 的平台适配器接口 `/api/platform/send_message` 给指定群/好友发送消息链。
- 主要参数：
  - `platform_id`：平台 ID；
  - `target_id`：群号/用户 ID；
  - `message_type`：`"GroupMessage"` 或 `"FriendMessage"`；
  - `message_chain`（可选）或 `message` / `images` / `files` / `videos` / `records`（可选）：消息内容。

注意：`send_platform_message_direct` 是“直接给平台群/好友发消息”（不是 WebChat）。

- 媒体段如果传入本地 `file_path`（例如 `D:\...`），MCP 默认会优先把“本地绝对路径”直接转发给平台适配器（对 Napcat/QQ 这类更兼容本地路径的实现更稳）。
- 如需强制“先上传到 AstrBot，再发送 URL”，可设置环境变量 `ASTRBOTMCP_DIRECT_MEDIA_MODE=upload`；默认 `auto` 会先尝试 `local`，失败再回退到 `upload`。
- 如果你直接传入 http(s) URL（通过 `url` 或 `file_path`），则会原样转发。

### 4. `restart_astrbot`

- 无参数；
- 直接映射到 `/api/stat/restart-core`，返回 AstrBot 的原始响应 JSON（通常包含 `status` 和 `message`）。

### 5. `get_platform_session_messages`

- 用途：获取真实平台群/好友的会话历史（直接从 AstrBot `/api/log-history` 日志缓存中做“最佳努力”提取，并对重复日志进行合并压缩）。
- 参数：
  - `target_id`：群号/用户 ID（例如 `"257525294"`）。
  - `platform_id`（可选）：平台 ID（例如 `"napcat"`）；不传则自动选择第一个启用的平台。
  - `message_type`（可选）：`"GroupMessage"` 或 `"FriendMessage"`，默认 `"GroupMessage"`。
  - `wait_seconds`（可选）：> 0 时会额外读取 `/api/live-log`，把时间窗口内的新消息作为 `delta` 事件返回（默认 0）。
  - `max_messages`（可选）：最多返回多少条（默认 50，最大 5000）。
  - `poll_interval_seconds`（可选）：保留字段（当前实现不使用）。
- 返回值（示例字段）：

```json
{
  "status": "ok",
  "platform_id": "napcat",
  "message_type": "GroupMessage",
  "target_id": "257525294",
  "umo": "napcat:GroupMessage:257525294",
  "cid": null,
  "history_source": "astrbot_log",
  "log_fallback_used": true,
  "log_level": "DEBUG",
  "sse_events": [...],
  "history": [...]
}
```

当 `log_level` 不变时，会把日志级别提升到顶层字段，`history` 内每条消息不再重复包含 `level`。`history` 条目主要字段：`kind/time/sender/content/text/raw`（`message_id/user_id/group_id` 仅在存在时出现）。

---

## 后续扩展建议

- 如果需要支持更多 AstrBot API（例如知识库、插件管理等），可以：
  - 在 `astrbot_mcp/astrbot_client.py` 中增加对应的 HTTP 方法；
  - 在 `astrbot_mcp/tools.py` 中封装新的工具函数；
  - 在 `astrbot_mcp/server.py` 中注册新的工具。

如你需要，我可以在这个基础上继续扩展更多工具或补充类型约束。 
