import * as z from "zod/v4";

import { ToolRegistrar, scoreToolQuery, withToolErrorBoundary } from "./tooling.js";

export function registerDiscoveryTools(registrar: ToolRegistrar) {
  if (!registrar.runtime.config.enableSearchTools) {
    return;
  }

  withToolErrorBoundary(
    registrar,
    {
      name: "search_tools",
      summary: "Search available MCP tools by name and aliases.",
      category: "discovery",
      minMode: "search",
      risk: "read",
      aliases: ["tool-search"],
    },
    {
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(30).default(10),
    },
    async ({ query, top_k }) => {
      const ranked = registrar.catalog
        .filter((item) => item.enabled)
        .map((item) => ({
          ...item,
          score: scoreToolQuery(query, item),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, top_k);
      return {
        query,
        total_enabled_tools: registrar.catalog.filter((item) => item.enabled).length,
        results: ranked.map((item) => ({
          name: item.name,
          summary: item.summary,
          category: item.category,
          risk: item.risk,
          min_mode: item.minMode,
          score: item.score,
        })),
      };
    },
  );
}
