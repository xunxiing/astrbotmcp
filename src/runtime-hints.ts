import { GatewayClient } from "./clients.js";

export interface RuntimeHints {
  wakePrefix: string | null;
  friendMessageNeedsWakePrefix: boolean | null;
  replyPrefix: string | null;
}

const DEFAULT_WAKE_PREFIX = "/";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function unwrapConfigValue(payload: unknown): unknown {
  const record = asRecord(payload);
  if (!record) {
    return payload;
  }
  if ("value" in record) {
    return unwrapConfigValue(record.value);
  }
  return payload;
}

function toOptionalString(value: unknown): string | null {
  const normalized = unwrapConfigValue(value);
  if (typeof normalized !== "string") {
    return null;
  }
  const trimmed = normalized.trim();
  return trimmed ? trimmed : null;
}

function toOptionalBoolean(value: unknown): boolean | null {
  const normalized = unwrapConfigValue(value);
  if (typeof normalized === "boolean") {
    return normalized;
  }
  if (typeof normalized !== "string") {
    return null;
  }
  const lowered = normalized.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(lowered)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(lowered)) {
    return false;
  }
  return null;
}

function toStringList(value: unknown): string[] {
  const normalized = unwrapConfigValue(value);
  if (typeof normalized === "string") {
    const single = normalized.trim();
    return single ? [single] : [];
  }
  if (!Array.isArray(normalized)) {
    return [];
  }
  return normalized
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectPreferredWakePrefix(values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }
  const plainAscii = values.find((item) => /^[A-Za-z0-9._-]+$/.test(item));
  if (plainAscii) {
    return plainAscii;
  }
  const nonMention = values.find((item) => !item.startsWith("@"));
  return nonMention ?? values[0] ?? null;
}

async function getCoreConfigPath(gateway: GatewayClient, path: string): Promise<unknown> {
  return gateway.request("GET", "/configs/core", {
    query: { path },
  });
}

export async function loadRuntimeHints(gateway: GatewayClient): Promise<RuntimeHints> {
  const [wakePrefix, friendMessageNeedsWakePrefix, replyPrefix] = await Promise.allSettled([
    getCoreConfigPath(gateway, "wake_prefix"),
    getCoreConfigPath(gateway, "platform_settings.friend_message_needs_wake_prefix"),
    getCoreConfigPath(gateway, "platform_settings.reply_prefix"),
  ]);

  const resolvedWakePrefix =
    wakePrefix.status === "fulfilled"
      ? selectPreferredWakePrefix(toStringList(wakePrefix.value)) ?? DEFAULT_WAKE_PREFIX
      : null;

  return {
    wakePrefix: resolvedWakePrefix,
    friendMessageNeedsWakePrefix:
      friendMessageNeedsWakePrefix.status === "fulfilled"
        ? toOptionalBoolean(friendMessageNeedsWakePrefix.value)
        : null,
    replyPrefix: replyPrefix.status === "fulfilled" ? toOptionalString(replyPrefix.value) : null,
  };
}

export function buildInstructions(hints: RuntimeHints): string {
  const lines = ["Use this MCP server for AstrBot runtime control through the REST gateway."];
  if (hints.wakePrefix) {
    lines.push(
      `Preferred wake prefix for MCP tests: "${hints.wakePrefix}". In group command tests, prepend it first when commands do not trigger.`,
    );
    lines.push(
      `Example: use "${hints.wakePrefix}今日老婆" instead of "今日老婆" when testing group handlers.`,
    );
  } else {
    lines.push("Runtime wake prefix is not exposed. If a group command does not trigger, inspect core config first.");
  }
  if (hints.friendMessageNeedsWakePrefix === false) {
    lines.push("Friend and webchat style messages usually do not require the wake prefix on this runtime.");
  } else if (hints.friendMessageNeedsWakePrefix === true) {
    lines.push("Friend messages also require the wake prefix on this runtime.");
  }
  if (hints.replyPrefix) {
    lines.push(`Current reply prefix: "${hints.replyPrefix}".`);
  }
  lines.push("Use trigger_message_reply for inbound message simulation and reply capture.");
  return lines.join(" ");
}
