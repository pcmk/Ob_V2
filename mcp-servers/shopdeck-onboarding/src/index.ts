#!/usr/bin/env node
/**
 * ShopDeck onboarding MCP server.
 *
 * stdio transport: this is a local server, run by the MCP client as a child
 * process, authenticating to BigQuery with the operator's own credentials.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { BigQueryClient } from "./bigquery.js";
import type { ToolContext } from "./tools/context.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerJourneyTools } from "./tools/journey.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerRawTools } from "./tools/raw.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx: ToolContext = {
    config,
    bq: new BigQueryClient(config),
  };

  const server = new McpServer(
    { name: "shopdeck-mcp-server", version: "0.1.0" },
    {
      instructions:
        "Tools for the ShopDeck seller-onboarding funnel, backed by the nushop BigQuery dataset. " +
        "Call shopdeck_describe_schema first when you need the funnel's structure or its business rules. " +
        "Three rules govern every result here: the 48-hour meta_setup-to-fund_transfer policy means a waiting seller is not a delayed one; " +
        "cohort conversion needs a maturity gate or recent weeks look falsely bad; " +
        "and the absence of a task row means the task was never created, which is not the same as it being cancelled. " +
        "The purpose-built tools apply these rules already. shopdeck_run_sql does not -- it is the escape hatch.",
    },
  );

  registerReferenceTools(server, ctx);
  registerJourneyTools(server, ctx);
  registerAnalyticsTools(server, ctx);
  registerRawTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout carries the protocol; diagnostics must go to stderr.
  process.stderr.write(
    `shopdeck-mcp-server ready (project=${config.projectId}, dataset=${config.dataset})\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal: ${message}\n`);
  process.exit(1);
});
