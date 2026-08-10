/**
 * Response shaping.
 *
 * Every data tool answers with the same envelope so the model never has to
 * learn a per-tool result shape: a compact markdown table it can read directly,
 * plus `structuredContent` carrying the rows for programmatic use.
 */

import { z } from "zod";
import { CostLimitError, formatBytes, type QueryResult } from "./bigquery.js";

/** Shared output schema for every tool that returns rows. */
export const rowsOutputShape = {
  rows: z.array(z.record(z.any())).describe("Result rows."),
  row_count: z.number().describe("Number of rows returned in this response."),
  truncated: z
    .boolean()
    .describe("True when the result was clipped by the row limit; narrow the filters or page."),
  next_offset: z
    .number()
    .nullable()
    .describe("Offset to pass back for the next page, or null when there is no more data."),
  notes: z
    .array(z.string())
    .describe("Caveats that materially affect how these numbers should be read."),
  bytes_processed: z.string().describe("Human-readable scan size for this query."),
};

export interface ToolResponse {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Render rows as a markdown table, capped so a wide result cannot flood context. */
function toMarkdownTable(rows: Record<string, unknown>[], maxRows = 50): string {
  if (rows.length === 0) return "_No rows matched._";

  const first = rows[0];
  if (!first) return "_No rows matched._";
  const columns = Object.keys(first);
  const shown = rows.slice(0, maxRows);

  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  };

  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = shown
    .map((row) => `| ${columns.map((c) => cell(row[c])).join(" | ")} |`)
    .join("\n");

  const omitted =
    rows.length > shown.length
      ? `\n\n_${rows.length - shown.length} further row(s) omitted from this table; all rows are in structuredContent._`
      : "";

  return `${header}\n${divider}\n${body}${omitted}`;
}

export interface RowsResponseOptions {
  /** Caveats the reader needs in order not to misread the numbers. */
  notes?: string[];
  /** Offset that produced this page, when the tool paginates. */
  offset?: number;
  limit?: number;
  /** Prose shown above the table. */
  summary?: string;
}

export function rowsResponse(
  result: QueryResult,
  options: RowsResponseOptions = {},
): ToolResponse {
  const { notes = [], offset, limit, summary } = options;

  const nextOffset =
    offset !== undefined && limit !== undefined && result.rows.length === limit
      ? offset + limit
      : null;

  const allNotes = [...notes];
  if (result.truncated) {
    allNotes.push(
      "Result was clipped by the row limit. Narrow the filters or page with offset to see the rest.",
    );
  }

  const parts = [
    summary,
    toMarkdownTable(result.rows),
    allNotes.length > 0
      ? `\n**Read this before quoting the numbers**\n${allNotes.map((n) => `- ${n}`).join("\n")}`
      : undefined,
  ].filter((part): part is string => Boolean(part));

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    structuredContent: {
      rows: result.rows,
      row_count: result.rows.length,
      truncated: result.truncated,
      next_offset: nextOffset,
      notes: allNotes,
      bytes_processed: formatBytes(result.bytesProcessed),
    },
  };
}

/** An error the model can act on, rather than a stack trace. */
export function errorResponse(message: string, hints: string[] = []): ToolResponse {
  const hintText =
    hints.length > 0 ? `\n\nTry:\n${hints.map((h) => `- ${h}`).join("\n")}` : "";
  return {
    content: [{ type: "text", text: `Error: ${message}${hintText}` }],
    isError: true,
  };
}

/**
 * Wrap a handler so no exception escapes as an opaque failure. BigQuery's own
 * errors are often precise enough to act on, so they are passed through with a
 * targeted hint attached.
 */
export async function safeHandler(
  fn: () => Promise<ToolResponse>,
): Promise<ToolResponse> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CostLimitError) {
      return errorResponse(error.message, [
        "Shorten the lookback window.",
        "Filter to specific seller_ids or a single task type.",
      ]);
    }

    const message = error instanceof Error ? error.message : String(error);

    if (/partition/i.test(message)) {
      return errorResponse(message, [
        "Every table except `users` needs a created_at filter.",
        "Filter inside a CTE or in the JOIN ON clause; a WHERE after the JOIN is applied too late.",
      ]);
    }
    if (/not found|notFound|404/i.test(message)) {
      return errorResponse(message, [
        "Check SHOPDECK_BQ_PROJECT and SHOPDECK_BQ_DATASET.",
        "Confirm SHOPDECK_BQ_LOCATION matches the dataset region.",
      ]);
    }
    if (/permission|denied|403|credential|authenticat/i.test(message)) {
      return errorResponse(message, [
        "Run `gcloud auth application-default login`, or point GOOGLE_APPLICATION_CREDENTIALS at a service-account key.",
        "The account needs BigQuery Job User on the project and Data Viewer on the dataset.",
      ]);
    }

    return errorResponse(message);
  }
}
