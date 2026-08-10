/**
 * Response shaping.
 *
 * Every data tool answers with the same envelope so the model never has to
 * learn a per-tool result shape. `response_format` selects the text
 * representation -- markdown for reading, json for programmatic use -- while
 * `structuredContent` always carries the rows either way.
 */

import { z } from "zod";
import { CostLimitError, formatBytes, type QueryResult } from "./bigquery.js";

/** Shared `response_format` argument. Declared once, reused by every data tool. */
export const responseFormatArg = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe(
    "Text representation: 'markdown' for a readable table, 'json' for the raw rows. structuredContent is populated either way.",
  );

/** Shared output schema for every tool that returns rows. */
export const rowsOutputShape = {
  rows: z.array(z.record(z.unknown())).describe("Result rows."),
  count: z.number().describe("Rows returned in this response."),
  total_count: z
    .number()
    .nullable()
    .describe(
      "Total matching rows, when known. Null for paginated queries: counting the full set would double the scan cost.",
    ),
  offset: z.number().describe("Offset this page started at."),
  has_more: z.boolean().describe("True when more rows exist beyond this page."),
  next_offset: z
    .number()
    .nullable()
    .describe("Offset to request next, or null when there is no more data."),
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

export interface PageSpec {
  limit: number;
  offset: number;
}

/**
 * Paginated tools request one row more than they intend to return. If it comes
 * back, more data exists -- which establishes has_more without the second
 * COUNT(*) query a total would require.
 */
export function probeLimit(limit: number): number {
  return limit + 1;
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
  /** Present when the tool paginates; the result is assumed to hold limit+1 rows. */
  page?: PageSpec;
  /** Prose shown above the table in markdown mode. */
  summary?: string;
  format?: "markdown" | "json";
}

export function rowsResponse(
  result: QueryResult,
  options: RowsResponseOptions = {},
): ToolResponse {
  const { notes = [], page, summary, format = "markdown" } = options;

  let rows = result.rows;
  let hasMore = result.truncated;
  let offset = 0;
  let nextOffset: number | null = null;

  if (page) {
    offset = page.offset;
    hasMore = rows.length > page.limit;
    if (hasMore) rows = rows.slice(0, page.limit);
    nextOffset = hasMore ? page.offset + page.limit : null;
  }

  const allNotes = [...notes];
  if (hasMore) {
    allNotes.push(
      page
        ? `More rows exist. Request offset ${nextOffset} for the next page.`
        : "Result was clipped by the row limit. Narrow the filters to see the rest.",
    );
  }

  const structured: Record<string, unknown> = {
    rows,
    count: rows.length,
    total_count: page ? null : rows.length,
    offset,
    has_more: hasMore,
    next_offset: nextOffset,
    notes: allNotes,
    bytes_processed: formatBytes(result.bytesProcessed),
  };

  if (format === "json") {
    return {
      content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
      structuredContent: structured,
    };
  }

  const parts = [
    summary,
    toMarkdownTable(rows),
    allNotes.length > 0
      ? `\n**Read this before quoting the numbers**\n${allNotes.map((n) => `- ${n}`).join("\n")}`
      : undefined,
  ].filter((part): part is string => Boolean(part));

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    structuredContent: structured,
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
 * messages are usually precise enough to act on, so they are surfaced with a
 * targeted hint attached rather than replaced.
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
