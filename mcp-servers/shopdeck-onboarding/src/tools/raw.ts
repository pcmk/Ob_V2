/**
 * The escape hatch: arbitrary read-only SQL, for questions the workflow tools
 * do not cover. Guarded so it cannot mutate anything and cannot accidentally
 * trigger a full-table scan.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import {
  errorResponse,
  responseFormatArg,
  rowsOutputShape,
  rowsResponse,
  safeHandler,
  type ToolResponse,
} from "../format.js";
import { formatBytes } from "../bigquery.js";
import { guardReadOnlySql, safeInt } from "../sql.js";

export function registerRawTools(server: McpServer, ctx: ToolContext): void {
  const { bq, config } = ctx;

  server.registerTool(
    "shopdeck_run_sql",
    {
      title: "Run read-only BigQuery SQL",
      description:
        "Execute an arbitrary read-only SELECT against the onboarding dataset, for questions the purpose-built tools do not cover. " +
        `Tables are addressed as \`${config.projectId}.${config.dataset}.<table>\`. ` +
        "Only a single SELECT or WITH statement is accepted; DML, DDL and multi-statement scripts are refused. " +
        "Every partitioned table referenced must carry a created_at filter -- the query is rejected otherwise, because without one BigQuery would either error or scan the whole table. " +
        "Call shopdeck_describe_schema first if you are unsure of column names, and prefer dry_run to check the scan size before running something broad.",
      inputSchema: {
        sql: z.string().min(1).describe("A single read-only SELECT or WITH statement."),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Estimate the scan size without executing."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(50)
          .describe("Maximum rows returned to the caller. has_more reports whether the query produced more."),
        response_format: responseFormatArg,
      },
      outputSchema: rowsOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sql, dry_run, limit, response_format }): Promise<ToolResponse> =>
      safeHandler(async () => {
        const failure = guardReadOnlySql(sql);
        if (failure) return errorResponse(failure.reason, [failure.hint]);

        const rowLimit = safeInt(limit, 1, 1000, "limit");

        if (dry_run) {
          const bytes = await bq.estimate(sql);
          const withinBudget = bytes <= config.maxBytesBilled;
          return {
            content: [
              {
                type: "text",
                text:
                  `Dry run: this query would scan **${formatBytes(bytes)}** ` +
                  `(limit ${formatBytes(config.maxBytesBilled)}). ` +
                  (withinBudget
                    ? "Within budget; safe to run."
                    : "Over budget and will be refused. Narrow the created_at window or select fewer columns."),
              },
            ],
            structuredContent: {
              rows: [],
              count: 0,
              total_count: null,
              offset: 0,
              has_more: false,
              next_offset: null,
              notes: [withinBudget ? "within_budget" : "over_budget"],
              bytes_processed: formatBytes(bytes),
            },
          };
        }

        const result = await bq.query(sql, {}, { maxRows: rowLimit });
        return rowsResponse(result, {
          format: response_format,
          notes: [
            "Hand-written SQL bypasses the correctness rules the purpose-built tools apply: era splits, milestone alias merging, task de-duplication and maturity gates. Confirm which of those your query needs.",
          ],
        });
      }),
  );
}
