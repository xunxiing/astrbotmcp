import * as z from "zod/v4";
import { existsSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerDiscoveryTools } from "./discovery-tools.js";
import { registerMessageTools } from "./message-tools.js";
import { registerSystemTools } from "./system-tools.js";
import {
  Runtime,
  ToolCatalogEntry,
  ToolRegistrar,
  categorySummary,
  encodeSegment,
  withToolErrorBoundary,
} from "./tooling.js";
import { redactSensitiveData, searchObject } from "./utils.js";

export { categorySummary };
export type { Runtime, ToolCatalogEntry };

export function registerTools(server: McpServer, runtime: Runtime): ToolCatalogEntry[] {
  const registrar = new ToolRegistrar(server, runtime);
  registerSystemTools(registrar);
  registerMessageTools(registrar);

  withToolErrorBoundary(
    registrar,
    {
      name: "list_platforms",
      summary: "List loaded platform instances.",
      category: "platforms",
      minMode: "readonly",
      risk: "read",
      aliases: ["platform", "adapter"],
    },
    {},
    async () => runtime.gateway.request("GET", "/platforms"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_platform_stats",
      summary: "Get platform live stats and optional historical stats.",
      category: "platforms",
      minMode: "readonly",
      risk: "read",
      aliases: ["platform-stats", "traffic"],
    },
    {
      include_history: z.boolean().default(false),
      history_offset_sec: z.number().int().min(60).max(7 * 24 * 3600).default(86400),
    },
    async ({ include_history, history_offset_sec }) => {
      const live = await runtime.gateway.request("GET", "/platforms/stats");
      if (!include_history) {
        return { live };
      }
      const history = await runtime.gateway.request("GET", "/platforms/stats/history", {
        query: { offset_sec: history_offset_sec },
      });
      return { live, history };
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_platform_details",
      summary: "Get one loaded platform instance details.",
      category: "platforms",
      minMode: "readonly",
      risk: "read",
      aliases: ["platform-detail"],
    },
    {
      platform_id: z.string().min(1),
    },
    async ({ platform_id }) =>
      runtime.gateway.request("GET", `/platforms/${encodeSegment(platform_id)}`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_providers",
      summary: "List loaded provider instances.",
      category: "providers",
      minMode: "readonly",
      risk: "read",
      aliases: ["provider", "model-provider"],
    },
    {},
    async () => runtime.gateway.request("GET", "/providers"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_current_provider",
      summary: "Get current provider selection.",
      category: "providers",
      minMode: "readonly",
      risk: "read",
      aliases: ["current-provider"],
    },
    {},
    async () => runtime.gateway.request("GET", "/providers/current"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_provider_details",
      summary: "Get one provider details.",
      category: "providers",
      minMode: "readonly",
      risk: "read",
      aliases: ["provider-detail"],
    },
    {
      provider_id: z.string().min(1),
    },
    async ({ provider_id }) =>
      runtime.gateway.request("GET", `/providers/${encodeSegment(provider_id)}`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "inspect_core_config",
      summary: "Inspect core AstrBot config (optionally by dot path).",
      category: "configs",
      minMode: "readonly",
      risk: "read",
      aliases: ["config", "core-config"],
    },
    {
      path: z.string().optional(),
    },
    async ({ path }) => {
      const data = await runtime.gateway.request("GET", "/configs/core", {
        query: { path },
      });
      return redactSensitiveData(data);
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "inspect_plugin_config",
      summary: "Inspect one plugin config (optionally by dot path).",
      category: "configs",
      minMode: "readonly",
      risk: "read",
      aliases: ["plugin-config"],
    },
    {
      plugin_name: z.string().min(1),
      path: z.string().optional(),
    },
    async ({ plugin_name, path }) => {
      const data = await runtime.gateway.request(
        "GET",
        `/configs/plugins/${encodeSegment(plugin_name)}`,
        { query: { path } },
      );
      return redactSensitiveData(data);
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "search_config",
      summary: "Search config keys (and optional values) in core or plugin config.",
      category: "configs",
      minMode: "readonly",
      risk: "read",
      aliases: ["find-config"],
    },
    {
      scope: z.enum(["core", "plugin"]).default("core"),
      plugin_name: z.string().optional(),
      key_query: z.string().min(1),
      value_query: z.string().optional(),
      case_sensitive: z.boolean().default(false),
      max_results: z.number().int().min(1).max(200).default(30),
    },
    async ({
      scope,
      plugin_name,
      key_query,
      value_query,
      case_sensitive,
      max_results,
    }) => {
      let snapshot: unknown;
      if (scope === "core") {
        snapshot = await runtime.gateway.request("GET", "/configs/core");
      } else {
        if (!plugin_name) {
          throw new Error("plugin_name is required when scope is plugin.");
        }
        snapshot = await runtime.gateway.request(
          "GET",
          `/configs/plugins/${encodeSegment(plugin_name)}`,
        );
      }
      const sanitized = redactSensitiveData(snapshot);
      return {
        scope,
        plugin_name: plugin_name ?? null,
        results: searchObject(sanitized, {
          keyQuery: key_query,
          valueQuery: value_query ?? null,
          caseSensitive: case_sensitive,
          maxResults: max_results,
        }),
      };
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "patch_core_config",
      summary: "Patch one core config path and hot-reload.",
      category: "configs",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["update-core-config"],
    },
    {
      path: z.string().min(1),
      value: z.unknown(),
      create_missing: z.boolean().default(true),
    },
    async ({ path, value, create_missing }) =>
      runtime.gateway.request("PATCH", "/configs/core", {
        body: { path, value, create_missing },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "patch_plugin_config",
      summary: "Patch one plugin config path and hot-reload that plugin.",
      category: "configs",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["update-plugin-config"],
    },
    {
      plugin_name: z.string().min(1),
      path: z.string().min(1),
      value: z.unknown(),
      create_missing: z.boolean().default(true),
    },
    async ({ plugin_name, path, value, create_missing }) =>
      runtime.gateway.request("PATCH", `/configs/plugins/${encodeSegment(plugin_name)}`, {
        body: { path, value, create_missing },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_plugins",
      summary: "List plugin metadata and activation state.",
      category: "plugins",
      minMode: "readonly",
      risk: "read",
      aliases: ["plugins", "plugin-list"],
    },
    {},
    async () => runtime.gateway.request("GET", "/plugins"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_plugin_details",
      summary: "Get one plugin details and config snapshot (if available).",
      category: "plugins",
      minMode: "readonly",
      risk: "read",
      aliases: ["plugin-detail"],
    },
    {
      plugin_name: z.string().min(1),
    },
    async ({ plugin_name }) =>
      runtime.gateway.request("GET", `/plugins/${encodeSegment(plugin_name)}`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "install_plugin",
      summary: "Install plugin from repo URL or local zip path.",
      category: "plugins",
      minMode: "full",
      risk: "destructive",
      aliases: ["plugin-install"],
    },
    {
      source: z.string().min(1),
      source_type: z.enum(["auto", "repo", "zip"]).default("auto"),
      proxy: z.string().optional(),
    },
    async ({ source, source_type, proxy }) => {
      const looksLikeRepo = /^https?:\/\//i.test(source) || source.endsWith(".git");
      const type = source_type === "auto" ? (looksLikeRepo ? "repo" : "zip") : source_type;

      if (type === "repo") {
        return runtime.gateway.request("POST", "/plugins/install/repo", {
          body: { repo_url: source, proxy: proxy ?? "" },
        });
      }

      if (existsSync(source)) {
        return runtime.gateway.uploadFile("/plugins/install/upload", source);
      }

      return runtime.gateway.request("POST", "/plugins/install/zip", {
        body: { zip_file_path: source },
      });
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "enable_plugin",
      summary: "Enable one plugin.",
      category: "plugins",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["plugin-on"],
    },
    {
      plugin_name: z.string().min(1),
    },
    async ({ plugin_name }) =>
      runtime.gateway.request("POST", `/plugins/${encodeSegment(plugin_name)}/enable`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "disable_plugin",
      summary: "Disable one plugin.",
      category: "plugins",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["plugin-off"],
    },
    {
      plugin_name: z.string().min(1),
    },
    async ({ plugin_name }) =>
      runtime.gateway.request("POST", `/plugins/${encodeSegment(plugin_name)}/disable`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "reload_plugin",
      summary: "Reload one plugin.",
      category: "plugins",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["plugin-reload"],
    },
    {
      plugin_name: z.string().min(1),
    },
    async ({ plugin_name }) =>
      runtime.gateway.request("POST", `/plugins/${encodeSegment(plugin_name)}/reload`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "update_plugin",
      summary: "Update one plugin from its source.",
      category: "plugins",
      minMode: "full",
      risk: "destructive",
      aliases: ["plugin-update"],
    },
    {
      plugin_name: z.string().min(1),
      proxy: z.string().optional(),
    },
    async ({ plugin_name, proxy }) =>
      runtime.gateway.request("POST", `/plugins/${encodeSegment(plugin_name)}/update`, {
        body: { proxy: proxy ?? "" },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "uninstall_plugin",
      summary: "Uninstall one plugin, optionally deleting config/data.",
      category: "plugins",
      minMode: "full",
      risk: "destructive",
      aliases: ["plugin-uninstall", "remove-plugin"],
    },
    {
      plugin_name: z.string().min(1),
      delete_config: z.boolean().default(false),
      delete_data: z.boolean().default(false),
    },
    async ({ plugin_name, delete_config, delete_data }) =>
      runtime.gateway.request("DELETE", `/plugins/${encodeSegment(plugin_name)}`, {
        body: { delete_config, delete_data },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_internal_tools",
      summary: "List AstrBot internal LLM tools.",
      category: "astrbot_tools",
      minMode: "readonly",
      risk: "read",
      aliases: ["tools"],
    },
    {},
    async () => runtime.gateway.request("GET", "/tools"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_internal_tool_details",
      summary: "Get one AstrBot internal tool details.",
      category: "astrbot_tools",
      minMode: "readonly",
      risk: "read",
      aliases: ["tool-detail"],
    },
    {
      tool_name: z.string().min(1),
    },
    async ({ tool_name }) =>
      runtime.gateway.request("GET", `/tools/${encodeSegment(tool_name)}`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "invoke_internal_tool",
      summary: "Invoke one AstrBot internal tool with arguments.",
      category: "astrbot_tools",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["call-tool", "invoke-tool"],
    },
    {
      tool_name: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).default({}),
      message: z.string().optional(),
      sender_id: z.string().default("mcp"),
      conversation_id: z.string().optional(),
      ensure_webui_session: z.boolean().default(false),
      persist_history: z.boolean().default(false),
      capture_messages: z.boolean().default(true),
      response_timeout_seconds: z.number().min(0.1).max(600).default(3),
    },
    async ({
      tool_name,
      arguments: args,
      message,
      sender_id,
      conversation_id,
      ensure_webui_session,
      persist_history,
      capture_messages,
      response_timeout_seconds,
    }) =>
      runtime.gateway.request("POST", `/tools/${encodeSegment(tool_name)}/invoke`, {
        body: {
          arguments: args,
          message,
          sender_id,
          conversation_id,
          ensure_webui_session,
          persist_history,
          capture_messages,
          response_timeout_seconds,
        },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_mcp_servers",
      summary: "List MCP server configs in AstrBot.",
      category: "mcp_servers",
      minMode: "readonly",
      risk: "read",
      aliases: ["mcp-list"],
    },
    {},
    async () => runtime.gateway.request("GET", "/tools/mcp/servers"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "register_mcp_server",
      summary: "Register one MCP server config in AstrBot.",
      category: "mcp_servers",
      minMode: "full",
      risk: "destructive",
      aliases: ["mcp-add"],
    },
    {
      name: z.string().min(1),
      active: z.boolean().default(true),
      config: z.record(z.string(), z.unknown()),
    },
    async ({ name, active, config }) =>
      runtime.gateway.request("POST", "/tools/mcp/servers", {
        body: { name, active, config },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "update_mcp_server",
      summary: "Update or rename one MCP server config.",
      category: "mcp_servers",
      minMode: "full",
      risk: "destructive",
      aliases: ["mcp-update"],
    },
    {
      server_name: z.string().min(1),
      name: z.string().optional(),
      oldName: z.string().optional(),
      active: z.boolean().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ server_name, name, oldName, active, config }) =>
      runtime.gateway.request("PUT", `/tools/mcp/servers/${encodeSegment(server_name)}`, {
        body: { name, oldName, active, config },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "uninstall_mcp_server",
      summary: "Delete one MCP server config.",
      category: "mcp_servers",
      minMode: "full",
      risk: "destructive",
      aliases: ["mcp-delete", "mcp-uninstall"],
    },
    {
      server_name: z.string().min(1),
    },
    async ({ server_name }) =>
      runtime.gateway.request("DELETE", `/tools/mcp/servers/${encodeSegment(server_name)}`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "test_mcp_server",
      summary: "Test one MCP server config payload.",
      category: "mcp_servers",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["mcp-test"],
    },
    {
      mcp_server_config: z.record(z.string(), z.unknown()),
    },
    async ({ mcp_server_config }) =>
      runtime.gateway.request("POST", "/tools/mcp/test", {
        body: { mcp_server_config },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_personas",
      summary: "List personas.",
      category: "personas",
      minMode: "readonly",
      risk: "read",
      aliases: ["persona-list"],
    },
    {},
    async () => runtime.gateway.request("GET", "/personas"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_persona_details",
      summary: "Get one persona details.",
      category: "personas",
      minMode: "readonly",
      risk: "read",
      aliases: ["persona-detail"],
    },
    {
      persona_id: z.string().min(1),
    },
    async ({ persona_id }) =>
      runtime.gateway.request("GET", `/personas/${encodeSegment(persona_id)}`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "upsert_persona",
      summary: "Create or update a persona.",
      category: "personas",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["persona-upsert", "persona-update"],
    },
    {
      action: z.enum(["auto", "create", "update"]).default("auto"),
      persona_id: z.string().min(1),
      system_prompt: z.string().optional(),
      begin_dialogs: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
      skills: z.array(z.string()).optional(),
      folder_id: z.string().nullable().optional(),
      sort_order: z.number().int().optional(),
    },
    async ({
      action,
      persona_id,
      system_prompt,
      begin_dialogs,
      tools,
      skills,
      folder_id,
      sort_order,
    }) => {
      const payload = {
        system_prompt,
        begin_dialogs,
        tools,
        skills,
        folder_id,
        sort_order,
      };

      if (action === "create") {
        if (!system_prompt) {
          throw new Error("system_prompt is required for create action.");
        }
        return runtime.gateway.request("POST", "/personas", {
          body: {
            persona_id,
            system_prompt,
            begin_dialogs,
            tools,
            skills,
            folder_id,
            sort_order,
          },
        });
      }

      if (action === "update") {
        return runtime.gateway.request("PATCH", `/personas/${encodeSegment(persona_id)}`, {
          body: payload,
        });
      }

      try {
        await runtime.gateway.request("GET", `/personas/${encodeSegment(persona_id)}`);
        return runtime.gateway.request("PATCH", `/personas/${encodeSegment(persona_id)}`, {
          body: payload,
        });
      } catch {
        if (!system_prompt) {
          throw new Error("system_prompt is required when persona does not exist.");
        }
        return runtime.gateway.request("POST", "/personas", {
          body: {
            persona_id,
            system_prompt,
            begin_dialogs,
            tools,
            skills,
            folder_id,
            sort_order,
          },
        });
      }
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "delete_persona",
      summary: "Delete one persona.",
      category: "personas",
      minMode: "full",
      risk: "destructive",
      aliases: ["persona-delete"],
    },
    {
      persona_id: z.string().min(1),
    },
    async ({ persona_id }) =>
      runtime.gateway.request("DELETE", `/personas/${encodeSegment(persona_id)}`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_skills",
      summary: "List installed skills.",
      category: "skills",
      minMode: "readonly",
      risk: "read",
      aliases: ["skill-list"],
    },
    {},
    async () => runtime.gateway.request("GET", "/skills"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "install_skill",
      summary: "Install skill from local zip file.",
      category: "skills",
      minMode: "full",
      risk: "destructive",
      aliases: ["skill-install"],
    },
    {
      zip_path: z.string().min(1),
    },
    async ({ zip_path }) => {
      if (!existsSync(zip_path)) {
        throw new Error(`Skill zip not found: ${zip_path}`);
      }
      return runtime.gateway.uploadFile("/skills/upload", zip_path);
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "toggle_skill",
      summary: "Enable or disable one skill.",
      category: "skills",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["skill-toggle"],
    },
    {
      skill_name: z.string().min(1),
      active: z.boolean(),
    },
    async ({ skill_name, active }) =>
      runtime.gateway.request("POST", `/skills/${encodeSegment(skill_name)}/toggle`, {
        body: { active },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "delete_skill",
      summary: "Delete one installed skill.",
      category: "skills",
      minMode: "full",
      risk: "destructive",
      aliases: ["skill-delete"],
    },
    {
      skill_name: z.string().min(1),
    },
    async ({ skill_name }) =>
      runtime.gateway.request("DELETE", `/skills/${encodeSegment(skill_name)}`),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_subagents",
      summary: "List configured subagents.",
      category: "subagents",
      minMode: "readonly",
      risk: "read",
      aliases: ["subagent-list"],
    },
    {},
    async () => runtime.gateway.request("GET", "/subagents"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "inspect_subagent_config",
      summary: "Get subagent orchestrator config.",
      category: "subagents",
      minMode: "readonly",
      risk: "read",
      aliases: ["subagent-config"],
    },
    {},
    async () => runtime.gateway.request("GET", "/subagents/config"),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "update_subagent_config",
      summary: "Update subagent orchestrator config.",
      category: "subagents",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["subagent-update"],
    },
    {
      config: z.record(z.string(), z.unknown()),
    },
    async ({ config }) =>
      runtime.gateway.request("PUT", "/subagents/config", {
        body: { config },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_cron_jobs",
      summary: "List cron jobs.",
      category: "cron",
      minMode: "readonly",
      risk: "read",
      aliases: ["cron-list"],
    },
    {
      job_type: z.string().optional(),
    },
    async ({ job_type }) =>
      runtime.gateway.request("GET", "/cron/jobs", {
        query: { job_type },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "upsert_cron_job",
      summary: "Create or update one cron job.",
      category: "cron",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["cron-upsert", "cron-update"],
    },
    {
      action: z.enum(["create", "update"]).default("create"),
      job_id: z.string().optional(),
      name: z.string().optional(),
      session: z.string().optional(),
      note: z.string().optional(),
      cron_expression: z.string().optional(),
      description: z.string().optional(),
      timezone: z.string().optional(),
      enabled: z.boolean().optional(),
      persistent: z.boolean().optional(),
      run_once: z.boolean().optional(),
      run_at: z.string().optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
      status: z.string().optional(),
      last_error: z.string().optional(),
      next_run_time: z.string().optional(),
    },
    async (args) => {
      if (args.action === "create") {
        if (!args.name || !args.session) {
          throw new Error("name and session are required when action=create.");
        }
        return runtime.gateway.request("POST", "/cron/jobs", {
          body: {
            name: args.name,
            session: args.session,
            note: args.note,
            cron_expression: args.cron_expression,
            description: args.description,
            timezone: args.timezone,
            enabled: args.enabled ?? true,
            persistent: args.persistent ?? true,
            run_once: args.run_once ?? false,
            run_at: args.run_at,
          },
        });
      }
      if (!args.job_id) {
        throw new Error("job_id is required when action=update.");
      }
      return runtime.gateway.request("PATCH", `/cron/jobs/${encodeSegment(args.job_id)}`, {
        body: {
          name: args.name,
          description: args.description,
          cron_expression: args.cron_expression,
          timezone: args.timezone,
          payload: args.payload,
          enabled: args.enabled,
          persistent: args.persistent,
          run_once: args.run_once,
          status: args.status,
          last_error: args.last_error,
          next_run_time: args.next_run_time,
        },
      });
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "delete_cron_job",
      summary: "Delete one cron job.",
      category: "cron",
      minMode: "full",
      risk: "destructive",
      aliases: ["cron-delete"],
    },
    {
      job_id: z.string().min(1),
    },
    async ({ job_id }) =>
      runtime.gateway.request("DELETE", `/cron/jobs/${encodeSegment(job_id)}`),
  );

  registerDiscoveryTools(registrar);

  return registrar.catalog;
}

