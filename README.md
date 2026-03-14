# AstrBot MCP (Node/TypeScript)

MCP server for operating AstrBot through:

- AstrBot REST Gateway (`astrbot_plugin_mcp_tools`) at `http://127.0.0.1:6324`

This project is a full rewrite in Node + TypeScript.

## Install

```bash
npm install
npm run build
```

## Run

```bash
node dist/src/index.js
```

or in development:

```bash
npm run dev
```

## MCP config example

```json
{
  "mcpServers": {
    "astrbot-mcp": {
      "command": "node",
      "args": ["D:/绋嬪簭/astrbotmcp/dist/src/index.js"],
      "env": {
        "ASTRBOT_GATEWAY_URL": "http://127.0.0.1:6324",
        "ASTRBOT_GATEWAY_TOKEN": "iaushdqwuikdwq78ui"
      }
    }
  }
}
```

## Environment variables

Required:

- `ASTRBOT_GATEWAY_TOKEN`

Optional:

- `ASTRBOT_GATEWAY_URL` (default: `http://127.0.0.1:6324`)
- `ASTRBOT_GATEWAY_TIMEOUT` (default: `30000`, milliseconds)
- `ASTRBOT_CAPABILITY_MODE` (`search` | `readonly` | `minimize` | `full`, default: `full`)
- `ASTRBOT_ENABLE_SEARCH_TOOLS` (`false` by default)
- `ASTRBOT_LOG_VIEW` (`compact` by default, or `raw`)
- `ASTRBOT_ENABLE_LOG_NOISE_FILTERING` (`true` by default)
- `ASTRBOT_GITHUB_ACCELERATION` (optional GitHub acceleration base URL override for plugin repo install/update; use `off` to disable MCP auto acceleration)

## Tool groups

- system: status, compact logs, logs by id, restart
- platforms: list, stats, details
- providers: list, current, details
- configs: inspect core/plugin, search, patch core/plugin
- plugins: list/details/config read+replace/install/set-enabled/reload/update/uninstall
- messages: trigger replies, recent sessions, history
- astrbot_tools: list/details/invoke/task/stream
- mcp_servers: list/register/update/uninstall/test
- personas: list/details/upsert/delete
- skills: list/install/toggle/delete
- subagents: list/config inspect/config update
- cron: list/upsert/delete
- discovery: `search_tools` (only when `ASTRBOT_ENABLE_SEARCH_TOOLS=true`)

## Safety defaults

- `capabilityMode=full` by default (as requested)
- `search_tools` is disabled by default
- logs return compact/noise-filtered output by default
- restart and logs use the gateway only; no separate dashboard auth is required

## Scripts

- `npm run check` - type check
- `npm run build` - build to `dist/`
- `npm run dev` - run directly from TypeScript

## Message semantics

- `trigger_message_reply`: injects an inbound message through `/events/injections/message`, optionally overrides the target LLM provider/model/streaming flags, waits for the event to settle, and by default returns only the bot reply text. Internal metadata is hidden unless `include_debug=true`.
- `trigger_message_reply`: `session_id` can be caller-created for tests. Reuse the same id to continue one synthetic conversation; use a fresh id to start an isolated test session. For `GroupMessage`, `session_id` is usually the real group id.
- `trigger_message_reply` accepts `include_logs=false` when you want a low-context response but still keep the send-and-wait behavior.
- `get_message_history`: for `webchat`, use `conversation_id` or `target_id`; do not pass the sender id as `user_id`. `conversation_id` may also be a synthetic id you created earlier during injection tests.

## Internal tool semantics

- `list_astrbot_tools`: compact list of AstrBot internal tools. This is the clearest discovery entry for LLMs.
- `list_internal_tools`: same compact list, kept for backward compatibility.
- `get_internal_tool_details`: compact tool metadata by default, with full parameter schema controlled by `include_parameters`.
- `invoke_internal_tool`: compact invoke result by default. It returns the tool parameter schema only on the first call for the same tool within the current MCP process, then hides it on later calls to reduce context use.
- `invoke_internal_tool`: now defaults to `wait_for_completion=true`. If AstrBot returns a background `task_id`, MCP will keep polling `/tools/tasks/{task_id}` until the task is terminal or `wait_timeout_seconds` is reached.
- `invoke_internal_tool`: when a tool only returns a background acceptance message, MCP now puts that text into `accepted_reply` instead of pretending it is the final `reply`.
- `invoke_internal_tool`: `include_logs=true` appends simplified task logs to the JSON result; default is `false` to keep the response short.
- `invoke_internal_tool`: `include_image_content=true` makes MCP return completed image attachments as real MCP `image` content blocks in addition to compact JSON metadata.
- `invoke_internal_tool`: use `show_parameters=true` to force showing the tool parameter schema, `show_parameters=false` to hide it, `show_arguments=true` to echo the actual call arguments, and `show_debug=true` to include debug payloads.
- `get_internal_tool_task`: compact query for one internal tool task by `task_id`.
- `stream_internal_tool_task`: collects compact SSE task events from `/tools/tasks/{task_id}/stream` and returns the latest task snapshot plus streamed events.

## Plugin workflow

- `list_plugins`: compact plugin list for discovery only. It no longer returns full handlers/config noise.
- `get_plugin_details`: compact metadata plus command list for one plugin. Config is intentionally separated.
- `get_plugin_config_file`: fetch the full editable plugin config object.
- `replace_plugin_config_file`: replace the full plugin config object and reload the plugin.
- `install_plugin` / `update_plugin`: for GitHub repos, MCP now auto-detects a reachable GitHub acceleration prefix and uses it by default.
- `install_plugin` / `update_plugin`: prefer `github_acceleration`; `proxy` is kept only as a deprecated alias for backward compatibility.
- Recommended flow: `install_plugin` -> `get_plugin_details` -> `get_plugin_config_file` -> `replace_plugin_config_file` -> `uninstall_plugin` when needed.
