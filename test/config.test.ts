import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";

test("loadConfig requires gateway token", () => {
  const old = process.env.ASTRBOT_GATEWAY_TOKEN;
  delete process.env.ASTRBOT_GATEWAY_TOKEN;
  assert.throws(() => loadConfig(), /ASTRBOT_GATEWAY_TOKEN is required/);
  if (old !== undefined) {
    process.env.ASTRBOT_GATEWAY_TOKEN = old;
  }
});

test("loadConfig uses gateway-only defaults", () => {
  const snapshot = {
    ASTRBOT_GATEWAY_TOKEN: process.env.ASTRBOT_GATEWAY_TOKEN,
    ASTRBOT_CAPABILITY_MODE: process.env.ASTRBOT_CAPABILITY_MODE,
    ASTRBOT_ENABLE_SEARCH_TOOLS: process.env.ASTRBOT_ENABLE_SEARCH_TOOLS,
    ASTRBOT_LOG_VIEW: process.env.ASTRBOT_LOG_VIEW,
    ASTRBOT_ENABLE_LOG_NOISE_FILTERING: process.env.ASTRBOT_ENABLE_LOG_NOISE_FILTERING,
  };

  process.env.ASTRBOT_GATEWAY_TOKEN = "test-token";
  delete process.env.ASTRBOT_CAPABILITY_MODE;
  delete process.env.ASTRBOT_ENABLE_SEARCH_TOOLS;
  delete process.env.ASTRBOT_LOG_VIEW;
  delete process.env.ASTRBOT_ENABLE_LOG_NOISE_FILTERING;

  const config = loadConfig();
  assert.equal(config.gatewayUrl, "http://127.0.0.1:6324");
  assert.equal(config.capabilityMode, "full");
  assert.equal(config.enableSearchTools, false);
  assert.equal(config.logView, "compact");
  assert.equal(config.enableLogNoiseFiltering, true);

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});
