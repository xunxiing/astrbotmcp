import * as z from "zod/v4";

import { extractLogEntries } from "./logs.js";
import { Runtime, ToolRegistrar, compactOrRawLogs, encodeSegment, withToolErrorBoundary } from "./tooling.js";

const messagePartSchema = z.record(z.string(), z.unknown());

const llmConfigSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    enable_streaming: z.boolean().optional(),
  })
  .optional();

function logFingerprint(logs: unknown[]): string {
  const last = logs.at(-1);
  return JSON.stringify({
    count: logs.length,
    last: last ?? null,
  });
}

export function compactMessageToolLogs(logs: unknown[]): unknown[] {
  return logs.map((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return entry;
    }
    const message = coerceLogText(entry).replace(/^(?:\[[^\]]+\]\s*)+:\s*/, "").trim();
    if (message) {
      return { message };
    }
    const compacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === undefined || value === "") {
        continue;
      }
      if (key === "time" || key === "level" || key === "component") {
        continue;
      }
      compacted[key] = value;
    }
    return compacted;
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

interface ReplyCandidate {
  sender_id: string;
  sender_name: string;
  text: string;
  reasoning: string;
  parts: unknown[];
  created_at: unknown;
  created_at_ms: number | null;
}

interface ReplySelectionOptions {
  inputText?: string;
  senderId?: string;
  senderName?: string;
  notBeforeMs?: number;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function maybeParseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function extractTraceReplyText(value: unknown): string {
  const parsed = maybeParseJson(value);
  const record = asRecord(parsed);
  if (!record) {
    return "";
  }

  const fields = asRecord(record.fields);
  const resp = fields?.resp ?? record.resp;
  if (typeof resp === "string" && resp.trim()) {
    return resp.trim();
  }

  const text = fields?.text ?? record.text;
  if (typeof text === "string" && text.trim()) {
    return text.trim();
  }

  return "";
}

function normalizeSpecialText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return extractTraceReplyText(trimmed) || trimmed;
}

function normalizeInlinePart(type: string, fields: Record<string, unknown>) {
  const normalized: Record<string, unknown> = { type };
  for (const key of ["text", "url", "name", "qq", "user_id"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) {
      normalized[key] = value.trim();
    }
  }
  return normalized;
}

function normalizeGatewayMessagePart(part: unknown): Record<string, unknown> | null {
  const record = asRecord(part);
  if (!record) {
    return null;
  }
  const type = String(record.type ?? "").trim();
  if (!type) {
    return null;
  }

  const data = asRecord(record.data) ?? {};
  if (type === "plain" || type === "text") {
    const textCandidate = data.text ?? record.text;
    const normalizedText = normalizeSpecialText(textCandidate);
    if (normalizedText) {
      return { type: "plain", text: normalizedText };
    }
  }

  if (type === "at") {
    const qq = typeof data.qq === "string" ? data.qq.trim() : "";
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const text = typeof record.text === "string" ? record.text.trim() : "";
    return normalizeInlinePart("at", {
      text: text || (name ? `@${name}` : qq ? `@${qq}` : ""),
      qq,
      name,
    });
  }

  if (type === "file" || type === "image") {
    const urlCandidate = data.url ?? data.file ?? data.file_ ?? record.url;
    const nameCandidate = data.name ?? record.name;
    return normalizeInlinePart(type, {
      url: typeof urlCandidate === "string" ? urlCandidate : "",
      name: typeof nameCandidate === "string" ? nameCandidate : "",
    });
  }

  const textCandidate = data.text ?? record.text;
  const normalizedText = normalizeSpecialText(textCandidate);
  if (normalizedText) {
    return normalizeInlinePart(type, { text: normalizedText });
  }

  const urlCandidate = data.url ?? record.url;
  if (typeof urlCandidate === "string" && urlCandidate.trim()) {
    return normalizeInlinePart(type, { url: urlCandidate });
  }

  return { type };
}

function normalizeGatewayMessageParts(parts: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts
    .map((part) => normalizeGatewayMessagePart(part))
    .filter((part): part is Record<string, unknown> => Boolean(part));
}

function extractPlainTextFromParts(parts: unknown): string {
  return normalizeGatewayMessageParts(parts)
    .map((part) => {
      const type = String(part.type ?? "").trim();
      const text = typeof part.text === "string" ? part.text.trim() : "";
      const url = typeof part.url === "string" ? part.url.trim() : "";
      const name = typeof part.name === "string" ? part.name.trim() : "";

      if (type === "plain" || type === "at") {
        return text;
      }
      if (text) {
        return text;
      }
      if (type === "file") {
        return `[file] ${url || name}`.trim();
      }
      if (type === "image") {
        return `[image] ${url || name}`.trim();
      }
      if (url) {
        return `[${type}] ${url}`.trim();
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

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function coerceLogText(entry: unknown): string {
  const record = asRecord(entry);
  if (!record) {
    return "";
  }
  const candidate =
    typeof record.data === "string"
      ? record.data
      : typeof record.message === "string"
        ? record.message
        : "";
  return stripAnsi(candidate).trim();
}

function extractPartsAndReasoning(entry: Record<string, unknown>) {
  const content = maybeParseJson(entry.content);
  const contentRecord = asRecord(content);

  let parts: Record<string, unknown>[] = [];
  let reasoning = "";

  if (Array.isArray(content)) {
    parts = normalizeGatewayMessageParts(content);
  } else if (contentRecord) {
    parts = normalizeGatewayMessageParts(contentRecord.message);
    if (parts.length === 0) {
      parts = normalizeGatewayMessageParts(contentRecord.content);
    }
    reasoning =
      typeof contentRecord.reasoning === "string" ? contentRecord.reasoning.trim() : "";
    if (parts.length === 0) {
      const textCandidate =
        extractTraceReplyText(contentRecord) ||
        normalizeSpecialText(contentRecord.text ?? contentRecord.plain_text ?? contentRecord.message);
      if (textCandidate) {
        parts = [{ type: "plain", text: textCandidate }];
      }
    }
  } else if (typeof content === "string" && content.trim()) {
    parts = [{ type: "plain", text: normalizeSpecialText(content) }];
  }

  if (parts.length === 0) {
    parts = normalizeGatewayMessageParts(entry.message_chain);
  }
  if (parts.length === 0) {
    parts = normalizeGatewayMessageParts(entry.parts);
  }
  if (parts.length === 0) {
    const textCandidate = entry.plain_text ?? entry.message ?? entry.text;
    const normalizedText = normalizeSpecialText(textCandidate);
    if (normalizedText) {
      parts = [{ type: "plain", text: normalizedText }];
    }
  }
  if (!reasoning && typeof entry.reasoning === "string") {
    reasoning = entry.reasoning.trim();
  }

  return { parts, reasoning };
}

function normalizeReplyCandidate(entry: Record<string, unknown>): ReplyCandidate | null {
  const { parts, reasoning } = extractPartsAndReasoning(entry);
  const text = extractPlainTextFromParts(parts);
  const senderId = String(entry.sender_id ?? entry.user_id ?? entry.sender ?? "").trim();
  const senderName =
    String(entry.sender_name ?? entry.display_name ?? entry.sender ?? senderId ?? "").trim() || "bot";

  if (!text && !reasoning && parts.length === 0) {
    return null;
  }

  return {
    sender_id: senderId,
    sender_name: senderName,
    text,
    reasoning,
    parts,
    created_at: entry.created_at ?? entry.time ?? null,
    created_at_ms: parseTimestampMs(entry.created_at ?? entry.time),
  };
}

function selectReplyCandidate(
  entries: ReplyCandidate[],
  options: ReplySelectionOptions = {},
) {
  const normalizedInput = String(options.inputText ?? "").trim();
  const normalizedSenderId = String(options.senderId ?? "").trim();
  const normalizedSenderName = String(options.senderName ?? "").trim();
  const notBeforeMs =
    typeof options.notBeforeMs === "number" && Number.isFinite(options.notBeforeMs)
      ? options.notBeforeMs - 2000
      : null;

  let relevantEntries =
    notBeforeMs === null
      ? entries
      : entries.filter(
          (entry) => entry.created_at_ms === null || entry.created_at_ms >= notBeforeMs,
        );

  let lastUserIndex = -1;
  for (let index = relevantEntries.length - 1; index >= 0; index -= 1) {
    const entry = relevantEntries[index];
    const sameText = normalizedInput && entry.text.trim() === normalizedInput;
    const sameSenderId = normalizedSenderId && entry.sender_id === normalizedSenderId;
    const sameSenderName = normalizedSenderName && entry.sender_name === normalizedSenderName;
    if (sameText || sameSenderId || sameSenderName) {
      lastUserIndex = index;
      break;
    }
  }

  const replyEntries = relevantEntries
    .slice(lastUserIndex + 1)
    .filter((entry) => {
      if (!entry.text && !entry.reasoning && entry.parts.length === 0) {
        return false;
      }
      if (normalizedInput && entry.text.trim() === normalizedInput) {
        return false;
      }
      if (normalizedSenderId && entry.sender_id === normalizedSenderId && !entry.reasoning) {
        return false;
      }
      if (normalizedSenderName && entry.sender_name === normalizedSenderName && !entry.reasoning) {
        return false;
      }
      return !isMetricsMessage(entry.text);
    });

  const selected = replyEntries.at(-1) ?? null;

  return {
    reply: selected
      ? {
          sender_id: selected.sender_id,
          sender_name: selected.sender_name,
          text: selected.text,
          reasoning: selected.reasoning,
          parts: selected.parts,
          created_at: selected.created_at,
        }
      : null,
    reply_count: replyEntries.length,
    raw_bot_message_count: relevantEntries.slice(lastUserIndex + 1).length,
  };
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

export function extractReplyFromHistory(
  history: Record<string, unknown>[],
  options: ReplySelectionOptions = {},
) {
  const normalized = history
    .map((entry) => normalizeReplyCandidate(entry))
    .filter((entry): entry is ReplyCandidate => Boolean(entry));
  return selectReplyCandidate(normalized, options);
}

async function waitForReplyHistory(
  runtime: Runtime,
  target: { platformId: string; userId: string } | null,
  options: {
    waitSeconds: number;
    pollIntervalSeconds: number;
    pageSize: number;
    inputText?: string;
    senderId?: string;
    senderName?: string;
    notBeforeMs?: number;
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
    const extracted = extractReplyFromHistory(history, options);
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
    const extracted = extractReplyFromHistory(history, options);
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
    ...extractReplyFromHistory(history, options),
    history,
    found: false,
    checks,
    reason: "timeout" as const,
  };
}

function collectMessageLikeRecords(
  value: unknown,
  output: Record<string, unknown>[],
  visited = new Set<object>(),
  depth = 0,
) {
  if (depth > 10 || value === null || value === undefined) {
    return;
  }

  const parsed = maybeParseJson(value);
  if (parsed !== value) {
    collectMessageLikeRecords(parsed, output, visited, depth + 1);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMessageLikeRecords(item, output, visited, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }
  if (visited.has(record)) {
    return;
  }
  visited.add(record);

  const hasSenderContext =
    "sender_id" in record ||
    "sender_name" in record ||
    "user_id" in record ||
    "display_name" in record ||
    "sender" in record;

  if (
    ((Array.isArray(record.content) ||
      Array.isArray(record.message_chain) ||
      Array.isArray(record.parts) ||
      typeof record.plain_text === "string") &&
      hasSenderContext) ||
    (typeof record.message === "string" &&
      hasSenderContext) ||
    (typeof record.text === "string" &&
      hasSenderContext)
  ) {
    output.push(record);
  }

  for (const nested of Object.values(record)) {
    collectMessageLikeRecords(nested, output, visited, depth + 1);
  }
}

function collectLogLikeEntries(
  value: unknown,
  output: unknown[],
  visited = new Set<object>(),
  depth = 0,
) {
  if (depth > 10 || value === null || value === undefined) {
    return;
  }

  const parsed = maybeParseJson(value);
  if (parsed !== value) {
    collectLogLikeEntries(parsed, output, visited, depth + 1);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLogLikeEntries(item, output, visited, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }
  if (visited.has(record)) {
    return;
  }
  visited.add(record);

  if (
    typeof record.data === "string" ||
    typeof record.message === "string" ||
    (typeof record.text === "string" && String(record.text).includes("ltm |"))
  ) {
    output.push(record);
  }

  for (const nested of Object.values(record)) {
    collectLogLikeEntries(nested, output, visited, depth + 1);
  }
}

function unwrapToolInvokePayloads(payload: unknown): unknown[] {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.results)) {
    return [];
  }

  const unwrapped: unknown[] = [];
  for (const result of record.results) {
    const resultRecord = asRecord(result);
    if (!resultRecord || !Array.isArray(resultRecord.content)) {
      continue;
    }
    for (const entry of resultRecord.content) {
      const contentRecord = asRecord(entry);
      if (!contentRecord) {
        continue;
      }
      if ("structured_content" in contentRecord) {
        unwrapped.push(contentRecord.structured_content);
      }
      if (typeof contentRecord.text === "string") {
        unwrapped.push(maybeParseJson(contentRecord.text));
      }
      const raw = asRecord(contentRecord.raw);
      if (raw) {
        if ("structuredContent" in raw) {
          unwrapped.push(raw.structuredContent);
        }
        if (typeof raw.text === "string") {
          unwrapped.push(maybeParseJson(raw.text));
        }
      }
    }
  }
  return unwrapped;
}

export function extractReplyFromPlatformSessionPayload(
  payload: unknown,
  options: ReplySelectionOptions & { sessionNeedle?: string } = {},
) {
  const unwrappedPayloads = unwrapToolInvokePayloads(payload);
  const sources = unwrappedPayloads.length > 0 ? unwrappedPayloads : [payload];
  const messageRecords: Record<string, unknown>[] = [];
  for (const candidate of sources) {
    collectMessageLikeRecords(candidate, messageRecords);
  }
  const normalizedMessages = messageRecords
    .map((entry) => normalizeReplyCandidate(entry))
    .filter((entry): entry is ReplyCandidate => Boolean(entry));
  const selected = selectReplyCandidate(normalizedMessages, options);
  if (selected.reply) {
    return {
      ...selected,
      logs: [] as unknown[],
    };
  }

  const logs: unknown[] = [];
  for (const candidate of sources) {
    collectLogLikeEntries(candidate, logs);
  }
  return {
    reply: extractReplyFromSessionLogs(logs, options),
    reply_count: selected.reply_count,
    raw_bot_message_count: selected.raw_bot_message_count,
    logs,
  };
}

async function invokePlatformSessionCapture(
  runtime: Runtime,
  target: { targetId: string; platformId?: string; messageType?: string },
  options: {
    waitSeconds: number;
    pollIntervalSeconds: number;
    maxEntries: number;
    inputText?: string;
    senderId?: string;
    senderName?: string;
    sessionNeedle?: string;
    notBeforeMs?: number;
  },
): Promise<{
  reply: {
    sender_id?: string;
    sender_name: string;
    text: string;
    reasoning: string;
    parts: unknown[];
    created_at: unknown;
  } | null;
  logs: unknown[];
  checks: number;
  reason: "unavailable" | "disabled" | "reply_found" | "timeout";
}> {
  if (!target.targetId) {
    return {
      reply: null,
      logs: [],
      checks: 0,
      reason: "unavailable",
    };
  }

  const fetchPayload = async (waitSeconds: number) =>
    runtime.gateway.request("POST", `/tools/${encodeSegment("get_platform_session_messages")}/invoke`, {
      body: {
        arguments: {
          target_id: target.targetId,
          platform_id: target.platformId,
          message_type: target.messageType,
          wait_seconds: waitSeconds,
          max_messages: options.maxEntries,
          poll_interval_seconds: options.pollIntervalSeconds,
        },
        capture_messages: true,
        response_timeout_seconds: Math.max(5, waitSeconds + 5),
      },
    });

  if (options.waitSeconds <= 0) {
    try {
      const payload = await fetchPayload(0);
      const extracted = extractReplyFromPlatformSessionPayload(payload, options);
      return {
        reply: extracted.reply,
        logs: extracted.logs,
        checks: 1,
        reason: extracted.reply ? "reply_found" : "disabled",
      };
    } catch {
      return {
        reply: null,
        logs: [],
        checks: 1,
        reason: "unavailable",
      };
    }
  }

  const deadline = Date.now() + options.waitSeconds * 1000;
  let checks = 0;
  let logs: unknown[] = [];

  while (Date.now() <= deadline) {
    const remainingMs = deadline - Date.now();
    const stepSeconds = Math.max(
      0,
      Math.min(options.pollIntervalSeconds, Math.ceil(remainingMs / 1000)),
    );

    try {
      const payload = await fetchPayload(stepSeconds);
      const extracted = extractReplyFromPlatformSessionPayload(payload, options);
      checks += 1;
      logs = extracted.logs;
      if (extracted.reply) {
        return {
          reply: extracted.reply,
          logs,
          checks,
          reason: "reply_found",
        };
      }
    } catch {
      return {
        reply: null,
        logs: [],
        checks,
        reason: "unavailable",
      };
    }

    if (Date.now() >= deadline) {
      break;
    }
  }

  return {
    reply: null,
    logs,
    checks,
    reason: "timeout",
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
  return extractLogEntries(payload);
}

function extractReplyFromSessionLogs(logs: unknown[], options: {
  sessionNeedle?: string;
  inputText?: string;
  senderId?: string;
  senderName?: string;
  notBeforeMs?: number;
}) {
  const normalizedSessionNeedle = String(options.sessionNeedle ?? "").trim();
  const normalizedInput = String(options.inputText ?? "").trim();
  const normalizedSenderId = String(options.senderId ?? "").trim();
  const normalizedSenderName = String(options.senderName ?? "").trim();
  const notBeforeMs =
    typeof options.notBeforeMs === "number" && Number.isFinite(options.notBeforeMs)
      ? options.notBeforeMs - 2000
      : null;

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const text = coerceLogText(logs[index]);
    if (!text || !text.includes("ltm |")) {
      continue;
    }
    if (normalizedSessionNeedle && !text.includes(normalizedSessionNeedle)) {
      continue;
    }
    const record = asRecord(logs[index]);
    const logTimeMs = parseTimestampMs(record?.time);
    if (notBeforeMs !== null && logTimeMs !== null && logTimeMs < notBeforeMs) {
      continue;
    }
    const match = text.match(/ltm \| (?<session>.+?) \| \[(?<sender>.+?)\/\d{2}:\d{2}:\d{2}\]:\s*(?<body>.*)$/);
    if (!match?.groups) {
      continue;
    }
    const body = String(match.groups.body ?? "").trim();
    const sender = String(match.groups.sender ?? "").trim();
    if (!body || body === normalizedInput) {
      continue;
    }
    if (normalizedSenderName && sender === normalizedSenderName) {
      continue;
    }
    return {
      sender_name: sender || "bot",
      text: body,
      reasoning: "",
      parts: body ? [{ type: "plain", text: body }] : [],
      created_at: null,
    };
  }
  return null;
}

function findReplyFromSendLogs(logs: unknown[], options: {
  inputText?: string;
  senderId?: string;
  senderName?: string;
  notBeforeMs?: number;
}) {
  const normalizedInput = String(options.inputText ?? "").trim();
  const normalizedSenderId = String(options.senderId ?? "").trim();
  const normalizedSenderName = String(options.senderName ?? "").trim();
  const notBeforeMs =
    typeof options.notBeforeMs === "number" && Number.isFinite(options.notBeforeMs)
      ? options.notBeforeMs - 2000
      : null;
  const senderNeedle =
    normalizedSenderId && normalizedSenderName
      ? `Prepare to send - ${normalizedSenderId}/${normalizedSenderName}:`
      : normalizedSenderId
        ? `Prepare to send - ${normalizedSenderId}/`
        : "";

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const text = coerceLogText(logs[index]);
    if (!text || !text.includes("Prepare to send - ")) {
      continue;
    }
    if (senderNeedle && !text.includes(senderNeedle)) {
      continue;
    }
    const record = asRecord(logs[index]);
    const logTimeMs = parseTimestampMs(record?.time);
    if (notBeforeMs !== null && logTimeMs !== null && logTimeMs < notBeforeMs) {
      continue;
    }
    const match = text.match(/Prepare to send - (?<target>.+?):\s*(?<body>.*)$/);
    if (!match?.groups) {
      continue;
    }
    const body = String(match.groups.body ?? "").trim();
    if (!body || body === normalizedInput || isMetricsMessage(body)) {
      continue;
    }
    return {
      reply: {
        sender_name: "bot",
        text: body,
        reasoning: "",
        parts: body ? [{ type: "plain", text: body }] : [],
        created_at: record?.time ?? null,
      },
      log: logs[index],
    };
  }

  return null;
}

export async function waitForReplyLogs(
  runtime: Runtime,
  options: {
    sessionNeedle?: string;
    inputText?: string;
    senderId?: string;
    senderName?: string;
    notBeforeMs?: number;
    waitSeconds: number;
    pollIntervalSeconds: number;
    maxEntries: number;
  },
): Promise<{
  reply: {
    sender_name: string;
    text: string;
    reasoning: string;
    parts: unknown[];
    created_at: unknown;
  } | null;
  logs: unknown[];
  checks: number;
  reason: "unavailable" | "disabled" | "reply_found" | "timeout";
}> {
  const sessionNeedle = String(options.sessionNeedle ?? "").trim();
  const fetchScopedLogs = async (waitSeconds: number) => {
    if (!sessionNeedle) {
      return [] as unknown[];
    }
    const payload = await runtime.gateway.request("GET", "/logs/history", {
      query: {
        wait_seconds: waitSeconds,
        limit: options.maxEntries,
        contains: sessionNeedle,
      },
    });
    return extractLogEntries(payload);
  };
  const fetchGlobalLogs = async (waitSeconds: number) => {
    const payload = await runtime.gateway.request("GET", "/logs/history", {
      query: {
        wait_seconds: waitSeconds,
        limit: options.maxEntries,
      },
    });
    return extractLogEntries(payload);
  };

  if (options.waitSeconds <= 0) {
    const scopedLogs = await fetchScopedLogs(0);
    const globalLogs = await fetchGlobalLogs(0);
    const sessionReply = extractReplyFromSessionLogs(scopedLogs, options);
    const sendReply = findReplyFromSendLogs(globalLogs, options);
    return {
      reply: sessionReply ?? sendReply?.reply ?? null,
      logs:
        sessionReply
          ? scopedLogs
          : sendReply
            ? [sendReply.log]
            : scopedLogs.length > 0
              ? scopedLogs
              : globalLogs,
      checks: 1,
      reason: "disabled",
    };
  }

  const deadline = Date.now() + options.waitSeconds * 1000;
  let checks = 0;
  let logs: unknown[] = [];

  while (Date.now() <= deadline) {
    const remainingMs = deadline - Date.now();
    const stepSeconds = Math.max(
      0,
      Math.min(options.pollIntervalSeconds, Math.ceil(remainingMs / 1000)),
    );
    const scopedLogs = await fetchScopedLogs(stepSeconds);
    const globalLogs = await fetchGlobalLogs(0);
    checks += 1;
    const sessionReply = extractReplyFromSessionLogs(scopedLogs, options);
    const sendReply = findReplyFromSendLogs(globalLogs, options);
    const reply = sessionReply ?? sendReply?.reply ?? null;
    logs =
      sessionReply
        ? scopedLogs
        : sendReply
          ? [sendReply.log]
          : scopedLogs.length > 0
            ? scopedLogs
            : globalLogs;
    if (reply) {
      return {
        reply,
        logs,
        checks,
        reason: "reply_found",
      };
    }
    if (Date.now() >= deadline) {
      break;
    }
  }

  return {
    reply: null,
    logs,
    checks,
    reason: "timeout",
  };
}

function createTraceId() {
  return `trigger-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildTriggerStatus(args: {
  traceId: string;
  accepted: boolean;
  eventId: string | null;
  injection: Record<string, unknown>;
  watch: EventWatchResult;
  replyLookup: { reply: unknown | null; checks: number; reason: string };
  platformReplyLookup: { reply: unknown | null; checks: number; reason: string };
  logReplyLookup: { reply: unknown | null; checks: number; reason: string };
  finalReplySource: "history" | "platform" | "logs" | null;
}) {
  return {
    trace_id: args.traceId,
    injection: {
      accepted: args.accepted,
      event_id: args.eventId,
      platform_id: args.injection.platform_id ?? null,
      message_type: args.injection.message_type ?? null,
      unified_msg_origin: args.injection.unified_msg_origin ?? null,
      conversation_id:
        args.injection.conversation_id ?? args.injection.display_conversation_id ?? null,
      session_id: args.injection.session_id ?? null,
      group_id: args.injection.group_id ?? null,
    },
    processing: {
      observed_event_logs: args.watch.rawLogs.length > 0,
      settled: args.watch.settled,
      reason: args.watch.reason,
      waited_seconds: args.watch.waitedSeconds,
      checks: args.watch.checks,
    },
    reply_capture: {
      found: Boolean(args.finalReplySource),
      source: args.finalReplySource,
      history: {
        found: Boolean(args.replyLookup.reply),
        checks: args.replyLookup.checks,
        reason: args.replyLookup.reason,
      },
      platform: {
        found: Boolean(args.platformReplyLookup.reply),
        checks: args.platformReplyLookup.checks,
        reason: args.platformReplyLookup.reason,
      },
      logs: {
        found: Boolean(args.logReplyLookup.reply),
        checks: args.logReplyLookup.checks,
        reason: args.logReplyLookup.reason,
      },
    },
  };
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
  const wakePrefixHint = runtime.hints.wakePrefix
    ? ` For this runtime, group command tests usually need the wake prefix "${runtime.hints.wakePrefix}".`
    : "";
  const sessionHint =
    " session_id may be any caller-chosen test session key. Reuse it to continue the same synthetic conversation, or create a new one when you want an isolated test run.";

  withToolErrorBoundary(
    registrar,
    {
      name: "trigger_message_reply",
      summary:
        `Inject an inbound message into AstrBot, wait for reply processing to settle, and return the captured reply together with staged status.${wakePrefixHint}${sessionHint}`,
      category: "messages",
      minMode: "minimize",
      risk: "safe-write",
      aliases: ["send-message", "chat-with-bot", "trigger-reply", "inject-message", "send-with-logs"],
    },
    {
      message: z.string().optional().describe("Plain text inbound message to inject."),
      message_chain: z.array(messagePartSchema).optional().describe("Structured inbound message chain when plain text is not enough."),
      sender_id: z.string().default("mcp-test").describe("Synthetic sender id for the injected user message."),
      display_name: z.string().optional().describe("Optional display name shown for the synthetic sender."),
      unified_msg_origin: z.string().optional().describe("Fully qualified AstrBot origin. Use this only when you already know the exact runtime origin string."),
      platform_id: z.string().optional().describe("Target platform id such as webchat or napcat."),
      message_type: z.string().optional().describe("Platform message type such as FriendMessage or GroupMessage."),
      session_id: z.string().optional().describe("Conversation/session key. For tests you may create any new session_id yourself. Reuse the same id to continue a synthetic conversation. For group chats this is usually the group id."),
      group_id: z.string().optional().describe("Group target id. For GroupMessage tests this should usually be the real group id."),
      conversation_id: z.string().optional().describe("Webchat conversation id. You may create a new one yourself for isolated webchat tests, or reuse an existing one to continue that webchat session."),
      llm: llmConfigSchema,
      response_timeout_seconds: z.number().min(1).max(600).default(120).describe("AstrBot reply timeout for the injected event itself."),
      show_in_webui: z.boolean().default(true).describe("When true, keep the injected conversation visible in WebUI/webchat where supported."),
      include_logs: z.boolean().default(true).describe("Return simplified compact logs together with the reply. Disable this for the shortest response."),
      include_debug: z.boolean().default(false).describe("Include internal debug metadata such as injection routing and reply lookup details."),
      wait_seconds: z.number().int().min(0).max(180).default(15).describe("How long MCP should wait for event settlement and reply capture."),
      quiet_window_seconds: z.number().int().min(1).max(30).default(2).describe("Consider the event settled after logs stay unchanged for this many seconds."),
      poll_interval_seconds: z.number().int().min(1).max(10).default(1).describe("Polling interval used while waiting for event completion and reply capture."),
      max_entries: z.number().int().min(1).max(1000).default(200).describe("Maximum logs/history entries to inspect while waiting."),
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
      const requestStartedAt = Date.now();
      const traceId = createTraceId();
      const inputText = message ?? extractPlainTextFromParts(message_chain);

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
          trace_id: traceId,
          event_id: null,
          reply_found: false,
          reply: null,
          reply_source: null,
        };
        if (resolvedIncludeLogs) {
          result.logs = [];
        }
        result.status = buildTriggerStatus({
          traceId,
          accepted: false,
          eventId: null,
          injection,
          watch: {
            rawLogs: [],
            logs: [],
            waitedSeconds: 0,
            settled: false,
            reason: "disabled",
            checks: 0,
          },
          replyLookup: { reply: null, checks: 0, reason: "disabled" },
          platformReplyLookup: { reply: null, checks: 0, reason: "disabled" },
          logReplyLookup: { reply: null, checks: 0, reason: "disabled" },
          finalReplySource: null,
        });
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
      const remainingWaitSeconds = Math.max(0, resolvedWaitSeconds - watch.waitedSeconds);
      const replyLookup = await waitForReplyHistory(runtime, historyTarget, {
        waitSeconds: remainingWaitSeconds,
        pollIntervalSeconds: resolvedPollIntervalSeconds,
        pageSize: Math.min(resolvedMaxEntries, 100),
        inputText,
        senderId: resolvedSenderId,
        senderName: display_name ?? resolvedSenderId,
        notBeforeMs: requestStartedAt,
      });
      const platformReplyLookup =
        replyLookup.reply
          ? {
              reply: null,
              logs: [] as unknown[],
              checks: 0,
              reason: "disabled" as const,
            }
          : await invokePlatformSessionCapture(
              runtime,
              {
                targetId: String(
                  injection.group_id ??
                    injection.session_id ??
                    injection.conversation_id ??
                    injection.display_conversation_id ??
                    group_id ??
                    session_id ??
                    normalizedConversationId ??
                    historyTarget?.userId ??
                    "",
                ).trim(),
                platformId: String(injection.platform_id ?? platform_id ?? historyTarget?.platformId ?? "").trim() || undefined,
                messageType: String(injection.message_type ?? message_type ?? "").trim() || undefined,
              },
              {
                sessionNeedle: String(injection.unified_msg_origin ?? ""),
                inputText,
                senderId: resolvedSenderId,
                senderName: display_name ?? resolvedSenderId,
                waitSeconds: remainingWaitSeconds,
                pollIntervalSeconds: resolvedPollIntervalSeconds,
                maxEntries: Math.min(resolvedMaxEntries, 100),
                notBeforeMs: requestStartedAt,
              },
            );
      const logReplyLookup =
        replyLookup.reply || platformReplyLookup.reply || String(injection.platform_id ?? "") === "webchat"
          ? {
              reply: null,
              logs: [] as unknown[],
              checks: 0,
              reason: "disabled" as const,
            }
          : await waitForReplyLogs(runtime, {
              sessionNeedle: String(injection.unified_msg_origin ?? ""),
              inputText,
              senderId: resolvedSenderId,
              senderName: display_name ?? resolvedSenderId,
              waitSeconds: remainingWaitSeconds,
              pollIntervalSeconds: resolvedPollIntervalSeconds,
              maxEntries: resolvedMaxEntries,
              notBeforeMs: requestStartedAt,
            });
      const finalReply =
        replyLookup.reply ?? platformReplyLookup.reply ?? logReplyLookup.reply;
      const finalReplySource =
        replyLookup.reply ? "history" : platformReplyLookup.reply ? "platform" : logReplyLookup.reply ? "logs" : null;

      const result: Record<string, unknown> = {
        trace_id: traceId,
        event_id: eventId,
        reply_found: Boolean(finalReply),
        reply_source: finalReplySource,
      };
      if (finalReply) {
        result.reply = finalReply.text;
        if (finalReply.reasoning) {
          result.reasoning = finalReply.reasoning;
        }
      } else {
        result.reply_found = false;
        result.reply = null;
      }
      result.status = buildTriggerStatus({
        traceId,
        accepted: true,
        eventId,
        injection,
        watch,
        replyLookup,
        platformReplyLookup,
        logReplyLookup,
        finalReplySource,
      });

      if (resolvedIncludeLogs && finalReplySource === "logs" && logReplyLookup.logs.length > 0) {
        result.logs = compactMessageToolLogs(
          compactOrRawLogs(runtime, logReplyLookup.logs, resolvedMaxEntries),
        );
      } else if (
        resolvedIncludeLogs &&
        finalReplySource === "platform" &&
        platformReplyLookup.logs.length > 0
      ) {
        result.logs = compactMessageToolLogs(
          compactOrRawLogs(runtime, platformReplyLookup.logs, resolvedMaxEntries),
        );
      } else if (resolvedIncludeLogs && watch.logs.length > 0) {
        result.logs = compactMessageToolLogs(watch.logs);
      } else if (resolvedIncludeLogs && platformReplyLookup.logs.length > 0) {
        result.logs = compactMessageToolLogs(
          compactOrRawLogs(runtime, platformReplyLookup.logs, resolvedMaxEntries),
        );
      } else if (resolvedIncludeLogs && logReplyLookup.logs.length > 0) {
        result.logs = compactMessageToolLogs(
          compactOrRawLogs(runtime, logReplyLookup.logs, resolvedMaxEntries),
        );
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
          platform_reply_checks: platformReplyLookup.checks,
          platform_reply_reason: platformReplyLookup.reason,
          log_reply_checks: logReplyLookup.checks,
          log_reply_reason: logReplyLookup.reason,
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
      summary: "Get persisted message history. For webchat, use conversation_id or target_id instead of sender_id. conversation_id can be a caller-created synthetic webchat session id if you injected messages into one.",
      category: "messages",
      minMode: "readonly",
      risk: "read",
      aliases: ["message-history"],
    },
    {
      platform_id: z.string().min(1).describe("Platform id such as webchat or napcat."),
      user_id: z.string().optional().describe("Underlying history key for non-webchat platforms."),
      target_id: z.string().optional().describe("Alias of user_id for non-webchat platforms, or alias of conversation_id for webchat."),
      conversation_id: z.string().optional().describe("Webchat conversation id. This may be a caller-created synthetic id used earlier with trigger_message_reply."),
      page: z.number().int().min(1).default(1).describe("1-based history page number."),
      page_size: z.number().int().min(1).max(500).default(50).describe("Number of history records per page."),
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
