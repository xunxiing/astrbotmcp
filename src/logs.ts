import { truncate } from "./utils.js";

export interface CompactLogEntry {
  time: string | null;
  level: string;
  component: string | null;
  message: string;
  eventId: string | null;
  sessionId: string | null;
  messageId: string | null;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const NOISE_PATTERNS = [
  /keep-alive/i,
  /heartbeat/i,
  /polling/i,
  /GET \/logs\/history/i,
  /GET \/logs\/compact/i,
  /GET \/logs\/stream/i,
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function coerceText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function cleanMessage(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(/\s+/g, " ").trim();
}

function isNoise(entry: CompactLogEntry): boolean {
  if (["DEBUG", "TRACE"].includes(entry.level.toUpperCase())) {
    return true;
  }
  return NOISE_PATTERNS.some((pattern) => pattern.test(entry.message));
}

function compactOne(raw: unknown): CompactLogEntry {
  if (typeof raw === "string") {
    return {
      time: null,
      level: "INFO",
      component: null,
      message: cleanMessage(raw),
      eventId: null,
      sessionId: null,
      messageId: null,
    };
  }

  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const message = cleanMessage(
    coerceText(record.data ?? record.message ?? record.msg ?? record.text),
  );
  return {
    time: record.time ? coerceText(record.time) : null,
    level: coerceText(record.level || "INFO").toUpperCase(),
    component: record.component ? coerceText(record.component) : null,
    message: truncate(message, 600),
    eventId: record.event_id ? coerceText(record.event_id) : null,
    sessionId: record.session_id ? coerceText(record.session_id) : null,
    messageId: record.message_id ? coerceText(record.message_id) : null,
  };
}

export interface CompactLogsOptions {
  enableNoiseFiltering: boolean;
  maxEntries?: number;
}

export function extractLogEntries(payload: unknown, depth = 0): unknown[] {
  if (depth > 4 || payload === null || payload === undefined) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }

  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  for (const key of ["logs", "history", "entries", "items", "events"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  for (const key of ["data", "payload", "result"]) {
    if (!(key in record)) {
      continue;
    }
    const nested = extractLogEntries(record[key], depth + 1);
    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
}

export function compactLogs(
  rawLogs: unknown[],
  options: CompactLogsOptions,
): CompactLogEntry[] {
  const maxEntries = options.maxEntries ?? 200;
  const compacted: CompactLogEntry[] = [];
  let previousFingerprint = "";

  for (const raw of rawLogs) {
    const entry = compactOne(raw);
    if (!entry.message) {
      continue;
    }
    if (options.enableNoiseFiltering && isNoise(entry)) {
      continue;
    }
    const fingerprint = `${entry.level}|${entry.component}|${entry.message}`;
    if (fingerprint === previousFingerprint) {
      continue;
    }
    previousFingerprint = fingerprint;
    compacted.push(entry);
  }

  return compacted.slice(-maxEntries);
}

export interface LogNeedles {
  eventId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
}

export function filterLogsByNeedles(
  rawLogs: unknown[],
  needles: LogNeedles,
): unknown[] {
  const values = [needles.eventId, needles.sessionId, needles.messageId]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  if (values.length === 0) {
    return rawLogs;
  }

  return rawLogs.filter((entry) => {
    const text = JSON.stringify(entry).toLowerCase();
    return values.some((value) => text.includes(value));
  });
}

export function filterLogsByContains(rawLogs: unknown[], contains?: string | null): unknown[] {
  const normalized = typeof contains === "string" ? contains.trim().toLowerCase() : "";
  if (!normalized) {
    return rawLogs;
  }

  return rawLogs.filter((entry) => JSON.stringify(entry).toLowerCase().includes(normalized));
}
