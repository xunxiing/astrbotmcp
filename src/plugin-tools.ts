import * as z from "zod/v4";
import { existsSync } from "node:fs";

import {
  ToolRegistrar,
  encodeSegment,
  withToolErrorBoundary,
} from "./tooling.js";
import { redactSensitiveData } from "./utils.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function compactObject(record: Record<string, unknown>) {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    compacted[key] = value;
  }
  return compacted;
}

function compactCommand(handler: unknown): Record<string, unknown> | null {
  const record = asRecord(handler);
  if (!record || record.type !== "command") {
    return null;
  }
  return compactObject({
    cmd: typeof record.cmd === "string" ? record.cmd : null,
    desc: typeof record.desc === "string" && record.desc !== "no description" ? record.desc : null,
    admin: typeof record.has_admin === "boolean" ? record.has_admin : null,
  });
}

function compactHandler(handler: unknown): Record<string, unknown> | null {
  const record = asRecord(handler);
  if (!record) {
    return null;
  }
  return compactObject({
    type: typeof record.type === "string" ? record.type : null,
    event_type: typeof record.event_type_h === "string" ? record.event_type_h : record.event_type,
    handler_name: typeof record.handler_name === "string" ? record.handler_name : null,
    cmd:
      typeof record.cmd === "string" && record.cmd !== "auto" && record.cmd !== "unknown"
        ? record.cmd
        : null,
    desc: typeof record.desc === "string" && record.desc !== "no description" ? record.desc : null,
    admin: typeof record.has_admin === "boolean" ? record.has_admin : null,
  });
}

export function compactPluginListPayload(payload: unknown) {
  const record = asRecord(payload);
  const items = Array.isArray(record?.items) ? record.items : Array.isArray(payload) ? payload : [];
  const compactedItems = items
    .map((item) => {
      const plugin = asRecord(item);
      if (!plugin) {
        return null;
      }
      const handlers = Array.isArray(plugin.handlers) ? plugin.handlers : [];
      const commands = handlers.map((handler) => compactCommand(handler)).filter(Boolean);
      return compactObject({
        name: typeof plugin.name === "string" ? plugin.name : null,
        display_name:
          typeof plugin.display_name === "string" &&
          plugin.display_name &&
          plugin.display_name !== plugin.name
            ? plugin.display_name
            : null,
        author: typeof plugin.author === "string" ? plugin.author : null,
        desc: typeof plugin.desc === "string" ? plugin.desc : null,
        version: typeof plugin.version === "string" ? plugin.version : null,
        repo: typeof plugin.repo === "string" ? plugin.repo : null,
        activated: Boolean(plugin.activated),
        configurable: Boolean(plugin.has_config),
        reserved: plugin.reserved === true ? true : null,
        command_count: commands.length || null,
        handler_count: handlers.length || null,
      });
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));

  return compactObject({
    items: compactedItems,
    failed_plugin_info:
      typeof record?.failed_plugin_info === "string" ? record.failed_plugin_info.trim() : null,
  });
}

export function compactPluginDetailsPayload(
  payload: unknown,
  options: { includeHandlers?: boolean } = {},
) {
  const record = asRecord(payload);
  if (!record) {
    return payload;
  }

  const handlers = Array.isArray(record.handlers) ? record.handlers : [];
  const commands = handlers.map((handler) => compactCommand(handler)).filter(Boolean);
  const compactedHandlers = options.includeHandlers
    ? handlers.map((handler) => compactHandler(handler)).filter(Boolean)
    : [];

  return compactObject({
    name: typeof record.name === "string" ? record.name : null,
    display_name:
      typeof record.display_name === "string" &&
      record.display_name &&
      record.display_name !== record.name
        ? record.display_name
        : null,
    author: typeof record.author === "string" ? record.author : null,
    desc: typeof record.desc === "string" ? record.desc : null,
    version: typeof record.version === "string" ? record.version : null,
    repo: typeof record.repo === "string" ? record.repo : null,
    activated: typeof record.activated === "boolean" ? record.activated : null,
    configurable: typeof record.has_config === "boolean" ? record.has_config : null,
    reserved: record.reserved === true ? true : null,
    root_dir_name: typeof record.root_dir_name === "string" ? record.root_dir_name : null,
    module_path: typeof record.module_path === "string" ? record.module_path : null,
    command_count: commands.length || null,
    handler_count: handlers.length || null,
    commands,
    handlers: compactedHandlers,
  });
}

export function compactPluginConfigPayload(
  payload: unknown,
  options: { includeSchema?: boolean; redactSecrets?: boolean } = {},
) {
  const record = asRecord(payload);
  if (!record) {
    return payload;
  }
  const configValue =
    options.redactSecrets === false ? record.value : redactSensitiveData(record.value);
  const schemaValue =
    options.includeSchema === true
      ? options.redactSecrets === false
        ? record.schema
        : redactSensitiveData(record.schema)
      : null;

  return compactObject({
    plugin: typeof record.plugin === "string" ? record.plugin : null,
    config: configValue,
    schema: schemaValue,
  });
}

function isLoopbackGateway(gatewayUrl: string): boolean {
  try {
    const parsed = new URL(gatewayUrl);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export function registerPluginTools(registrar: ToolRegistrar) {
  const { runtime } = registrar;

  withToolErrorBoundary(
    registrar,
    {
      name: "inspect_plugin_config",
      summary: "Inspect one plugin config node or schema. Prefer get_plugin_config_file when you want the full editable config object.",
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
      name: "patch_plugin_config",
      summary: "Patch one plugin config path and hot-reload that plugin. Prefer replace_plugin_config_file when editing the full config object.",
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
      name: "get_plugin_config_file",
      summary: "Get the full editable plugin config object. This is the main tool to read a plugin config before replacing it.",
      category: "plugins",
      minMode: "readonly",
      risk: "read",
      aliases: ["plugin-config-file", "plugin-config-full"],
    },
    {
      plugin_name: z.string().min(1),
      include_schema: z.boolean().default(false),
      redact_secrets: z.boolean().default(false),
    },
    async ({ plugin_name, include_schema, redact_secrets }) => {
      const data = await runtime.gateway.request(
        "GET",
        `/configs/plugins/${encodeSegment(plugin_name)}`,
      );
      return compactPluginConfigPayload(data, {
        includeSchema: include_schema,
        redactSecrets: redact_secrets,
      });
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "replace_plugin_config_file",
      summary: "Replace the full plugin config object and reload the plugin.",
      category: "plugins",
      minMode: "full",
      risk: "safe-write",
      aliases: ["plugin-config-replace", "save-plugin-config-file"],
    },
    {
      plugin_name: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
    },
    async ({ plugin_name, config }) => {
      const data = await runtime.gateway.request(
        "PUT",
        `/configs/plugins/${encodeSegment(plugin_name)}/full`,
        { body: { config } },
      );
      const record = asRecord(data);
      return compactObject({
        plugin: typeof record?.plugin === "string" ? record.plugin : plugin_name,
        reloaded: record?.reloaded === true ? true : null,
      });
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_plugins",
      summary: "List plugins in a compact LLM-friendly shape. Use get_plugin_details for one plugin, then get_plugin_config_file to edit its config.",
      category: "plugins",
      minMode: "readonly",
      risk: "read",
      aliases: ["plugins", "plugin-list"],
    },
    {},
    async () => compactPluginListPayload(await runtime.gateway.request("GET", "/plugins")),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_plugin_details",
      summary: "Get one plugin's compact metadata and command list. Config is intentionally separated; use get_plugin_config_file for the editable config object.",
      category: "plugins",
      minMode: "readonly",
      risk: "read",
      aliases: ["plugin-detail"],
    },
    {
      plugin_name: z.string().min(1),
      include_handlers: z.boolean().default(false),
    },
    async ({ plugin_name, include_handlers }) =>
      compactPluginDetailsPayload(
        await runtime.gateway.request("GET", `/plugins/${encodeSegment(plugin_name)}`),
        { includeHandlers: include_handlers },
      ),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "install_plugin",
      summary: "Install plugin from repo URL, gateway-visible zip path, or explicit uploaded zip file.",
      category: "plugins",
      minMode: "full",
      risk: "destructive",
      aliases: ["plugin-install"],
    },
    {
      source: z.string().min(1).describe("Repo URL, gateway-visible zip path, or local zip file path."),
      source_type: z.enum(["auto", "repo", "zip", "upload"]).default("auto").describe("auto: repo URL -> repo install; existing local path on loopback gateway -> zip path install; existing local path on remote gateway -> upload; zip: force gateway path install; upload: force multipart file upload."),
      proxy: z.string().optional(),
    },
    async ({ source, source_type, proxy }) => {
      const looksLikeRepo = /^https?:\/\//i.test(source) || source.endsWith(".git");
      const sourceExists = existsSync(source);
      const type =
        source_type === "auto"
          ? looksLikeRepo
            ? "repo"
            : sourceExists && isLoopbackGateway(runtime.config.gatewayUrl)
              ? "zip"
              : sourceExists
                ? "upload"
                : "zip"
          : source_type;

      if (type === "repo") {
        return runtime.gateway.request("POST", "/plugins/install/repo", {
          body: { repo_url: source, proxy: proxy ?? "" },
        });
      }

      if (type === "upload") {
        if (!sourceExists) {
          throw new Error("local plugin zip file not found for upload install.");
        }
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
      name: "set_plugin_enabled",
      summary: "Set one plugin enabled or disabled.",
      category: "plugins",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["plugin-on", "plugin-off", "enable-plugin", "disable-plugin"],
    },
    {
      plugin_name: z.string().min(1),
      enabled: z.boolean(),
    },
    async ({ plugin_name, enabled }) =>
      runtime.gateway.request(
        "POST",
        `/plugins/${encodeSegment(plugin_name)}/${enabled ? "enable" : "disable"}`,
      ),
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
}
