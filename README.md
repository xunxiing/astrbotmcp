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

## Tool groups

- system: status, compact logs, logs by id, restart
- platforms: list, stats, details
- providers: list, current, details
- configs: inspect core/plugin, search, patch core/plugin
- plugins: list/details/install/enable/disable/reload/update/uninstall
- messages: trigger replies, recent sessions, history
- astrbot_tools: list/details/invoke
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
- `trigger_message_reply` accepts `include_logs=false` when you want a low-context response but still keep the send-and-wait behavior.
- `get_message_history`: for `webchat`, use `conversation_id` or `target_id`; do not pass the sender id as `user_id`.
