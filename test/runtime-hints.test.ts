import test from "node:test";
import assert from "node:assert/strict";

import { buildInstructions, loadRuntimeHints } from "../src/runtime-hints.js";

test("loadRuntimeHints unwraps gateway config values", async () => {
  const gateway = {
    request: async (_method: string, _path: string, options?: { query?: Record<string, unknown> }) => {
      const configPath = String(options?.query?.path ?? "");
      if (configPath === "wake_prefix") {
        return { value: ["帕厄托", "550c", "@550c"] };
      }
      if (configPath === "platform_settings.friend_message_needs_wake_prefix") {
        return { value: false };
      }
      if (configPath === "platform_settings.reply_prefix") {
        return { value: "" };
      }
      return null;
    },
  };

  const hints = await loadRuntimeHints(gateway as never);
  assert.deepEqual(hints, {
    wakePrefix: "550c",
    friendMessageNeedsWakePrefix: false,
    replyPrefix: null,
  });
});

test("buildInstructions includes wake prefix guidance when exposed", () => {
  const text = buildInstructions({
    wakePrefix: "550c",
    friendMessageNeedsWakePrefix: false,
    replyPrefix: null,
  });

  assert.match(text, /550c今日老婆/);
  assert.match(text, /Friend and webchat style messages usually do not require the wake prefix/);
});
