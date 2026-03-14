import test from "node:test";
import assert from "node:assert/strict";

import {
  compactMessageToolLogs,
  extractReplyFromHistory,
  extractReplyFromPlatformSessionPayload,
  waitForEventToSettle,
  waitForReplyLogs,
} from "../src/message-tools.js";
import { RuntimeHints } from "../src/runtime-hints.js";
import { compactOrRawLogs, Runtime } from "../src/tooling.js";

const testHints: RuntimeHints = {
  wakePrefix: "550c",
  friendMessageNeedsWakePrefix: false,
  replyPrefix: null,
};

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
    hints: testHints,
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

test("compactMessageToolLogs strips logger prefix and keeps only message text", () => {
  const result = compactMessageToolLogs([
    {
      time: "1",
      level: "INFO",
      component: null,
      message: "[2026-03-14 15:05:38.700] [Core] [INFO] [respond.stage:184]: Prepare to send - mcp-test/mcp-test: hello",
      eventId: null,
      sessionId: null,
      messageId: null,
    },
  ]) as Array<Record<string, unknown>>;

  assert.deepEqual(result, [
    {
      message: "Prepare to send - mcp-test/mcp-test: hello",
    },
  ]);
});

test("extractReplyFromHistory supports gateway content array replies", () => {
  const history = [
    {
      sender_id: "mcp-test",
      sender_name: "mcp-test",
      content: [{ type: "text", data: { text: "550cwife" } }],
      created_at: "2026-03-14T06:12:21.000Z",
    },
    {
      sender_id: "3572245467",
      sender_name: "550c",
      content: [
        { type: "text", data: { text: "@user your wife today is:" } },
        { type: "file", data: { url: "https://example.com/wife.jpg" } },
      ],
      created_at: "2026-03-14T06:12:23.000Z",
    },
  ] as Array<Record<string, unknown>>;

  const result = extractReplyFromHistory(history, {
    inputText: "550cwife",
    senderId: "mcp-test",
    senderName: "mcp-test",
    notBeforeMs: Date.parse("2026-03-14T06:12:20.000Z"),
  });

  assert.equal(result.reply?.sender_name, "550c");
  assert.match(result.reply?.text ?? "", /wife today is/i);
  assert.match(result.reply?.text ?? "", /\[file\] https:\/\/example\.com\/wife\.jpg/);
});

test("extractReplyFromPlatformSessionPayload unwraps nested tool payload JSON", () => {
  const payload = {
    results: [
      {
        content: [
          {
            raw: {
              text: JSON.stringify({
                sse_events: [
                  {
                    data: [
                      {
                        sender_id: "3572245467",
                        sender_name: "550c",
                        content: [
                          { type: "text", data: { text: "@user your wife today is:" } },
                          { type: "file", data: { url: "https://example.com/wife.jpg" } },
                        ],
                        created_at: "2026-03-14T06:12:23.000Z",
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      },
    ],
  };

  const result = extractReplyFromPlatformSessionPayload(payload, {
    inputText: "550cwife",
    senderId: "mcp-test",
    senderName: "mcp-test",
    notBeforeMs: Date.parse("2026-03-14T06:12:20.000Z"),
  });

  assert.equal(result.reply?.sender_name, "550c");
  assert.match(result.reply?.text ?? "", /wife today is/i);
  assert.match(result.reply?.text ?? "", /\[file\] https:\/\/example\.com\/wife\.jpg/);
});

test("extractReplyFromHistory unwraps trace payloads into plain reply text", () => {
  const history = [
    {
      sender_id: "mcp-test",
      sender_name: "mcp-test",
      content: [{ type: "text", data: { text: "Please reply with exactly: concise smoke ok" } }],
      created_at: "2026-03-14T06:58:51.000Z",
    },
    {
      sender_id: "bot",
      sender_name: "bot",
      content: JSON.stringify({
        type: "trace",
        action: "astr_agent_complete",
        fields: {
          stats: {
            token_usage: { output: 30 },
          },
          resp: "concise smoke ok",
        },
      }),
      created_at: "2026-03-14T06:58:57.000Z",
    },
  ] as Array<Record<string, unknown>>;

  const result = extractReplyFromHistory(history, {
    inputText: "Please reply with exactly: concise smoke ok",
    senderId: "mcp-test",
    senderName: "mcp-test",
    notBeforeMs: Date.parse("2026-03-14T06:58:50.000Z"),
  });

  assert.equal(result.reply?.text, "concise smoke ok");
});

test("trigger fallback log parser can use prepare-to-send line shape", async () => {
  const runtime = {
    config: {
      gatewayUrl: "http://127.0.0.1:6324",
      gatewayToken: "test-token",
      gatewayTimeout: 30_000,
      capabilityMode: "full",
      enableSearchTools: false,
      logView: "compact",
      enableLogNoiseFiltering: true,
    },
    hints: testHints,
    gateway: {
      request: async (_method: string, path: string, options?: { query?: Record<string, unknown> }) => {
        if (path !== "/logs/history") {
          return { logs: [] };
        }
        if (options?.query?.contains) {
          return { logs: [] };
        }
        return {
          logs: [
            {
              level: "INFO",
              time: 1_800_000_001,
              data: "[2026-03-14 14:46:25.017] [Core] [INFO] [respond.stage:184]: Prepare to send - mcp-test/mcp-test: You already used 4 draws today. Come back tomorrow.",
            },
          ],
        };
      },
    },
  } as Runtime;

  const result = await waitForReplyLogs(runtime, {
    sessionNeedle: "napcat:GroupMessage:1030223077",
    inputText: "550cwife",
    senderId: "mcp-test",
    senderName: "mcp-test",
    notBeforeMs: 1_800_000_000_000,
    waitSeconds: 0,
    pollIntervalSeconds: 1,
    maxEntries: 50,
  });

  assert.equal(result.reply?.text, "You already used 4 draws today. Come back tomorrow.");
  assert.equal(result.logs.length, 1);
  assert.match(String((result.logs[0] as { data?: string }).data ?? ""), /Prepare to send - mcp-test\/mcp-test:/);
});
