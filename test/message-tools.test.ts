import test from "node:test";
import assert from "node:assert/strict";

import { waitForEventToSettle } from "../src/message-tools.js";
import { compactOrRawLogs, Runtime } from "../src/tooling.js";

function createRuntime(handler: (waitSeconds: number) => unknown): Runtime {
  return {
    config: {
      gatewayUrl: "http://127.0.0.1:6324",
      gatewayToken: "test-token",
      gatewayTimeout: 30_000,
      capabilityMode: "full",
      enableSearchTools: false,
      logView: "compact",
      enableLogNoiseFiltering: true,
    },
    gateway: {
      request: async (_method: string, _path: string, options?: { query?: Record<string, unknown> }) =>
        handler(Number(options?.query?.wait_seconds ?? 0)),
    },
  } as Runtime;
}

test("waitForEventToSettle returns immediate logs when waiting is disabled", async () => {
  const runtime = createRuntime(() => ({
    logs: [{ level: "INFO", data: "reply ready", event_id: "evt-1" }],
  }));

  const result = await waitForEventToSettle(runtime, "evt-1", {
    maxEntries: 20,
    waitSeconds: 0,
    quietWindowSeconds: 2,
    pollIntervalSeconds: 1,
  });

  assert.equal(result.reason, "disabled");
  assert.equal(result.waitedSeconds, 0);
  assert.equal(result.rawLogs.length, 1);
  assert.equal((result.logs[0] as { message?: string })?.message, "reply ready");
});

test("waitForEventToSettle waits until event logs become quiet", async () => {
  const originalNow = Date.now;
  let nowMs = 1_000_000;
  let callCount = 0;
  Date.now = () => nowMs;

  try {
    const runtime = createRuntime((waitSeconds) => {
      nowMs += waitSeconds * 1000;
      callCount += 1;
      return {
        logs: [{ level: "INFO", data: "reply chunk", event_id: "evt-2", seq: 1 }],
      };
    });

    const result = await waitForEventToSettle(runtime, "evt-2", {
      maxEntries: 20,
      waitSeconds: 4,
      quietWindowSeconds: 1,
      pollIntervalSeconds: 1,
    });

    assert.equal(result.reason, "quiet_window");
    assert.equal(result.settled, true);
    assert.equal(result.checks, 2);
    assert.equal(result.waitedSeconds, 2);
    assert.equal(callCount, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("waitForEventToSettle times out when logs keep changing", async () => {
  const originalNow = Date.now;
  let nowMs = 2_000_000;
  let seq = 0;
  Date.now = () => nowMs;

  try {
    const runtime = createRuntime((waitSeconds) => {
      nowMs += waitSeconds * 1000;
      seq += 1;
      return {
        logs: [{ level: "INFO", data: `reply chunk ${seq}`, event_id: "evt-3", seq }],
      };
    });

    const result = await waitForEventToSettle(runtime, "evt-3", {
      maxEntries: 20,
      waitSeconds: 2,
      quietWindowSeconds: 2,
      pollIntervalSeconds: 1,
    });

    assert.equal(result.reason, "timeout");
    assert.equal(result.settled, false);
    assert.equal(result.checks, 2);
    assert.equal((result.logs.at(-1) as { message?: string })?.message, "reply chunk 2");
  } finally {
    Date.now = originalNow;
  }
});

test("compactOrRawLogs falls back when noise filtering removes every entry", () => {
  const runtime = createRuntime(() => ({ logs: [] }));

  const result = compactOrRawLogs(
    runtime,
    [{ level: "DEBUG", data: "keep-alive", event_id: "evt-4" }],
    20,
  );

  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 1);
});
