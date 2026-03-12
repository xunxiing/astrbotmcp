import * as z from "zod/v4";

import { Runtime, ToolRegistrar, compactOrRawLogs, encodeSegment, withToolErrorBoundary } from "./tooling.js";

const messagePartSchema = z.record(z.string(), z.unknown());

const llmConfigSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    enable_streaming: z.boolean().optional(),
  })
  .optional();

function extractLogs(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.logs)) {
    return record.logs;
  }
  if (Array.isArray(record.history)) {
    return record.history;
  }
  return [];
}

function logFingerprint(logs: unknown[]): string {
  const last = logs.at(-1);
  return JSON.stringify({
    count: logs.length,
    last: last ?? null,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractPlainTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      const record = asRecord(part);
      if (!record) {
        return "";
      }
      if (record.type === "plain" && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isMetricsMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      parsed &&
      typeof parsed === "object" &&
      ("token_usage" in parsed || "time_to_first_token" in parsed || "start_time" in parsed)
    );
  } catch {
    return false;
  }
}

function normalizeHistoryUserId(platformId: string, userId?: string, conversationId?: string): string {
  if (platformId === "webchat") {
    const normalized = String(conversationId ?? userId ?? "").trim();
    if (!normalized) {
      throw new Error("conversation_id or target_id is required for webchat history.");
    }
    if (normalized.startsWith("webchat!")) {
      const parts = normalized.split("!", 3);
      if (parts.length === 3 && parts[2]) {
        return parts[2];
      }
    }
    return normalized;
  }
  const normalized = String(userId ?? "").trim();
  if (!normalized) {
    throw new Error("user_id or target_id is required.");
  }
  return normalized;
}

function parseWebchatConversationId(value: string): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("webchat!")) {
    const parts = normalized.split("!", 3);
    if (parts.length === 3 && parts[2]) {
      return parts[2];
    }
  }
  return normalized;
}

function parseWebchatConversationFromOrigin(unifiedMsgOrigin?: string): string | null {
  const normalized = String(unifiedMsgOrigin ?? "").trim();
  if (!normalized.startsWith("webchat:")) {
    return null;
  }
  const parts = normalized.split(":");
  if (parts.length < 3) {
    return null;
  }
  return parseWebchatConversationId(parts.slice(2).join(":"));
}

function resolveWebchatConversationId(args: {
  conversationId?: string;
  sessionId?: string;
  unifiedMsgOrigin?: string;
  senderId: string;
}): string {
  return (
    parseWebchatConversationId(args.conversationId ?? "") ??
    parseWebchatConversationId(args.sessionId ?? "") ??
    parseWebchatConversationFromOrigin(args.unifiedMsgOrigin) ??
    `rest-${args.senderId}`
  );
}

function deriveHistoryTarget(injection: Record<string, unknown>): { platformId: string; userId: string } | null {
  const platformId = String(injection.platform_id ?? "").trim();
  if (!platformId) {
    return null;
  }
  if (platformId === "webchat") {
    const conversationId = String(
      injection.conversation_id ?? injection.display_conversation_id ?? "",
    ).trim();
    if (!conversationId) {
      return null;
    }
    return { platformId, userId: conversationId };
  }
  const sessionId = String(injection.session_id ?? "").trim();
  if (!sessionId) {
    return null;
  }
  return { platformId, userId: sessionId };
}

async function fetchMessageHistory(
  runtime: Runtime,
  platformId: string,
  userId: string,
  pageSize: number,
): Promise<Record<string, unknown>[]> {
  const payload = await runtime.gateway.request("GET", "/messages/history", {
    query: {
      platform_id: platformId,
      user_id: userId,
      page_size: pageSize,
    },
  });
  return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))) : [];
}

function extractReplyFromHistory(history: Record<string, unknown>[]) {
  let lastUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (String(entry.sender_id ?? "") !== "bot") {
      lastUserIndex = index;
      break;
    }
  }

  const replyEntries = history
    .slice(lastUserIndex + 1)
    .filter((entry) => String(entry.sender_id ?? "") === "bot")
    .map((entry) => {
      const content = asRecord(entry.content) ?? {};
      const parts = Array.isArray(content.message) ? content.message : [];
      const text = extractPlainTextFromParts(parts);
      return {
        sender_id: String(entry.sender_id ?? ""),
        sender_name: String(entry.sender_name ?? "bot"),
        text,
        reasoning: typeof content.reasoning === "string" ? content.reasoning : "",
        parts,
        created_at: entry.created_at ?? null,
      };
    })
    .filter((entry) => entry.text || entry.reasoning || entry.parts.length > 0);

  const visibleReplies = replyEntries.filter((entry) => !isMetricsMessage(entry.text));
  const selected = visibleReplies.at(-1) ?? null;

  return {
    reply: selected,
    reply_count: visibleReplies.length,
    raw_bot_message_count: replyEntries.length,
  };
}

async function waitForReplyHistory(
  runtime: Runtime,
  target: { platformId: string; userId: string } | null,
  options: {
    waitSeconds: number;
    pollIntervalSeconds: number;
    pageSize: number;
  },
): Promise<{
  reply: {
    sender_id: string;
    sender_name: string;
    text: string;
    reasoning: string;
    parts: unknown[];
    created_at: unknown;
  } | null;
  reply_count: number;
  raw_bot_message_count: number;
  history: Record<string, unknown>[];
  found: boolean;
  checks: number;
  reason: "unavailable" | "disabled" | "reply_found" | "timeout";
}> {
  if (!target) {
    return {
      reply: null,
      reply_count: 0,
      raw_bot_message_count: 0,
      history: [] as Record<string, unknown>[],
      found: false,
      checks: 0,
      reason: "unavailable" as const,
    };
  }

  const { waitSeconds, pollIntervalSeconds, pageSize } = options;
  if (waitSeconds <= 0) {
    const history = await fetchMessageHistory(runtime, target.platformId, target.userId, pageSize);
    const extracted = extractReplyFromHistory(history);
    return {
      ...extracted,
      history,
      found: Boolean(extracted.reply),
      checks: 1,
      reason: "disabled" as const,
    };
  }

  const deadline = Date.now() + waitSeconds * 1000;
  let checks = 0;
  let history: Record<string, unknown>[] = [];

  while (Date.now() <= deadline) {
    history = await fetchMessageHistory(runtime, target.platformId, target.userId, pageSize);
    checks += 1;
    const extracted = extractReplyFromHistory(history);
    if (extracted.reply) {
      return {
        ...extracted,
        history,
        found: true,
        checks,
        reason: "reply_found" as const,
      };
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
  }

  return {
    ...extractReplyFromHistory(history),
    history,
    found: false,
    checks,
    reason: "timeout" as const,
  };
}

async function fetchEventLogs(
  runtime: Runtime,
  eventId: string,
  waitSeconds: number,
  maxEntries: number,
): Promise<unknown[]> {
  const payload = await runtime.gateway.request("GET", `/logs/events/${encodeSegment(eventId)}`, {
    query: {
      wait_seconds: waitSeconds,
      limit: maxEntries,
    },
  });
  return extractLogs(payload);
}

export interface EventWatchResult {
  rawLogs: unknown[];
  logs: unknown[];
  waitedSeconds: number;
  settled: boolean;
  reason: "quiet_window" | "timeout" | "disabled";
  checks: number;
}

export async function waitForEventToSettle(
  runtime: Runtime,
  eventId: string,
  options: {
    maxEntries: number;
    waitSeconds: number;
    quietWindowSeconds: number;
    pollIntervalSeconds: number;
  },
): Promise<EventWatchResult> {
  const { maxEntries, waitSeconds, quietWindowSeconds, pollIntervalSeconds } = options;
  if (waitSeconds <= 0) {
    const rawLogs = await fetchEventLogs(runtime, eventId, 0, maxEntries);
    return {
      rawLogs,
      logs: compactOrRawLogs(runtime, rawLogs, maxEntries),
      waitedSeconds: 0,
      settled: false,
      reason: "disabled",
      checks: 1,
    };
  }

  const start = Date.now();
  const deadline = start + waitSeconds * 1000;
  let quietForMs = 0;
  let previousFingerprint = "";
  let checks = 0;
  let rawLogs: unknown[] = [];

  while (true) {
    const remainingMs = deadline - Date.now();
    const stepSeconds = Math.max(0, Math.min(pollIntervalSeconds, Math.ceil(remainingMs / 1000)));
    rawLogs = await fetchEventLogs(runtime, eventId, stepSeconds, maxEntries);
    checks += 1;

    const currentFingerprint = logFingerprint(rawLogs);
    if (currentFingerprint === previousFingerprint) {
      quietForMs += stepSeconds * 1000;
    } else {
      quietForMs = 0;
      previousFingerprint = currentFingerprint;
    }

    if (quietForMs >= quietWindowSeconds * 1000) {
      return {
        rawLogs,
        logs: compactOrRawLogs(runtime, rawLogs, maxEntries),
        waitedSeconds: Math.round((Date.now() - start) / 1000),
        settled: true,
        reason: "quiet_window",
        checks,
      };
    }

    if (Date.now() >= deadline) {
      return {
        rawLogs,
        logs: compactOrRawLogs(runtime, rawLogs, maxEntries),
        waitedSeconds: Math.round((Date.now() - start) / 1000),
        settled: false,
        reason: "timeout",
        checks,
      };
    }
  }
}

export function registerMessageTools(registrar: ToolRegistrar) {
  const { runtime } = registrar;

  withToolErrorBoundary(
    registrar,
    {
      name: "trigger_message_reply",
      summary:
        "Inject an inbound message into AstrBot, optionally override the LLM, wait for reply processing to settle, and return compact event logs by default.",
      category: "messages",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["send-message", "chat-with-bot", "trigger-reply", "inject-message", "send-with-logs"],
    },
    {
      message: z.string().optional(),
      message_chain: z.array(messagePartSchema).optional(),
      sender_id: z.string().default("mcp-test"),
      display_name: z.string().optional(),
      unified_msg_origin: z.string().optional(),
      platform_id: z.string().optional(),
      message_type: z.string().optional(),
      session_id: z.string().optional(),
      group_id: z.string().optional(),
      conversation_id: z.string().optional(),
      llm: llmConfigSchema,
      response_timeout_seconds: z.number().min(1).max(600).default(120),
      show_in_webui: z.boolean().default(true),
      include_logs: z.boolean().default(true),
      include_debug: z.boolean().default(false),
      wait_seconds: z.number().int().min(0).max(180).default(15),
      quiet_window_seconds: z.number().int().min(1).max(30).default(2),
      poll_interval_seconds: z.number().int().min(1).max(10).default(1),
      max_entries: z.number().int().min(1).max(1000).default(200),
    },
    async ({
      message,
      message_chain,
      sender_id,
      display_name,
      unified_msg_origin,
      platform_id,
      message_type,
      session_id,
      group_id,
      conversation_id,
      llm,
      response_timeout_seconds,
      show_in_webui,
      include_logs,
      include_debug,
      wait_seconds,
      quiet_window_seconds,
      poll_interval_seconds,
      max_entries,
    }) => {
      const resolvedSenderId = sender_id ?? "mcp-test";
      const resolvedResponseTimeoutSeconds = response_timeout_seconds ?? 120;
      const resolvedIncludeLogs = include_logs ?? true;
      const resolvedIncludeDebug = include_debug ?? false;
      const resolvedWaitSeconds = wait_seconds ?? 15;
      const resolvedQuietWindowSeconds = quiet_window_seconds ?? 2;
      const resolvedPollIntervalSeconds = poll_interval_seconds ?? 1;
      const resolvedMaxEntries = max_entries ?? 200;

      if (!message && (!message_chain || message_chain.length === 0)) {
        throw new Error("message or message_chain is required.");
      }

      const useWebchatQueueInjection =
        platform_id === "webchat" || String(unified_msg_origin ?? "").startsWith("webchat:");
      const normalizedConversationId = useWebchatQueueInjection
        ? resolveWebchatConversationId({
            conversationId: conversation_id,
            sessionId: session_id,
            unifiedMsgOrigin: unified_msg_origin,
            senderId: resolvedSenderId,
          })
        : conversation_id;

      const injection = (await runtime.gateway.request("POST", "/events/injections/message", {
        body: {
          message,
          message_chain,
          sender_id: resolvedSenderId,
          display_name,
          unified_msg_origin: useWebchatQueueInjection ? undefined : unified_msg_origin,
          platform_id: useWebchatQueueInjection ? undefined : platform_id,
          message_type: useWebchatQueueInjection ? undefined : message_type,
          session_id: useWebchatQueueInjection ? undefined : session_id,
          group_id: useWebchatQueueInjection ? undefined : group_id,
          conversation_id: normalizedConversationId,
          selected_provider: llm?.provider,
          selected_model: llm?.model,
          enable_streaming: llm?.enable_streaming,
          response_timeout_seconds: resolvedResponseTimeoutSeconds,
          show_in_webui,
          ensure_webui_session: true,
          persist_bot_response: true,
          persist_history: true,
        },
      })) as Record<string, unknown>;

      const eventId = String(injection.message_id ?? "");
      if (!eventId) {
        const result: Record<string, unknown> = {
          reply_found: false,
          reply: null,
        };
        if (resolvedIncludeLogs) {
          result.logs = [];
        }
        if (resolvedIncludeDebug) {
          result.debug = {
            injection,
            event_id: null,
            completion: {
              waited_seconds: 0,
              settled: false,
              reason: "disabled",
              checks: 0,
            },
          };
        }
        return {
          ...result,
        };
      }

      const watch = await waitForEventToSettle(runtime, eventId, {
        maxEntries: resolvedMaxEntries,
        waitSeconds: resolvedWaitSeconds,
        quietWindowSeconds: resolvedQuietWindowSeconds,
        pollIntervalSeconds: resolvedPollIntervalSeconds,
      });

      const historyTarget = deriveHistoryTarget(injection);
      const replyLookup = await waitForReplyHistory(runtime, historyTarget, {
        waitSeconds: Math.max(0, resolvedWaitSeconds - watch.waitedSeconds),
        pollIntervalSeconds: resolvedPollIntervalSeconds,
        pageSize: Math.min(resolvedMaxEntries, 100),
      });

      const result: Record<string, unknown> = {};
      if (replyLookup.reply) {
        result.reply = replyLookup.reply.text;
        if (replyLookup.reply.reasoning) {
          result.reasoning = replyLookup.reply.reasoning;
        }
      } else {
        result.reply_found = false;
        result.reply = null;
        result.status = {
          waited_seconds: watch.waitedSeconds,
          settled: watch.settled,
          reason: watch.reason,
        };
      }

      if (resolvedIncludeLogs && watch.logs.length > 0) {
        result.logs = watch.logs;
      }
      if (resolvedIncludeDebug) {
        result.debug = {
          session: {
            platform_id: String(injection.platform_id ?? historyTarget?.platformId ?? ""),
            unified_msg_origin: injection.unified_msg_origin ?? null,
            conversation_id: injection.conversation_id ?? injection.display_conversation_id ?? null,
            session_id: injection.session_id ?? null,
            sender_id: resolvedSenderId,
            display_name: display_name ?? injection.display_name ?? resolvedSenderId,
          },
          event_id: eventId,
          completion: {
            waited_seconds: watch.waitedSeconds,
            settled: watch.settled,
            reason: watch.reason,
            checks: watch.checks,
          },
          injection,
          history_target: historyTarget,
          history_checks: replyLookup.checks,
          history_reason: replyLookup.reason,
          quiet_window_seconds: resolvedQuietWindowSeconds,
          poll_interval_seconds: resolvedPollIntervalSeconds,
          log_count: watch.rawLogs.length,
          raw_bot_message_count: replyLookup.raw_bot_message_count,
          visible_reply_count: replyLookup.reply_count,
        };
      }

      return result;
    },
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_recent_sessions",
      summary: "Get recently observed sessions from gateway capture.",
      category: "messages",
      minMode: "readonly",
      risk: "read",
      aliases: ["recent-session"],
    },
    {
      limit: z.number().int().min(1).max(200).default(20),
    },
    async ({ limit }) =>
      runtime.gateway.request("GET", "/messages/recent-sessions", {
        query: { limit },
      }),
  );

  withToolErrorBoundary(
    registrar,
    {
      name: "get_message_history",
      summary: "Get persisted message history. For webchat, use conversation_id or target_id instead of sender_id.",
      category: "messages",
      minMode: "readonly",
      risk: "read",
      aliases: ["message-history"],
    },
    {
      platform_id: z.string().min(1),
      user_id: z.string().optional(),
      target_id: z.string().optional(),
      conversation_id: z.string().optional(),
      page: z.number().int().min(1).default(1),
      page_size: z.number().int().min(1).max(500).default(50),
    },
    async ({ platform_id, user_id, target_id, conversation_id, page, page_size }) => {
      const resolvedUserId = normalizeHistoryUserId(
        platform_id,
        target_id ?? user_id,
        conversation_id,
      );
      const history = await runtime.gateway.request("GET", "/messages/history", {
        query: { platform_id, user_id: resolvedUserId, page, page_size },
      });
      return {
        platform_id,
        resolved_user_id: resolvedUserId,
        history,
      };
    },
  );
}
