import test from "node:test";
import assert from "node:assert/strict";

import { buildInstructions, loadRuntimeHints } from "../src/runtime-hints.js";

test("loadRuntimeHints unwraps gateway config values", async () => {
  const gateway = {
    request: async (_method: string, _path: string, options?: { query?: Record<string, unknown> }) => {
      const configPath = String(options?.query?.path ?? "");
      if (configPath === "wake_prefix") {
        return { value: ["中文前缀", "550c", "@550c"] };
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

test("buildInstructions includes wake prefix and plugin config workflow guidance", () => {
  const text = buildInstructions({
    wakePrefix: "550c",
    friendMessageNeedsWakePrefix: false,
    replyPrefix: null,
  });

  assert.match(text, /550c/);
  assert.match(text, /Friend and webchat style messages usually do not require the wake prefix/);
  assert.match(text, /get_plugin_config_file/);
  assert.match(text, /replace_plugin_config_file/);
  assert.match(text, /auto-reloads? the plugin/i);
});
