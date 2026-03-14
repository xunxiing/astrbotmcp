import * as z from "zod/v4";
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerDiscoveryTools } from "./discovery-tools.js";
import { registerMessageTools } from "./message-tools.js";
import { registerPluginTools } from "./plugin-tools.js";
import { registerSystemTools } from "./system-tools.js";
import {
  Runtime,
  ToolCatalogEntry,
  ToolRegistrar,
  categorySummary,
  compactOrRawLogs,
  encodeSegment,
  withToolErrorBoundary,
} from "./tooling.js";
import { compactMessageToolLogs } from "./message-tools.js";
import { richResult } from "./result.js";
import { redactSensitiveData, searchObject } from "./utils.js";

export { categorySummary };
export type { Runtime, ToolCatalogEntry };

const seenInternalToolParameterHints = new Set<string>();

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

function compactToolParameters(parameters: unknown, includeSchema = false) {
  const schema = asRecord(parameters);
  if (!schema) {
    return includeSchema ? parameters : undefined;
  }

  const properties = asRecord(schema.properties);
  const propertyNames = properties ? Object.keys(properties) : [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];

  return compactObject({
    type: typeof schema.type === "string" ? schema.type : null,
    required: required.length > 0 ? required : null,
    parameter_keys: propertyNames.length > 0 ? propertyNames : null,
    parameter_count: propertyNames.length || null,
    schema: includeSchema ? schema : null,
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInternalToolTaskTerminal(status: string | null) {
  return status === "completed" || status === "failed";
}

function extractTextPartsFromResultContent(content: unknown) {
  const items = Array.isArray(content) ? content : [];
  return items
    .map((item) => asRecord(item))
    .map((item) => {
      if (typeof item?.text === "string") {
        return item.text.trim();
      }
      const raw = asRecord(item?.raw);
      return typeof raw?.text === "string" ? raw.text.trim() : "";
    })
    .filter(Boolean);
}

function compactInternalToolLogEntries(
  runtime: Runtime,
  logs: unknown,
  maxEntries: number,
) {
  const items = Array.isArray(logs) ? logs : [];
  return compactMessageToolLogs(compactOrRawLogs(runtime, items, maxEntries));
}

function compactInternalToolMessagePart(part: unknown) {
  const record = asRecord(part);
  if (!record) {
    return part;
  }
  const type = typeof record.type === "string" ? record.type : null;
  return compactObject({
    type,
    text: typeof record.text === "string" ? record.text : null,
    attachment_id:
      typeof record.attachment_id === "string" ? record.attachment_id : null,
    filename: typeof record.filename === "string" ? record.filename : null,
    mime_type: typeof record.mime_type === "string" ? record.mime_type : null,
    size: typeof record.size === "number" ? record.size : null,
    url:
      typeof record.download_url === "string"
        ? null
        : typeof record.url === "string"
          ? record.url
          : null,
    download_url:
      typeof record.download_url === "string" ? record.download_url : null,
  });
}

function compactInternalToolMessageParts(parts: unknown) {
  const items = Array.isArray(parts) ? parts : [];
  return items
    .map((item) => compactInternalToolMessagePart(item))
    .filter((item) => item !== null && item !== undefined);
}

function buildInternalToolImageContents(parts: unknown) {
  const items = Array.isArray(parts) ? parts : [];
  return items
    .map((item) => asRecord(item))
    .filter((item) => item?.type === "image")
    .map((item) => {
      const data = typeof item?.base64 === "string" ? item.base64.trim() : "";
      const mimeType =
        typeof item?.mime_type === "string" && item.mime_type.trim()
          ? item.mime_type.trim()
          : "image/jpeg";
      if (!data) {
        return null;
      }
      return {
        type: "image",
        data,
        mimeType,
      };
    })
    .filter((item): item is { type: "image"; data: string; mimeType: string } => Boolean(item));
}

export function compactInternalTool(
  payload: unknown,
  options: { includeParameters?: boolean } = {},
) {
  const tool = asRecord(payload);
  if (!tool) {
    return payload;
  }

  const parameterSummary = compactToolParameters(tool.parameters, options.includeParameters);
  const parameterRecord = asRecord(parameterSummary);

  return compactObject({
    name: typeof tool.name === "string" ? tool.name : null,
    description: typeof tool.description === "string" ? tool.description : null,
    active: typeof tool.active === "boolean" ? tool.active : null,
    origin: typeof tool.origin === "string" && tool.origin !== "unknown" ? tool.origin : null,
    origin_name:
      typeof tool.origin_name === "string" && tool.origin_name !== "unknown"
        ? tool.origin_name
        : null,
    type: typeof tool.type === "string" ? tool.type : null,
    parameter_keys:
      Array.isArray(parameterRecord?.parameter_keys) ? parameterRecord.parameter_keys : null,
    required: Array.isArray(parameterRecord?.required) ? parameterRecord.required : null,
    parameter_count:
      typeof parameterRecord?.parameter_count === "number" ? parameterRecord.parameter_count : null,
    parameters: options.includeParameters ? parameterRecord?.schema ?? tool.parameters : null,
  });
}

export function compactInternalToolList(
  payload: unknown,
  options: { includeParameters?: boolean } = {},
) {
  const items = Array.isArray(payload) ? payload : [];
  return items
    .map((item) => compactInternalTool(item, options))
    .filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
}

function extractInternalToolText(payload: unknown) {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const emitted = asRecord(record.emitted);
  if (typeof emitted?.text === "string" && emitted.text.trim()) {
    return emitted.text.trim();
  }

  const results = Array.isArray(record.results) ? record.results : [];
  const texts = results
    .map((item) => asRecord(item))
    .flatMap((item) => {
      const directText = typeof item?.text === "string" ? item.text.trim() : "";
      const contentTexts = extractTextPartsFromResultContent(item?.content);
      return [directText, ...contentTexts].filter(Boolean);
    });
  if (texts.length > 0) {
    return [...new Set(texts)].join("\n\n");
  }

  if (typeof record.result_text === "string" && record.result_text.trim()) {
    return record.result_text.trim();
  }

  return null;
}

function extractInternalToolTaskId(payload: unknown, text: string | null) {
  const record = asRecord(payload);
  if (typeof record?.task_id === "string" && record.task_id.trim()) {
    return record.task_id.trim();
  }
  if (!text) {
    return null;
  }
  const match = text.match(/task_id\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
  return match?.[1] ?? null;
}

function isBackgroundAcceptanceText(text: string | null) {
  if (!text) {
    return false;
  }
  return [
    "Background task submitted",
    "任务已启动",
    "正在后台",
    "自动发送给用户",
    "完成后会自动发送",
    "你将会在完成后收到通知",
  ].some((pattern) => text.includes(pattern));
}

function extractInternalToolStatus(
  payload: unknown,
  completed: boolean | null,
  isBackgroundAccepted: boolean,
) {
  const record = asRecord(payload);
  if (typeof record?.status === "string" && record.status.trim()) {
    return record.status.trim();
  }
  if (isBackgroundAccepted) {
    return "running";
  }
  if (completed === true) {
    return "completed";
  }
  return "finished";
}

function compactInternalToolTaskEvent(
  payload: unknown,
  options: {
    includeParameters?: boolean;
    includeArguments?: boolean;
    includeDebug?: boolean;
  } = {},
) {
  const event = asRecord(payload);
  if (!event) {
    return payload;
  }
  const eventType = typeof event.type === "string" ? event.type : null;
  const data = event.data;
  let compactedData: unknown = data;

  if (eventType && ["accepted", "result", "completed", "failed"].includes(eventType)) {
    compactedData = compactInternalToolInvocation(data, {
      includeParameters: options.includeParameters,
      includeArguments: options.includeArguments,
      includeDebug: options.includeDebug,
    });
  } else if (eventType === "emitted") {
    const emitted = asRecord(data);
    compactedData = compactObject({
      type: typeof emitted?.type === "string" ? emitted.type : null,
      text: typeof emitted?.text === "string" ? emitted.text : null,
      reasoning: typeof emitted?.reasoning === "string" ? emitted.reasoning : null,
      completed: typeof emitted?.completed === "boolean" ? emitted.completed : null,
      message_parts:
        Array.isArray(emitted?.message_parts) && emitted.message_parts.length > 0
          ? emitted.message_parts
          : null,
    });
  }

  return compactObject({
    seq: typeof event.seq === "number" ? event.seq : null,
    type: eventType,
    data: compactedData,
  });
}

export function compactInternalToolInvocation(
  payload: unknown,
  options: {
    toolName?: string;
    includeParameters?: boolean;
    includeArguments?: boolean;
    includeDebug?: boolean;
  },
) {
  const record = asRecord(payload);
  const tool = compactInternalTool(record?.tool, {
    includeParameters: options.includeParameters,
  });
  const emitted = asRecord(record?.emitted);
  const argumentRecord = asRecord(record?.arguments);
  const debugRecord = asRecord(record?.debug);
  const text = extractInternalToolText(record);
  const isBackgroundAccepted = isBackgroundAcceptanceText(text);
  const taskId = extractInternalToolTaskId(record, text);
  const completed = typeof emitted?.completed === "boolean" ? emitted.completed : null;
  const status = extractInternalToolStatus(record, completed, isBackgroundAccepted);
  const messagePartsRaw =
    Array.isArray(emitted?.message_parts) && emitted.message_parts.length > 0
      ? emitted.message_parts
      : Array.isArray(record?.message_parts) && record.message_parts.length > 0
        ? record.message_parts
        : null;
  const messageParts = messagePartsRaw ? compactInternalToolMessageParts(messagePartsRaw) : null;
  const shouldExposeAcceptedReply = isBackgroundAccepted && !isInternalToolTaskTerminal(status);
  const shouldSuppressFinalAcceptance =
    isBackgroundAccepted && status === "completed" && messageParts !== null;

  return compactObject({
    tool: asRecord(tool),
    tool_name:
      options.toolName ??
      (typeof record?.tool_name === "string"
        ? record.tool_name
        : typeof asRecord(record?.tool)?.name === "string"
          ? String(asRecord(record?.tool)?.name)
          : null),
    status,
    task_id: taskId,
    execution_mode:
      typeof record?.execution_mode === "string" && record.execution_mode !== "sync"
        ? record.execution_mode
        : null,
    reply: !shouldExposeAcceptedReply && !shouldSuppressFinalAcceptance ? text : null,
    accepted_reply: shouldExposeAcceptedReply ? text : null,
    message_parts: messageParts,
    completed:
      status === "completed"
        ? true
        : status === "failed"
          ? false
          : completed,
    error: typeof record?.error === "string" && record.error.trim() ? record.error.trim() : null,
    conversation_id:
      typeof record?.conversation_id === "string" ? record.conversation_id : null,
    message_id: typeof record?.message_id === "string" ? record.message_id : null,
    unified_msg_origin:
      typeof record?.unified_msg_origin === "string" ? record.unified_msg_origin : null,
    arguments: options.includeArguments && argumentRecord ? argumentRecord : null,
    debug: options.includeDebug && debugRecord ? debugRecord : null,
    logs: Array.isArray(record?.logs) && record.logs.length > 0 ? record.logs : null,
  });
}

function buildInternalToolRichResult(
  runtime: Runtime,
  payload: unknown,
  compacted: unknown,
  options: {
    includeImageContent: boolean;
    includeLogs: boolean;
    logLimit: number;
  },
) {
  const record = asRecord(payload);
  const compactedRecord = asRecord(compacted);
  const rawLogs = Array.isArray(record?.logs) ? record.logs : [];
  const compactLogs =
    options.includeLogs && rawLogs.length > 0
      ? compactInternalToolLogEntries(runtime, rawLogs, options.logLimit)
      : [];

  const rawMessageParts =
    Array.isArray(asRecord(asRecord(payload)?.emitted)?.message_parts)
      ? asRecord(asRecord(payload)?.emitted)?.message_parts
      : Array.isArray(record?.message_parts)
        ? record.message_parts
        : Array.isArray(asRecord(compactedRecord?.task)?.message_parts)
          ? asRecord(compactedRecord?.task)?.message_parts
          : Array.isArray(compactedRecord?.message_parts)
            ? compactedRecord.message_parts
            : [];

  const finalValue = asRecord(compacted)
    ? compactObject({
        ...compactedRecord,
        logs: options.includeLogs && compactLogs.length > 0 ? compactLogs : null,
      })
    : compacted;

  const extraContent = options.includeImageContent
    ? buildInternalToolImageContents(rawMessageParts)
    : [];

  return richResult(finalValue, extraContent);
}

async function waitForInternalToolTask(
  runtime: Runtime,
  taskId: string,
  options: {
    waitTimeoutSeconds: number;
    pollIntervalSeconds: number;
  },
) {
  const deadline = Date.now() + options.waitTimeoutSeconds * 1000;
  let latest = await runtime.gateway.request("GET", `/tools/tasks/${encodeSegment(taskId)}`);
  while (Date.now() < deadline) {
    const statusRecord = asRecord(latest);
    const status =
      typeof statusRecord?.status === "string" ? statusRecord.status.trim() : null;
    if (isInternalToolTaskTerminal(status)) {
      return latest;
    }
    await sleep(Math.max(100, options.pollIntervalSeconds * 1000));
    latest = await runtime.gateway.request("GET", `/tools/tasks/${encodeSegment(taskId)}`);
  }
  return latest;
}

export function registerTools(server: McpServer, runtime: Runtime): ToolCatalogEntry[] {
  const registrar = new ToolRegistrar(server, runtime);
  registerSystemTools(registrar);
  registerMessageTools(registrar);
  registerPluginTools(registrar);

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
    async ({ provider_id }) => {
      const candidates = new Set<string>([provider_id]);
      if (provider_id.includes("/")) {
        candidates.add(provider_id.split("/")[0] ?? provider_id);
      }

      try {
        const providers = await runtime.gateway.request("GET", "/providers");
        const items = Array.isArray(providers) ? providers : [];
        const providerPrefix = provider_id.includes("/") ? provider_id.split("/")[0] ?? provider_id : provider_id;
        for (const item of items) {
          if (typeof item !== "object" || !item) {
            continue;
          }
          const record = item as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : null;
          const itemProviderId =
            typeof record.provider_id === "string" ? record.provider_id : null;
          const config =
            typeof record.config === "object" && record.config
              ? (record.config as Record<string, unknown>)
              : null;
          const sourceId =
            config && typeof config.provider_source_id === "string"
              ? config.provider_source_id
              : null;
          const normalizedSourceId = sourceId ? sourceId.replace(/[（(].*?[)）]/g, "") : null;
          const normalizedPrefix = providerPrefix.replace(/[（(].*?[)）]/g, "");

          if ([id, itemProviderId, config?.id].includes(provider_id) && sourceId) {
            if (id) {
              candidates.add(id);
            }
            if (itemProviderId) {
              candidates.add(itemProviderId);
            }
            candidates.add(sourceId);
          }

          const sourceMatchesPrefix =
            Boolean(sourceId && (sourceId.startsWith(providerPrefix) || providerPrefix.startsWith(sourceId))) ||
            Boolean(
              normalizedSourceId &&
                normalizedPrefix &&
                (normalizedSourceId === normalizedPrefix ||
                  normalizedSourceId.startsWith(normalizedPrefix) ||
                  normalizedPrefix.startsWith(normalizedSourceId)),
            );
          if (provider_id.includes("/") && sourceMatchesPrefix) {
            if (id) {
              candidates.add(id);
            }
            if (itemProviderId) {
              candidates.add(itemProviderId);
            }
          }
        }
      } catch {
        // Ignore provider catalog lookup failures and fall back to direct attempts.
      }

      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          return await runtime.gateway.request("GET", `/providers/${encodeSegment(candidate)}`);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Failed to get provider details.");
    },
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
      name: "list_astrbot_tools",
      summary: "List AstrBot internal LLM tools in a compact shape.",
      category: "astrbot_tools",
      minMode: "readonly",
      risk: "read",
      aliases: ["listtool", "astrbot-tool-list"],
    },
    {
      include_parameters: z.boolean().default(false),
    },
    async ({ include_parameters }) =>
      compactInternalToolList(await runtime.gateway.request("GET", "/tools"), {
        includeParameters: include_parameters,
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "list_internal_tools",
      summary: "List AstrBot internal LLM tools in a compact shape.",
      category: "astrbot_tools",
      minMode: "readonly",
      risk: "read",
      aliases: ["tools", "list-tool"],
    },
    {
      include_parameters: z.boolean().default(false),
    },
    async ({ include_parameters }) =>
      compactInternalToolList(await runtime.gateway.request("GET", "/tools"), {
        includeParameters: include_parameters,
      }),
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
      include_parameters: z.boolean().default(true),
    },
    async ({ tool_name, include_parameters }) =>
      compactInternalTool(
        await runtime.gateway.request("GET", `/tools/${encodeSegment(tool_name)}`),
        { includeParameters: include_parameters },
      ),
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
      wait_for_completion: z.boolean().default(true),
      wait_timeout_seconds: z.number().min(0.1).max(1800).default(30),
      poll_interval_seconds: z.number().min(0.1).max(10).default(1),
      include_logs: z.boolean().default(false),
      log_limit: z.number().int().min(1).max(500).default(30),
      include_image_content: z.boolean().default(true),
      image_max_bytes: z.number().int().min(1024).max(20 * 1024 * 1024).default(2 * 1024 * 1024),
      show_parameters: z.boolean().optional(),
      show_arguments: z.boolean().default(false),
      show_debug: z.boolean().default(false),
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
      wait_for_completion,
      wait_timeout_seconds,
      poll_interval_seconds,
      include_logs,
      log_limit,
      include_image_content,
      image_max_bytes,
      show_parameters,
      show_arguments,
      show_debug,
    }) => {
      const includeParameters =
        typeof show_parameters === "boolean"
          ? show_parameters
          : !seenInternalToolParameterHints.has(tool_name);

      const payload = await runtime.gateway.request(
        "POST",
        `/tools/${encodeSegment(tool_name)}/invoke`,
        {
          body: {
            arguments: args,
            message,
            sender_id,
            conversation_id,
            ensure_webui_session,
            persist_history,
            capture_messages,
            response_timeout_seconds,
            include_logs,
            log_limit,
            include_base64: include_image_content,
            base64_max_bytes: image_max_bytes,
          },
        },
      );

      const initialTaskId = extractInternalToolTaskId(payload, extractInternalToolText(payload));
      const initialStatus = typeof asRecord(payload)?.status === "string"
        ? String(asRecord(payload)?.status)
        : null;
      const finalPayload =
        wait_for_completion && initialTaskId && !isInternalToolTaskTerminal(initialStatus)
          ? await waitForInternalToolTask(runtime, initialTaskId, {
              waitTimeoutSeconds: wait_timeout_seconds,
              pollIntervalSeconds: poll_interval_seconds,
            })
          : payload;

      seenInternalToolParameterHints.add(tool_name);
      const compacted = compactInternalToolInvocation(finalPayload, {
        toolName: tool_name,
        includeParameters,
        includeArguments: show_arguments,
        includeDebug: show_debug,
      });
      return buildInternalToolRichResult(runtime, finalPayload, compacted, {
        includeImageContent: include_image_content,
        includeLogs: include_logs,
        logLimit: log_limit,
      });
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_internal_tool_task",
      summary: "Get one internal tool task state or final result.",
      category: "astrbot_tools",
      minMode: "readonly",
      risk: "read",
      aliases: ["tool-task", "tool-task-status"],
    },
    {
      task_id: z.string().min(1),
      include_logs: z.boolean().default(false),
      log_limit: z.number().int().min(1).max(500).default(30),
      include_image_content: z.boolean().default(true),
      show_parameters: z.boolean().default(false),
      show_arguments: z.boolean().default(false),
      show_debug: z.boolean().default(false),
    },
    async ({
      task_id,
      include_logs,
      log_limit,
      include_image_content,
      show_parameters,
      show_arguments,
      show_debug,
    }) => {
      const payload = await runtime.gateway.request("GET", `/tools/tasks/${encodeSegment(task_id)}`);
      const compacted = compactInternalToolInvocation(
        payload,
        {
          includeParameters: show_parameters,
          includeArguments: show_arguments,
          includeDebug: show_debug,
        },
      );
      return buildInternalToolRichResult(runtime, payload, compacted, {
        includeImageContent: include_image_content,
        includeLogs: include_logs,
        logLimit: log_limit,
      });
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "stream_internal_tool_task",
      summary: "Watch one internal tool task SSE stream and return compact events.",
      category: "astrbot_tools",
      minMode: "readonly",
      risk: "read",
      aliases: ["watch-tool-task", "tool-task-stream"],
    },
    {
      task_id: z.string().min(1),
      wait_seconds: z.number().min(0.1).max(1800).default(30),
      replay_history: z.boolean().default(true),
      include_logs: z.boolean().default(false),
      log_limit: z.number().int().min(1).max(500).default(30),
      include_image_content: z.boolean().default(true),
      show_parameters: z.boolean().default(false),
      show_arguments: z.boolean().default(false),
      show_debug: z.boolean().default(false),
    },
    async ({
      task_id,
      wait_seconds,
      replay_history,
      include_logs,
      log_limit,
      include_image_content,
      show_parameters,
      show_arguments,
      show_debug,
    }) => {
      const events = await runtime.gateway.stream(
        "GET",
        `/tools/tasks/${encodeSegment(task_id)}/stream`,
        {
          query: { replay_history },
          timeoutMs: Math.max(1000, wait_seconds * 1000),
        },
      );
      const snapshot = await runtime.gateway.request(
        "GET",
        `/tools/tasks/${encodeSegment(task_id)}`,
      );
      const task = compactInternalToolInvocation(snapshot, {
        includeParameters: show_parameters,
        includeArguments: show_arguments,
        includeDebug: show_debug,
      });
      const payload = compactObject({
        task: compactInternalToolInvocation(snapshot, {
          includeParameters: show_parameters,
          includeArguments: show_arguments,
          includeDebug: show_debug,
        }),
        events: events
          .map((event) => compactInternalToolTaskEvent(event.data, {
            includeParameters: show_parameters,
            includeArguments: show_arguments,
            includeDebug: show_debug,
          }))
          .filter((event) => event !== null && event !== undefined),
      });
      return buildInternalToolRichResult(
        runtime,
        compactObject({
          ...(asRecord(snapshot) ?? {}),
          logs: include_logs ? asRecord(snapshot)?.logs : null,
          message_parts: asRecord(task)?.message_parts,
        }),
        payload,
        {
          includeImageContent: include_image_content,
          includeLogs: include_logs,
          logLimit: log_limit,
        },
      );
    },
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

