import * as z from "zod/v4";

import { extractLogEntries, filterLogsByContains, filterLogsByNeedles } from "./logs.js";
import { ToolRegistrar, compactOrRawLogs, encodeSegment, withToolErrorBoundary } from "./tooling.js";
import { redactSensitiveData } from "./utils.js";

function summarizeRestartAck(payload: unknown) {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return {
    accepted: record.accepted === undefined ? true : Boolean(record.accepted),
    restarting: record.restarting === undefined ? true : Boolean(record.restarting),
  };
}

export function registerSystemTools(registrar: ToolRegistrar) {
  const { runtime } = registrar;

  withToolErrorBoundary(
    registrar,
    {
      name: "get_system_summary",
      summary: "Get AstrBot and gateway runtime summary.",
      category: "system",
      minMode: "readonly",
      risk: "read",
      aliases: ["system", "status", "meta"],
    },
    {},
    async () => {
      const [health, gatewayMeta] = await Promise.allSettled([
        runtime.gateway.request("GET", "/health"),
        runtime.gateway.request("GET", "/meta"),
      ]);
      return {
        capability_mode: runtime.config.capabilityMode,
        search_tools_enabled: runtime.config.enableSearchTools,
        wake_prefix: runtime.hints.wakePrefix,
        friend_message_needs_wake_prefix: runtime.hints.friendMessageNeedsWakePrefix,
        reply_prefix: runtime.hints.replyPrefix,
        health: health.status === "fulfilled" ? health.value : null,
        gateway: gatewayMeta.status === "fulfilled" ? redactSensitiveData(gatewayMeta.value) : null,
      };
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_compact_logs",
      summary: "Read AstrBot logs with compact noise-filtered output by default.",
      category: "system",
      minMode: "readonly",
      risk: "read",
      aliases: ["logs", "history", "live-log"],
    },
    {
      wait_seconds: z.number().int().min(0).max(120).default(0),
      max_entries: z.number().int().min(1).max(1000).default(200),
      contains: z.string().optional().describe("Optional substring filter applied after log retrieval. Use this to narrow noisy history to one plugin, command, trace id, or payload fragment."),
    },
    async ({ wait_seconds, max_entries, contains }) => {
      const endpoint = runtime.config.logView === "compact" ? "/logs/compact" : "/logs/history";
      const payload = await runtime.gateway.request("GET", endpoint, {
        query: { wait_seconds, limit: max_entries },
      });
      const rawLogs = filterLogsByContains(extractLogEntries(payload), contains);
      return {
        mode:
          (payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).mode
            : null) ?? (wait_seconds > 0 ? "watch" : "history"),
        log_view: runtime.config.logView,
        noise_filtering: runtime.config.enableLogNoiseFiltering,
        contains: contains?.trim() || null,
        count: rawLogs.length,
        logs: compactOrRawLogs(runtime, rawLogs, max_entries),
      };
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_logs_by_id",
      summary:
        "Find logs by event id, session id, or message id; supports waiting for new event logs.",
      category: "system",
      minMode: "readonly",
      risk: "read",
      aliases: ["event-log", "message-id", "session-id"],
    },
    {
      event_id: z.string().optional(),
      session_id: z.string().optional(),
      message_id: z.string().optional(),
      wait_seconds: z.number().int().min(0).max(120).default(0),
      max_entries: z.number().int().min(1).max(1000).default(200),
    },
    async ({ event_id, session_id, message_id, wait_seconds, max_entries }) => {
      if (!event_id && !session_id && !message_id) {
        throw new Error("One of event_id, session_id, or message_id is required.");
      }

      let rawLogs: unknown[] = [];
      if (event_id) {
        const payload = (await runtime.gateway.request(
          "GET",
          `/logs/events/${encodeSegment(event_id)}`,
          {
            query: { wait_seconds, limit: max_entries },
          },
        )) as Record<string, unknown>;
        rawLogs = extractLogEntries(payload);
      } else {
        const contains = session_id ?? message_id;
        const historyPayload = await runtime.gateway.request("GET", "/logs/history", {
          query: { wait_seconds, limit: max_entries, contains },
        });
        const history = extractLogEntries(historyPayload);
        rawLogs = filterLogsByNeedles(history, {
          sessionId: session_id,
          messageId: message_id,
        });
      }

      return {
        filters: { event_id, session_id, message_id },
        count: rawLogs.length,
        logs: compactOrRawLogs(runtime, rawLogs, max_entries),
      };
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "restart_astrbot",
      summary: "Restart AstrBot core and wait for gateway recovery.",
      category: "system",
      minMode: "full",
      risk: "destructive",
      aliases: ["restart", "core"],
    },
    {
      max_wait_seconds: z.number().int().min(5).max(180).default(60),
      check_interval_seconds: z.number().int().min(1).max(10).default(2),
      include_status: z.boolean().default(false),
    },
    async ({ max_wait_seconds, check_interval_seconds, include_status }) => {
      const restartResponse = await runtime.gateway.request("POST", "/system/restart-core");
      const restartAck = summarizeRestartAck(restartResponse);
      const start = Date.now();
      let checks = 0;

      while (Date.now() - start < max_wait_seconds * 1000) {
        try {
          const health = await runtime.gateway.request("GET", "/health");
          const result: Record<string, unknown> = {
            restarted: true,
            ...restartAck,
            waited_seconds: Math.round((Date.now() - start) / 1000),
            checks,
          };
          if (include_status) {
            const meta = await runtime.gateway.request("GET", "/meta");
            result.health = health;
            result.meta = redactSensitiveData(meta);
          }
          return result;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, check_interval_seconds * 1000));
          checks += 1;
        }
      }

      return {
        restarted: false,
        ...restartAck,
        timeout: max_wait_seconds,
        checks,
      };
    },
  );
}
