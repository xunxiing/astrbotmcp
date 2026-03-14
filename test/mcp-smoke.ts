import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type CapabilityMode = "search" | "readonly" | "minimize" | "full";

type TestStatus = "pass" | "fail" | "skip";

interface TestResult {
  tool: string;
  status: TestStatus;
  durationMs: number;
  detail?: string;
}

interface ToolCallErrorPayload {
  type?: string;
  message?: string;
  statusCode?: number;
  details?: unknown;
}

interface ToolCallError extends Error {
  payload?: ToolCallErrorPayload;
}

interface SessionOptions {
  capabilityMode?: CapabilityMode;
  enableSearchTools?: boolean;
}

interface SmokeContext {
  toolNames: string[];
  platformId?: string;
  providerId?: string;
  pluginSelf: string;
  tempPluginName?: string;
  tempPluginZipPath?: string;
  pluginFullConfig?: Record<string, unknown>;
  pluginEnableDocs?: boolean;
  coreLogFileEnable?: boolean;
  internalToolName?: string;
  personaId?: string;
  activeSkillName?: string;
  inactiveSkillName?: string;
  recentSession?: string;
  subagentConfig?: Record<string, unknown>;
  tempMcpServerName?: string;
  tempMcpServerConfig?: Record<string, unknown>;
  tempPersonaId?: string;
  tempSkillName?: string;
  tempSkillZipPath?: string;
  tempCronJobId?: string;
  triggerConversationId?: string;
  triggerEventId?: string;
  triggerReply?: string | null;
}

class McpSession {
  readonly options: SessionOptions;
  readonly env: Record<string, string>;
  readonly transport: StdioClientTransport;
  readonly client: Client;

  constructor(options: SessionOptions = {}) {
    this.options = options;
    this.env = {
      ASTRBOT_GATEWAY_URL: process.env.ASTRBOT_GATEWAY_URL ?? "http://127.0.0.1:6324",
      ASTRBOT_GATEWAY_TOKEN: process.env.ASTRBOT_GATEWAY_TOKEN ?? "iaushdqwuikdwq78ui",
      ASTRBOT_CAPABILITY_MODE: options.capabilityMode ?? "full",
      ASTRBOT_ENABLE_SEARCH_TOOLS: String(options.enableSearchTools ?? false),
    };
    this.transport = new StdioClientTransport({
      command: "node",
      args: ["dist/src/index.js"],
      cwd: process.cwd(),
      env: this.env,
      stderr: "pipe",
    });
    this.client = new Client({ name: "mcp-smoke", version: "0.0.0" });
  }

  async connect() {
    if (this.transport.stderr) {
      this.transport.stderr.on("data", (chunk) => {
        process.stderr.write(String(chunk));
      });
    }
    await this.client.connect(this.transport);
  }

  async close() {
    await this.transport.close();
  }

  async listTools(): Promise<string[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => tool.name);
  }

  async call(tool: string, args: Record<string, unknown> = {}) {
    const result = await this.client.callTool({ name: tool, arguments: args });
    const content = Array.isArray(result.content)
      ? (result.content as Array<Record<string, unknown>>)
      : [];
    const textEntry = content.find(
      (entry) => entry.type === "text" && typeof entry.text === "string",
    );
    const text = typeof textEntry?.text === "string" ? textEntry.text : "";
    const parsed = parseToolText(text);
    if (isToolError(parsed)) {
      const error = new Error(parsed.error.message ?? `Tool ${tool} failed.`) as ToolCallError;
      error.payload = parsed.error;
      throw error;
    }
    return parsed;
  }
}

function parseToolText(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isToolError(value: unknown): value is { ok: false; error: ToolCallErrorPayload } {
  return isRecord(value) && value.ok === false && isRecord(value.error);
}

function asArray<T = Record<string, unknown>>(value: unknown, key?: string): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (key && isRecord(value) && Array.isArray(value[key])) {
    return value[key] as T[];
  }
  return [];
}

function getString(value: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }
  return undefined;
}

function getBoolean(value: unknown, ...keys: string[]): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }
  return undefined;
}

async function runCase(
  results: TestResult[],
  tool: string,
  fn: () => Promise<void>,
  options: { allowSkip?: boolean } = {},
) {
  const startedAt = Date.now();
  try {
    await fn();
    results.push({ tool, status: "pass", durationMs: Date.now() - startedAt });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (options.allowSkip && /^SKIP:/.test(detail)) {
      results.push({
        tool,
        status: "skip",
        durationMs: Date.now() - startedAt,
        detail: detail.replace(/^SKIP:\s*/, ""),
      });
      return;
    }
    results.push({ tool, status: "fail", durationMs: Date.now() - startedAt, detail });
  }
}

function skip(reason: string): never {
  throw new Error(`SKIP: ${reason}`);
}

async function withSession<T>(options: SessionOptions, fn: (session: McpSession) => Promise<T>) {
  const session = new McpSession(options);
  await session.connect();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function buildTempSkillZip(targetDir: string, skillName: string) {
  const skillRoot = join(targetDir, skillName);
  await rm(skillRoot, { recursive: true, force: true });
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Temporary MCP smoke-test skill.\n---\n\n# ${skillName}\n\nTemporary smoke-test skill.\n`,
    "utf8",
  );

  const zipPath = join(targetDir, `${skillName}.zip`);
  if (existsSync(zipPath)) {
    await rm(zipPath, { force: true });
  }

  const escapedSource = skillRoot.replace(/'/g, "''");
  const escapedZipPath = zipPath.replace(/'/g, "''");
  const script = [
    `$source = '${escapedSource}'`,
    `$destination = '${escapedZipPath}'`,
    "if (Test-Path $destination) { Remove-Item -Force $destination }",
    "Compress-Archive -Path $source -DestinationPath $destination -Force",
  ].join("; ");
  const zipCommand = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (zipCommand.status !== 0) {
    throw new Error(zipCommand.stderr || "Failed to build temporary skill zip.");
  }
  return zipPath;
}

async function buildTempPluginZip(targetDir: string, pluginName: string) {
  const pluginRoot = join(targetDir, pluginName);
  await rm(pluginRoot, { recursive: true, force: true });
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "metadata.yaml"),
    [
      `name: ${pluginName}`,
      "desc: Temporary MCP smoke-test plugin.",
      "version: v0.0.1",
      "author: Codex",
      `repo: https://example.com/${pluginName}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(pluginRoot, "main.py"),
    [
      "from astrbot.api.star import Context, Star, register",
      "from astrbot.core import AstrBotConfig",
      "",
      `@register("${pluginName}", "Codex", "Temporary MCP smoke-test plugin.", "0.0.1")`,
      "class TempInstallPlugin(Star):",
      "    def __init__(self, context: Context, config: AstrBotConfig):",
      "        super().__init__(context)",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(pluginRoot, "_conf_schema.json"), "{}", "utf8");

  const zipPath = join(targetDir, `${pluginName}.zip`);
  if (existsSync(zipPath)) {
    await rm(zipPath, { force: true });
  }

  const escapedPluginRoot = pluginRoot.replace(/'/g, "''");
  const escapedZipPath = zipPath.replace(/'/g, "''");
  const escapedPluginName = pluginName.replace(/'/g, "''");
  const zipScript = [
    "import pathlib, sys, zipfile",
    `plugin_root = pathlib.Path(r'''${escapedPluginRoot}''')`,
    `zip_path = pathlib.Path(r'''${escapedZipPath}''')`,
    `plugin_name = r'''${escapedPluginName}'''`,
    "with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:",
    "    zf.writestr(f'{plugin_name}/', '')",
    "    for name in ('metadata.yaml', 'main.py', '_conf_schema.json'):",
    "        zf.write(plugin_root / name, arcname=f'{plugin_name}/{name}')",
  ].join("\n");
  const zipCommand = spawnSync("python", ["-c", zipScript], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (zipCommand.status !== 0) {
    throw new Error(zipCommand.stderr || "Failed to build temporary plugin zip.");
  }
  return zipPath;
}

async function verifyCapabilityModes(results: TestResult[]) {
  await runCase(results, "mode:search", async () => {
    await withSession({ capabilityMode: "search", enableSearchTools: true }, async (session) => {
      const toolNames = await session.listTools();
      assert.deepEqual(toolNames.sort(), ["describe_runtime_capabilities", "search_tools"]);
      const search = await session.call("search_tools", { query: "logs", top_k: 5 });
      assert.equal(getString(search, "query"), "logs");
    });
  });

  await runCase(results, "mode:readonly", async () => {
    await withSession({ capabilityMode: "readonly" }, async (session) => {
      const toolNames = await session.listTools();
      assert(toolNames.includes("get_system_summary"));
      assert(toolNames.includes("get_message_history"));
      assert(!toolNames.includes("patch_core_config"));
      assert(!toolNames.includes("trigger_message_reply"));
      assert(!toolNames.includes("restart_astrbot"));
    });
  });

  await runCase(results, "mode:minimize", async () => {
    await withSession({ capabilityMode: "minimize" }, async (session) => {
      const toolNames = await session.listTools();
      assert(toolNames.includes("patch_core_config"));
      assert(toolNames.includes("invoke_internal_tool"));
      assert(!toolNames.includes("install_plugin"));
      assert(!toolNames.includes("restart_astrbot"));
    });
  });

  await runCase(results, "mode:full", async () => {
    await withSession({ capabilityMode: "full" }, async (session) => {
      const toolNames = await session.listTools();
      assert(toolNames.includes("install_plugin"));
      assert(toolNames.includes("restart_astrbot"));
      assert(!toolNames.includes("search_tools"));
    });
  });
}

async function main() {
  const results: TestResult[] = [];
  const context: SmokeContext = {
    toolNames: [],
    pluginSelf: "astrbot_plugin_mcp_tools",
  };

  await mkdir(resolve(".tmp-smoke"), { recursive: true });
  const tempRootName = `astrbot-mcp-smoke-${Date.now()}`;
  const preferredTempRoot = join(tmpdir(), tempRootName);
  const tempRoot = await mkdir(preferredTempRoot, { recursive: true })
    .then(() => preferredTempRoot)
    .catch(() => resolve(".tmp-smoke"));

  try {
    await verifyCapabilityModes(results);

    await withSession({ capabilityMode: "full" }, async (session) => {
      context.toolNames = await session.listTools();
      assert(context.toolNames.length >= 50);

      await runCase(results, "describe_runtime_capabilities", async () => {
        const payload = await session.call("describe_runtime_capabilities");
        assert.equal(getString(payload, "capability_mode"), "full");
      });

      await runCase(results, "get_system_summary", async () => {
        const payload = await session.call("get_system_summary");
        assert.equal(getString(payload, "capability_mode"), "full");
      });

      await runCase(results, "get_compact_logs", async () => {
        const payload = await session.call("get_compact_logs", { max_entries: 3 });
        assert(Array.isArray((payload as Record<string, unknown>)?.logs));
      });

      await runCase(results, "list_platforms", async () => {
        const payload = await session.call("list_platforms");
        const items = asArray<Record<string, unknown>>(payload);
        assert(items.length > 0);
        context.platformId = getString(items[0], "id");
      });

      await runCase(results, "get_platform_stats", async () => {
        await session.call("get_platform_stats");
      });

      await runCase(results, "get_platform_details", async () => {
        if (!context.platformId) {
          skip("no platform available");
        }
        const payload = await session.call("get_platform_details", { platform_id: context.platformId });
        assert.equal(getString(payload, "id"), context.platformId);
      }, { allowSkip: true });

      await runCase(results, "list_providers", async () => {
        const payload = await session.call("list_providers");
        const items = asArray<Record<string, unknown>>(payload);
        assert(items.length > 0);
        context.providerId = getString(items[0], "provider_id", "id");
      });

      await runCase(results, "get_current_provider", async () => {
        const payload = await session.call("get_current_provider");
        const currentChat = isRecord(payload) ? payload.chat : null;
        const currentProviderId = getString(currentChat, "id", "provider_id");
        if (currentProviderId) {
          context.providerId = currentProviderId;
        }
      });

      await runCase(results, "get_provider_details", async () => {
        if (!context.providerId) {
          skip("no provider available");
        }
        const payload = await session.call("get_provider_details", { provider_id: context.providerId });
        const resolvedProviderId = getString(payload, "provider_id", "id");
        assert(resolvedProviderId);
        if (!context.providerId.includes("/")) {
          assert.equal(resolvedProviderId, context.providerId);
        }
      }, { allowSkip: true });

      await runCase(results, "inspect_core_config", async () => {
        const payload = await session.call("inspect_core_config", { path: "log_file_enable" });
        context.coreLogFileEnable = getBoolean(payload, "value");
        assert.equal(typeof context.coreLogFileEnable, "boolean");
      });

      await runCase(results, "inspect_plugin_config", async () => {
        const payload = await session.call("inspect_plugin_config", {
          plugin_name: context.pluginSelf,
          path: "enable_docs",
        });
        context.pluginEnableDocs = getBoolean(payload, "value");
        assert.equal(typeof context.pluginEnableDocs, "boolean");
      });

      await runCase(results, "get_plugin_config_file", async () => {
        const payload = await session.call("get_plugin_config_file", {
          plugin_name: context.pluginSelf,
        });
        const config = isRecord(payload) && isRecord(payload.config) ? payload.config : null;
        context.pluginFullConfig = config ?? undefined;
        assert(config);
      });

      await runCase(results, "search_config", async () => {
        const payload = await session.call("search_config", {
          scope: "core",
          key_query: "provider",
          max_results: 5,
        });
        const resultsList = asArray<Record<string, unknown>>(payload, "results");
        assert(resultsList.length > 0);
      });

      await runCase(results, "patch_core_config", async () => {
        if (typeof context.coreLogFileEnable !== "boolean") {
          skip("core config snapshot unavailable");
        }
        await session.call("patch_core_config", {
          path: "log_file_enable",
          value: context.coreLogFileEnable,
          create_missing: true,
        });
      }, { allowSkip: true });

      await runCase(results, "patch_plugin_config", async () => {
        if (typeof context.pluginEnableDocs !== "boolean") {
          skip("plugin config snapshot unavailable");
        }
        await session.call("patch_plugin_config", {
          plugin_name: context.pluginSelf,
          path: "enable_docs",
          value: context.pluginEnableDocs,
          create_missing: true,
        });
      }, { allowSkip: true });

      await runCase(results, "replace_plugin_config_file", async () => {
        if (!context.pluginFullConfig) {
          skip("plugin full config unavailable");
        }
        const payload = await session.call("replace_plugin_config_file", {
          plugin_name: context.pluginSelf,
          config: context.pluginFullConfig,
        });
        assert.equal(getString(payload, "plugin"), context.pluginSelf);
      }, { allowSkip: true });

      await runCase(results, "list_plugins", async () => {
        const payload = await session.call("list_plugins");
        const items = asArray<Record<string, unknown>>(payload, "items");
        assert(items.length > 0);
      });

      await runCase(results, "get_plugin_details", async () => {
        const payload = await session.call("get_plugin_details", { plugin_name: context.pluginSelf });
        assert.equal(getString(payload, "name"), context.pluginSelf);
      });

      await runCase(results, "install_plugin", async () => {
        context.tempPluginName = `astrbot_plugin_mcp_smoke_${Date.now()}`;
        context.tempPluginZipPath = await buildTempPluginZip(tempRoot, context.tempPluginName);
        const payload = await session.call("install_plugin", {
          source: context.tempPluginZipPath,
          source_type: "zip",
        });
        assert.equal(getString(payload, "name"), context.tempPluginName);
      });

      await runCase(results, "set_plugin_enabled", async () => {
        if (!context.tempPluginName) {
          skip("temporary plugin not installed");
        }
        const disabled = await session.call("set_plugin_enabled", {
          plugin_name: context.tempPluginName,
          enabled: false,
        });
        assert.equal(getString(disabled, "plugin"), context.tempPluginName);
        assert.equal(getBoolean(disabled, "enabled"), false);

        const enabled = await session.call("set_plugin_enabled", {
          plugin_name: context.tempPluginName,
          enabled: true,
        });
        assert.equal(getString(enabled, "plugin"), context.tempPluginName);
        assert.equal(getBoolean(enabled, "enabled"), true);
      }, { allowSkip: true });

      await runCase(results, "reload_plugin", async () => {
        const payload = await session.call("reload_plugin", { plugin_name: context.pluginSelf });
        assert.equal(getString(payload, "plugin"), context.pluginSelf);
      });

      await runCase(results, "update_plugin", async () => {
        skip("not exercised: updates remote plugin source and is not safely reversible here");
      }, { allowSkip: true });

      await runCase(results, "uninstall_plugin", async () => {
        if (!context.tempPluginName) {
          skip("temporary plugin not installed");
        }
        const payload = await session.call("uninstall_plugin", {
          plugin_name: context.tempPluginName,
          delete_config: true,
          delete_data: true,
        });
        assert.equal(getString(payload, "plugin"), context.tempPluginName);
      }, { allowSkip: true });

      await runCase(results, "list_internal_tools", async () => {
        const payload = await session.call("list_internal_tools");
        const items = asArray<Record<string, unknown>>(payload);
        assert(items.length > 0);
        context.internalToolName =
          getString(items.find((item) => getString(item, "name") === "md_doc_create"), "name") ??
          getString(items[0], "name");
      });

      await runCase(results, "list_astrbot_tools", async () => {
        const payload = await session.call("list_astrbot_tools");
        const items = asArray<Record<string, unknown>>(payload);
        assert(items.length > 0);
      });

      await runCase(results, "get_internal_tool_details", async () => {
        if (!context.internalToolName) {
          skip("no internal tool available");
        }
        const payload = await session.call("get_internal_tool_details", {
          tool_name: context.internalToolName,
        });
        assert.equal(getString(payload, "name"), context.internalToolName);
      }, { allowSkip: true });

      await runCase(results, "invoke_internal_tool", async () => {
        const payload = await session.call("invoke_internal_tool", {
          tool_name: "md_doc_create",
          arguments: { markdown: "# smoke" },
          capture_messages: false,
          persist_history: false,
        });
        assert(isRecord(payload));
        assert.equal(getString(payload, "tool_name"), "md_doc_create");
      });

      await runCase(results, "list_mcp_servers", async () => {
        const payload = await session.call("list_mcp_servers");
        const items = asArray<Record<string, unknown>>(payload);
        assert(items.length > 0);
        context.tempMcpServerName = `astrbot-mcp-smoke-${Date.now()}`;
        context.tempMcpServerConfig = {
          command: "node",
          args: [resolve("dist/src/index.js")],
          env: {
            ASTRBOT_GATEWAY_URL: process.env.ASTRBOT_GATEWAY_URL ?? "http://127.0.0.1:6324",
            ASTRBOT_GATEWAY_TOKEN: process.env.ASTRBOT_GATEWAY_TOKEN ?? "iaushdqwuikdwq78ui",
          },
        };
      });

      await runCase(results, "register_mcp_server", async () => {
        if (!context.tempMcpServerName || !context.tempMcpServerConfig) {
          skip("temporary MCP config unavailable");
        }
        await session.call("register_mcp_server", {
          name: context.tempMcpServerName,
          active: false,
          config: context.tempMcpServerConfig,
        });
      }, { allowSkip: true });

      await runCase(results, "update_mcp_server", async () => {
        if (!context.tempMcpServerName || !context.tempMcpServerConfig) {
          skip("temporary MCP server not registered");
        }
        await session.call("update_mcp_server", {
          server_name: context.tempMcpServerName,
          active: false,
          config: context.tempMcpServerConfig,
        });
      }, { allowSkip: true });

      await runCase(results, "test_mcp_server", async () => {
        if (!context.tempMcpServerConfig) {
          skip("temporary MCP config unavailable");
        }
        await session.call("test_mcp_server", {
          mcp_server_config: context.tempMcpServerConfig,
        });
      }, { allowSkip: true });

      await runCase(results, "uninstall_mcp_server", async () => {
        if (!context.tempMcpServerName) {
          skip("temporary MCP server not registered");
        }
        await session.call("uninstall_mcp_server", {
          server_name: context.tempMcpServerName,
        });
      }, { allowSkip: true });

      await runCase(results, "list_personas", async () => {
        const payload = await session.call("list_personas");
        const items = asArray<Record<string, unknown>>(payload);
        assert(items.length > 0);
        context.personaId = getString(items[0], "persona_id");
      });

      await runCase(results, "get_persona_details", async () => {
        if (!context.personaId) {
          skip("no persona available");
        }
        const payload = await session.call("get_persona_details", {
          persona_id: context.personaId,
        });
        assert.equal(getString(payload, "persona_id"), context.personaId);
      }, { allowSkip: true });

      await runCase(results, "upsert_persona", async () => {
        context.tempPersonaId = `mcp-smoke-persona-${Date.now()}`;
        const payload = await session.call("upsert_persona", {
          action: "create",
          persona_id: context.tempPersonaId,
          system_prompt: "Temporary persona created by the MCP smoke harness.",
          begin_dialogs: ["hello"],
        });
        assert(isRecord(payload));
      });

      await runCase(results, "delete_persona", async () => {
        if (!context.tempPersonaId) {
          skip("temporary persona not created");
        }
        await session.call("delete_persona", { persona_id: context.tempPersonaId });
      }, { allowSkip: true });

      await runCase(results, "list_skills", async () => {
        const payload = await session.call("list_skills");
        const items = asArray<Record<string, unknown>>(payload, "skills");
        assert(items.length > 0);
        context.activeSkillName =
          getString(items.find((item) => getBoolean(item, "active") === true), "name") ??
          getString(items[0], "name");
        context.inactiveSkillName =
          getString(items.find((item) => getBoolean(item, "active") === false), "name") ??
          context.activeSkillName;
      });

      await runCase(results, "install_skill", async () => {
        const tempSkillName = `mcp-smoke-skill-${Date.now()}`;
        const tempSkillZipPath = await buildTempSkillZip(resolve(".tmp-smoke"), tempSkillName);
        context.tempSkillZipPath = tempSkillZipPath;
        await session.call("install_skill", { zip_path: tempSkillZipPath });
        context.tempSkillName = tempSkillName;
      });

      await runCase(results, "toggle_skill", async () => {
        if (!context.tempSkillName) {
          skip("temporary skill not installed");
        }
        await session.call("toggle_skill", { skill_name: context.tempSkillName, active: false });
        await session.call("toggle_skill", { skill_name: context.tempSkillName, active: true });
      }, { allowSkip: true });

      await runCase(results, "delete_skill", async () => {
        if (!context.tempSkillName) {
          skip("temporary skill not installed");
        }
        await session.call("delete_skill", { skill_name: context.tempSkillName });
      }, { allowSkip: true });

      await runCase(results, "list_subagents", async () => {
        const payload = await session.call("list_subagents");
        const items = asArray<Record<string, unknown>>(payload);
        assert(items.length >= 0);
      });

      await runCase(results, "inspect_subagent_config", async () => {
        const payload = await session.call("inspect_subagent_config");
        assert(isRecord(payload));
        context.subagentConfig = payload as Record<string, unknown>;
      });

      await runCase(results, "update_subagent_config", async () => {
        if (!context.subagentConfig) {
          skip("subagent config unavailable");
        }
        await session.call("update_subagent_config", { config: context.subagentConfig });
      }, { allowSkip: true });

      await runCase(results, "list_cron_jobs", async () => {
        const payload = await session.call("list_cron_jobs");
        const items = asArray<Record<string, unknown>>(payload);
        assert(items.length >= 0);
      });

      await runCase(results, "upsert_cron_job", async () => {
        const sessionTarget = context.recentSession ?? "webchat:FriendMessage:webchat!mcp-test!mcp-smoke";
        const payload = await session.call("upsert_cron_job", {
          action: "create",
          name: `mcp-smoke-cron-${Date.now()}`,
          session: sessionTarget,
          enabled: false,
          persistent: false,
          run_once: false,
          cron_expression: "0 0 1 1 *",
          description: "Temporary cron created by the MCP smoke harness.",
        });
        context.tempCronJobId = getString(payload, "job_id");
        assert(context.tempCronJobId);
      });

      await runCase(results, "delete_cron_job", async () => {
        if (!context.tempCronJobId) {
          skip("temporary cron job not created");
        }
        await session.call("delete_cron_job", { job_id: context.tempCronJobId });
      }, { allowSkip: true });

      await runCase(results, "trigger_message_reply", async () => {
        context.triggerConversationId = `mcp-smoke-${Date.now()}`;
        const payload = await session.call("trigger_message_reply", {
          message: "Please reply with exactly: mcp smoke ok",
          platform_id: "webchat",
          message_type: "FriendMessage",
          sender_id: "mcp-test",
          conversation_id: context.triggerConversationId,
          wait_seconds: 20,
          include_logs: true,
          include_debug: true,
        });
        context.triggerReply = getString(payload, "reply") ?? null;
        const debug = isRecord(payload) ? payload.debug : null;
        context.triggerEventId = getString(debug, "event_id");
        assert(context.triggerReply);
        assert(context.triggerEventId);
      });

      await runCase(results, "get_recent_sessions", async () => {
        const payload = await session.call("get_recent_sessions", { limit: 10 });
        const items = asArray<Record<string, unknown>>(payload);
        assert(items.length > 0);
        context.recentSession =
          getString(
            items.find((item) => getString(item, "plain_text")?.includes("mcp smoke ok")),
            "session",
          ) ??
          getString(items[0], "session");
      });

      await runCase(results, "get_message_history", async () => {
        if (!context.triggerConversationId) {
          skip("message trigger did not run");
        }
        const payload = await session.call("get_message_history", {
          platform_id: "webchat",
          conversation_id: context.triggerConversationId,
          page_size: 10,
        });
        const history = asArray<Record<string, unknown>>(payload, "history");
        assert(history.length >= 1);
      }, { allowSkip: true });

      await runCase(results, "get_logs_by_id", async () => {
        if (!context.triggerEventId) {
          skip("message trigger did not return event id");
        }
        const payload = await session.call("get_logs_by_id", {
          event_id: context.triggerEventId,
          max_entries: 20,
          wait_seconds: 1,
        });
        const logs = asArray<Record<string, unknown>>(payload, "logs");
        assert(logs.length >= 0);
      }, { allowSkip: true });

      await runCase(results, "restart_astrbot", async () => {
        const payload = await session.call("restart_astrbot", {
          max_wait_seconds: 60,
          check_interval_seconds: 2,
          include_status: false,
        });
        assert.equal(getBoolean(payload, "restarted"), true);
      });
    });
  } finally {
    if (context.tempSkillZipPath && existsSync(context.tempSkillZipPath)) {
      await rm(context.tempSkillZipPath, { force: true });
    }
    if (existsSync(tempRoot)) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  const coveredTools = new Set(results.filter((item) => !item.tool.startsWith("mode:")).map((item) => item.tool));
  const missingTools = context.toolNames.filter((tool) => !coveredTools.has(tool));
  const summary = {
    totalTools: context.toolNames.length,
    passed: results.filter((item) => item.status === "pass").length,
    failed: results.filter((item) => item.status === "fail").length,
    skipped: results.filter((item) => item.status === "skip").length,
    missingTools,
    results,
  };

  await writeFile(resolve(".tmp-smoke/mcp-smoke-report.json"), JSON.stringify(summary, null, 2), "utf8");

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed > 0 || missingTools.length > 0) {
    process.exitCode = 1;
  }
}

await main();
