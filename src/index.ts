import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { GatewayClient } from "./clients.js";
import { loadConfig } from "./config.js";
import { categorySummary, registerTools } from "./tools.js";

const VERSION = "0.2.0";

function summarizeCategories(summary: Record<string, number>): string {
  const parts = Object.entries(summary)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}:${count}`);
  return parts.join(", ");
}

async function main() {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const config = loadConfig();
  const runtime = {
    config,
    gateway: new GatewayClient(config),
  };

  const server = new McpServer({
    name: "astrbot-mcp",
    version: VERSION,
    description:
      "MCP server for AstrBot runtime and gateway operations. Defaults: capabilityMode=full, search_tools disabled.",
  });

  const catalog = registerTools(server, runtime);
  const categoryMap = categorySummary(catalog);
  server.registerTool(
    "describe_runtime_capabilities",
    {
      description:
        "Describe runtime tool categories, capability mode, and search_tools switch.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              capability_mode: config.capabilityMode,
              search_tools_enabled: config.enableSearchTools,
              log_view: config.logView,
              enable_log_noise_filtering: config.enableLogNoiseFiltering,
              category_counts: categoryMap,
              categories: summarizeCategories(categoryMap),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("unhandledRejection", (error) => {
  process.stderr.write(`Unhandled rejection: ${String(error)}\n`);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`Uncaught exception: ${error.message}\n`);
});

await main();
