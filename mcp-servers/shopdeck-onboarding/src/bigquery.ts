/**
 * BigQuery access with a cost guard.
 *
 * Every query is dry-run first. If the estimate exceeds the configured ceiling
 * the job is refused before it bills anything, and the error tells the caller
 * how to narrow it. This matters more than usual here: the dataset is
 * partitioned and a missing partition filter turns a cheap query into a full
 * table scan.
 */

import { BigQuery } from "@google-cloud/bigquery";
import type { Config } from "./config.js";

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  bytesProcessed: number;
  jobId: string | undefined;
  /** True when maxRows clipped the result set. */
  truncated: boolean;
}

export class CostLimitError extends Error {
  readonly estimatedBytes: number;
  readonly limitBytes: number;

  constructor(estimatedBytes: number, limitBytes: number) {
    super(
      `Query would scan ${formatBytes(estimatedBytes)}, over the ${formatBytes(
        limitBytes,
      )} limit. Narrow the partition window (created_at range), select fewer ` +
        `columns, or raise SHOPDECK_MAX_BYTES_BILLED if the scan is genuinely needed.`,
    );
    this.name = "CostLimitError";
    this.estimatedBytes = estimatedBytes;
    this.limitBytes = limitBytes;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** BigQuery hands back wrapper objects for some types; flatten them for JSON. */
function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const wrapped = value as { value?: unknown };
    // BigQueryTimestamp / BigQueryDate / BigQueryDatetime all expose `.value`.
    if ("value" in wrapped && Object.keys(wrapped).length === 1) {
      return wrapped.value ?? null;
    }
    if (Array.isArray(value)) return value.map(normalizeValue);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeValue(inner);
    }
    return out;
  }
  return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = normalizeValue(value);
  }
  return out;
}

export class BigQueryClient {
  private readonly client: BigQuery;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.client = new BigQuery({ projectId: config.projectId });
  }

  /** Fully-qualified table reference for use in SQL. */
  table(name: string): string {
    return `\`${this.config.projectId}.${this.config.dataset}.${name}\``;
  }

  /** Dry-run only. Returns the byte estimate without executing. */
  async estimate(
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<number> {
    const [job] = await this.client.createQueryJob({
      query,
      params,
      location: this.config.location,
      dryRun: true,
    });
    const stats = job.metadata?.statistics as
      | { totalBytesProcessed?: string }
      | undefined;
    return Number(stats?.totalBytesProcessed ?? 0);
  }

  async query<T = Record<string, unknown>>(
    query: string,
    params: Record<string, unknown> = {},
    options: { maxRows?: number } = {},
  ): Promise<QueryResult<T>> {
    const estimatedBytes = await this.estimate(query, params);
    if (estimatedBytes > this.config.maxBytesBilled) {
      throw new CostLimitError(estimatedBytes, this.config.maxBytesBilled);
    }

    const [job] = await this.client.createQueryJob({
      query,
      params,
      location: this.config.location,
      maximumBytesBilled: String(this.config.maxBytesBilled),
    });

    const [rawRows] = await job.getQueryResults({ timeoutMs: 120_000 });
    const limit = options.maxRows ?? this.config.maxRows;
    const rows = rawRows.map((row) =>
      normalizeRow(row as Record<string, unknown>),
    );

    return {
      rows: rows.slice(0, limit) as T[],
      bytesProcessed: estimatedBytes,
      jobId: job.id,
      truncated: rows.length > limit,
    };
  }
}
