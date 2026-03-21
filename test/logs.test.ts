import test from "node:test";
import assert from "node:assert/strict";

import { extractLogEntries, filterLogsByContains } from "../src/logs.js";

test("extractLogEntries supports nested gateway payload shapes", () => {
  const payload = {
    ok: true,
    data: {
      result: {
        history: [
          { level: "INFO", data: "first" },
          { level: "INFO", data: "second" },
        ],
      },
    },
  };

  const result = extractLogEntries(payload);

  assert.equal(result.length, 2);
  assert.equal((result[1] as { data?: string }).data, "second");
});

test("extractLogEntries supports direct array payloads", () => {
  const payload = [{ level: "INFO", data: "direct" }];

  const result = extractLogEntries(payload);

  assert.equal(result.length, 1);
  assert.equal((result[0] as { data?: string }).data, "direct");
});

test("filterLogsByContains narrows logs to matching entries", () => {
  const logs = [
    { level: "INFO", data: "plugin_a handled request" },
    { level: "INFO", data: "plugin_b handled request" },
  ];

  const result = filterLogsByContains(logs, "plugin_b");

  assert.deepEqual(result, [{ level: "INFO", data: "plugin_b handled request" }]);
});
