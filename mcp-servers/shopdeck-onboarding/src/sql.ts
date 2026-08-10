/**
 * SQL construction helpers and the read-only guard.
 *
 * Two invariants everything else depends on:
 *   1. Partition filters are never optional. Tools build them; they are not
 *      left to the caller to remember.
 *   2. Caller-supplied values reach BigQuery as named parameters, never as
 *      string concatenation. The only interpolated values are integers that
 *      have been range-checked here.
 */

import { PARTITIONED_TABLES, TASK_ORDER } from "./domain.js";

/** Guard an integer before it is interpolated into SQL. */
export function safeInt(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${label} must be an integer between ${min} and ${max}, got ${value}.`,
    );
  }
  return value;
}

/**
 * The mandatory partition predicate. Upper bound is tomorrow so that today's
 * rows are included without timezone-boundary ambiguity.
 */
export function partitionWindow(alias: string, months: number): string {
  const m = safeInt(months, 1, 36, "lookback_months");
  return `${alias}.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL ${m} MONTH))
      AND ${alias}.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))`;
}

/** The canonical 12-step task list as an inline CTE body. */
export function taskOrderCte(): string {
  const rows = TASK_ORDER.map(
    (t) =>
      `    STRUCT(${t.step} AS step, '${t.type}' AS task_type, '${t.ownerTeam}' AS owner_team)`,
  ).join(",\n");
  return `SELECT * FROM UNNEST([\n${rows}\n  ])`;
}

/**
 * CASE expression mapping a task type to the ticket-level POC column that
 * nominally owns it. `alias` is the ob_tickets alias in scope.
 */
export function ticketPocCase(taskTypeExpr: string, alias: string): string {
  const branches = TASK_ORDER.map(
    (t) => `      WHEN '${t.type}' THEN ${alias}.${t.ticketPocColumn}`,
  ).join("\n");
  return `CASE ${taskTypeExpr}\n${branches}\n      ELSE NULL END`;
}

/** Render a UTC timestamp column as an IST datetime for human reading. */
export function ist(expr: string): string {
  return `DATETIME(${expr}, 'Asia/Kolkata')`;
}

// ---------------------------------------------------------------------------
// Read-only guard for the raw-SQL escape hatch
// ---------------------------------------------------------------------------

const FORBIDDEN_STATEMENTS =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|CALL|EXPORT|LOAD|BEGIN|COMMIT|ROLLBACK)\b/i;

/** Strip comments and string literals so keyword checks cannot be fooled by them. */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

export interface GuardFailure {
  reason: string;
  hint: string;
}

/**
 * Reject anything that is not a single read-only statement carrying partition
 * filters. Returns null when the query is acceptable.
 */
export function guardReadOnlySql(sql: string): GuardFailure | null {
  const cleaned = stripNoise(sql).trim();

  if (cleaned.length === 0) {
    return { reason: "Query is empty.", hint: "Pass a SELECT or WITH statement." };
  }

  if (!/^(SELECT|WITH)\b/i.test(cleaned)) {
    return {
      reason: "Only SELECT and WITH statements are permitted.",
      hint: "This server is read-only. Rewrite the query as a SELECT.",
    };
  }

  if (FORBIDDEN_STATEMENTS.test(cleaned)) {
    return {
      reason: "Query contains a data-modifying or scripting keyword.",
      hint: "Remove the DML/DDL. Only read-only SELECT queries are allowed.",
    };
  }

  // A semicolon with anything after it means a second statement.
  const withoutTrailing = cleaned.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return {
      reason: "Multiple statements are not permitted.",
      hint: "Send one statement per call.",
    };
  }

  // Partition-filter check: if a partitioned table is referenced, the query
  // must constrain created_at somewhere. This is a heuristic, but the failure
  // it prevents (a full-table scan) is expensive enough to be worth a false
  // positive the caller can work around by naming the filter explicitly.
  const touchesPartitioned = PARTITIONED_TABLES.some((t) =>
    new RegExp(`\\b${t}\\b`).test(cleaned),
  );
  const hasPartitionFilter = /created_at\s*(>=|>|<|<=|BETWEEN)/i.test(cleaned);
  if (touchesPartitioned && !hasPartitionFilter) {
    return {
      reason:
        "Query reads a partitioned table without a created_at filter. BigQuery will reject it, and without the guard it would scan the full table.",
      hint:
        "Add, for every partitioned table in the query: " +
        "created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH)) " +
        "AND created_at < TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY)). " +
        "Filter inside a CTE or in the JOIN ON clause -- a WHERE clause after a " +
        "JOIN is evaluated too late for the join-side table.",
    };
  }

  return null;
}
