import test from "node:test";
import assert from "node:assert/strict";

import {
  compactPluginConfigPayload,
  compactPluginDetailsPayload,
  compactPluginListPayload,
} from "../src/plugin-tools.js";

test("compactPluginListPayload removes handler noise and keeps plugin summary", () => {
  const result = compactPluginListPayload({
    items: [
      {
        name: "demo-plugin",
        display_name: "Demo Plugin",
        author: "Codex",
        desc: "demo",
        version: "v1.0.0",
        repo: "https://example.com/demo-plugin",
        activated: true,
        reserved: false,
        has_config: true,
        handlers: [
          { type: "command", cmd: "demo", desc: "run demo" },
          { type: "scheduled", cmd: "auto" },
        ],
      },
    ],
    failed_plugin_info: " failed ",
  });

  assert.deepEqual(result, {
    items: [
      {
        name: "demo-plugin",
        display_name: "Demo Plugin",
        author: "Codex",
        desc: "demo",
        version: "v1.0.0",
        repo: "https://example.com/demo-plugin",
        activated: true,
        configurable: true,
        command_count: 1,
        handler_count: 2,
      },
    ],
    failed_plugin_info: "failed",
  });
});

test("compactPluginDetailsPayload separates commands from config", () => {
  const result = compactPluginDetailsPayload({
    name: "demo-plugin",
    author: "Codex",
    desc: "demo",
    version: "v1.0.0",
    repo: "https://example.com/demo-plugin",
    activated: true,
    has_config: true,
    reserved: false,
    root_dir_name: "demo-plugin",
    module_path: "data.plugins.demo-plugin.main",
    handlers: [
      { type: "command", cmd: "demo", desc: "run demo", has_admin: true },
      { type: "scheduled", cmd: "auto", handler_name: "tick", event_type_h: "load" },
    ],
    config: { secret: "should-not-leak-here" },
  });

  assert.deepEqual(result, {
    name: "demo-plugin",
    author: "Codex",
    desc: "demo",
    version: "v1.0.0",
    repo: "https://example.com/demo-plugin",
    activated: true,
    configurable: true,
    root_dir_name: "demo-plugin",
    module_path: "data.plugins.demo-plugin.main",
    command_count: 1,
    handler_count: 2,
    commands: [
      {
        cmd: "demo",
        desc: "run demo",
        admin: true,
      },
    ],
  });
});

test("compactPluginConfigPayload returns full config object for editing", () => {
  const result = compactPluginConfigPayload(
    {
      plugin: "demo-plugin",
      value: { token: "secret", enable: true },
      schema: { token: { type: "string" } },
    },
    { includeSchema: true, redactSecrets: false },
  );

  assert.deepEqual(result, {
    plugin: "demo-plugin",
    config: { token: "secret", enable: true },
    schema: { token: { type: "string" } },
  });
});
