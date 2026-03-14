import * as z from "zod/v4";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AppConfig, CapabilityMode } from "./config.js";
import { ApiError, GatewayClient } from "./clients.js";
import { compactLogs } from "./logs.js";
import { toolResult } from "./result.js";
import { RuntimeHints } from "./runtime-hints.js";
import { normalizeQuery } from "./utils.js";

export type ToolRisk = "read" | "safe-write" | "destructive";
export type ToolCategory =
  | "system"
  | "platforms"
  | "providers"
  | "configs"
  | "plugins"
  | "messages"
  | "astrbot_tools"
  | "mcp_servers"
  | "personas"
  | "skills"
  | "subagents"
  | "cron"
  | "discovery";

export interface Runtime {
  config: AppConfig;
  gateway: GatewayClient;
  hints: RuntimeHints;
}

export interface ToolCatalogEntry {
  name: string;
  summary: string;
  category: ToolCategory;
  minMode: CapabilityMode;
  risk: ToolRisk;
  aliases: string[];
  enabled: boolean;
}

const modeRank: Record<CapabilityMode, number> = {
  search: 0,
  readonly: 1,
  minimize: 2,
  full: 3,
};

function allowByMode(current: CapabilityMode, minMode: CapabilityMode): boolean {
  return modeRank[current] >= modeRank[minMode];
}

export function compactOrRawLogs(runtime: Runtime, logs: unknown[], maxEntries: number) {
  if (runtime.config.logView === "raw") {
    return logs.slice(-maxEntries);
  }
  const compacted = compactLogs(logs, {
    enableNoiseFiltering: runtime.config.enableLogNoiseFiltering,
    maxEntries,
  });
  if (compacted.length > 0 || !runtime.config.enableLogNoiseFiltering) {
    return compacted;
  }
  return compactLogs(logs, {
    enableNoiseFiltering: false,
    maxEntries,
  });
}

export function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function scoreToolQuery(query: string, tool: ToolCatalogEntry): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return 0;
  }
  const tokens = normalizeQuery(query);
  const name = tool.name.toLowerCase();
  const aliases = tool.aliases.map((item) => item.toLowerCase());
  const summary = tool.summary.toLowerCase();
  let score = 0;
  if (name === normalized) {
    score += 100;
  } else if (name.startsWith(normalized)) {
    score += 60;
  } else if (name.includes(normalized)) {
    score += 40;
  }
  for (const token of tokens) {
    if (name === token) {
      score += 40;
    } else if (name.startsWith(token)) {
      score += 24;
    } else if (name.includes(token)) {
      score += 16;
    }
    if (aliases.some((alias) => alias.includes(token))) {
      score += 10;
    }
    if (summary.includes(token)) {
      score += 6;
    }
  }
  if (tool.enabled) {
    score += 3;
  }
  return score;
}

export class ToolRegistrar {
  readonly catalog: ToolCatalogEntry[] = [];

  constructor(
    private readonly server: McpServer,
    readonly runtime: Runtime,
  ) {}

  register(
    entry: Omit<ToolCatalogEntry, "enabled">,
    inputSchema: Record<string, z.ZodType>,
    handler: (args: any) => Promise<unknown>,
  ) {
    const enabled = allowByMode(this.runtime.config.capabilityMode, entry.minMode);
    this.catalog.push({ ...entry, enabled });
    if (!enabled) {
      return;
    }
    this.server.registerTool(
      entry.name,
      {
        description: entry.summary,
        inputSchema,
      },
      async (args) => toolResult(await handler(args)),
    );
  }
}

export function categorySummary(catalog: ToolCatalogEntry[]) {
  const summary: Record<string, number> = {};
  for (const item of catalog) {
    if (!item.enabled) {
      continue;
    }
    summary[item.category] = (summary[item.category] ?? 0) + 1;
  }
  return summary;
}

function toErrorPayload(error: unknown) {
  if (error instanceof ApiError) {
    return {
      type: "ApiError",
      message: error.message,
      statusCode: error.statusCode,
      details: error.details ?? null,
    };
  }
  if (error instanceof Error) {
    return { type: error.name, message: error.message };
  }
  return { type: "UnknownError", message: String(error) };
}

export function withToolErrorBoundary(
  registrar: ToolRegistrar,
  entry: Omit<ToolCatalogEntry, "enabled">,
  inputSchema: Record<string, z.ZodType>,
  handler: (args: any) => Promise<unknown>,
) {
  registrar.register(entry, inputSchema, async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return {
        ok: false,
        error: toErrorPayload(error),
      };
    }
  });
}
