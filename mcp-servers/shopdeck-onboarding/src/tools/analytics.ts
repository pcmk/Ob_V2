/**
 * Workflow tools: the analyses people actually ask for, with the domain's
 * correctness rules (era splits, maturity gates, dedup, partition windows)
 * already applied so they cannot be forgotten at the call site.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import {
  probeLimit,
  responseFormatArg,
  rowsOutputShape,
  rowsResponse,
  safeHandler,
  type ToolResponse,
} from "../format.js";
import {
  CRM_DEPLOY_TS_UTC,
  DEFAULT_SLA_HOURS,
  META_TO_FT_WAIT_HOURS,
  TASK_ORDER,
  TASK_TYPES,
} from "../domain.js";
import { ist, partitionWindow, safeInt, taskOrderCte } from "../sql.js";

const lookback = z
  .number()
  .int()
  .min(1)
  .max(36)
  .optional()
  .describe("Partition lookback in months.");

/** Build the SLA lookup CTE from defaults plus any per-call overrides. */
function slaConfigCte(overrides: Record<string, number> = {}): string {
  const rows = TASK_ORDER.map((t) => {
    const raw = overrides[t.type] ?? DEFAULT_SLA_HOURS[t.type] ?? 48;
    const hours = safeInt(raw, 1, 10_000, `sla_overrides.${t.type}`);
    return `    STRUCT(${t.step} AS step, '${t.type}' AS task_type, ${hours} AS sla_hours)`;
  }).join(",\n");
  return `SELECT * FROM UNNEST([\n${rows}\n  ])`;
}

export function registerAnalyticsTools(server: McpServer, ctx: ToolContext): void {
  const { bq, config } = ctx;
  const months = (value: number | undefined) =>
    safeInt(value ?? config.defaultLookbackMonths, 1, 36, "lookback_months");

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_diagnose_escalation",
    {
      title: "Diagnose why sellers stalled",
      description:
        "For each seller's ticket, find the blocking step and classify why it is stuck: the CRM never created the task, the seller is inside the mandated 48-hour meta-to-fund-transfer wait, it is simply young, ops never placed a call, ops called but never reached the seller, or contact was made and the seller has not moved. " +
        "This is the fastest route from a list of escalated seller ids to a defensible root cause. Follow up with shopdeck_get_seller_journey for the timeline behind a verdict, and shopdeck_get_calls for the evidence. " +
        "Note: the escalation record itself is not in this dataset, so this reconstructs the conditions behind an escalation rather than reading its stated reason.",
      inputSchema: {
        seller_ids: z.array(z.string().min(1)).min(1).max(200),
        lookback_months: lookback,
        premature_hours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .default(48)
          .describe("Below this age, a blocking task is treated as still in progress rather than stuck."),
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
    async ({
      seller_ids,
      lookback_months,
      premature_hours,
      response_format,
    }): Promise<ToolResponse> =>
      safeHandler(async () => {
        const m = months(lookback_months);
        const premature = safeInt(premature_hours, 1, 720, "premature_hours");

        const sql = `
WITH task_order AS (
  ${taskOrderCte()}
),
tickets AS (
  SELECT t.id AS ticket_id, t.seller_id, t.created_at AS ticket_created_at,
    CASE WHEN t.created_at >= TIMESTAMP('${CRM_DEPLOY_TS_UTC}')
         THEN 'post_deploy' ELSE 'pre_deploy' END AS ticket_era
  FROM ${bq.table("ob_tickets")} t
  WHERE t.seller_id IN UNNEST(@seller_ids) AND ${partitionWindow("t", m)}
),
tasks AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT ot.id AS task_id, ot.ticket_id, ot.type AS task_type, ot.status,
           ot.assigned_poc, ot.created_at, ot.completed_at,
           ROW_NUMBER() OVER (PARTITION BY ot.ticket_id, ot.type ORDER BY ot.created_at DESC) AS rn
    FROM ${bq.table("ob_tasks")} ot
    WHERE ot.seller_id IN UNNEST(@seller_ids) AND ${partitionWindow("ot", m)}
  ) WHERE rn = 1
),
calls AS (
  SELECT ec.entity_id AS task_id,
    COUNTIF(LOWER(ecd.call_type) = 'outbound') AS outbound_attempts,
    COUNTIF(UPPER(ecd.status) = 'CONNECTED')   AS connected_calls,
    MAX(IF(UPPER(ecd.status) = 'CONNECTED', ec.created_at, NULL)) AS last_connected_at
  FROM ${bq.table("exotel_calls")} ec
  JOIN ${bq.table("exotel_call_details")} ecd
    ON ec.exotel_call_sid = ecd.sid AND ${partitionWindow("ecd", m)}
  WHERE ec.entity = 'ob-task' AND ${partitionWindow("ec", m)}
  GROUP BY task_id
),
grid AS (
  SELECT tk.seller_id, tk.ticket_id, tk.ticket_created_at, tk.ticket_era,
         o.step, o.task_type, ta.task_id, ta.status, ta.assigned_poc,
         ta.created_at, ta.completed_at,
         COALESCE(c.outbound_attempts, 0) AS outbound_attempts,
         COALESCE(c.connected_calls, 0)   AS connected_calls,
         c.last_connected_at,
         (ta.task_id IS NOT NULL AND LOWER(ta.status) = 'completed') AS is_done
  FROM tickets tk
  CROSS JOIN task_order o
  LEFT JOIN tasks ta ON ta.ticket_id = tk.ticket_id AND ta.task_type = o.task_type
  LEFT JOIN calls c  ON c.task_id = ta.task_id
),
blocking AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT g.*, ROW_NUMBER() OVER (PARTITION BY g.ticket_id ORDER BY g.step) AS rn
    FROM grid g WHERE NOT g.is_done
  ) WHERE rn = 1
),
progress AS (
  SELECT ticket_id,
         COUNTIF(is_done) AS steps_done,
         MAX(IF(is_done, completed_at, NULL)) AS last_completion_at,
         MAX(IF(task_type = 'meta_setup' AND is_done, completed_at, NULL)) AS meta_completed_at
  FROM grid GROUP BY ticket_id
),
launched AS (
  SELECT DISTINCT sm.ticket_id
  FROM ${bq.table("seller_journey_milestones")} sm
  WHERE sm.step_name = 'Launch' AND LOWER(sm.status) = 'completed'
    AND ${partitionWindow("sm", m)}
)
SELECT
  b.seller_id,
  b.ticket_id,
  b.ticket_era,
  ${ist("b.ticket_created_at")} AS ticket_created_ist,
  DATE_DIFF(CURRENT_DATE(), DATE(b.ticket_created_at), DAY) AS days_in_funnel,
  p.steps_done AS steps_completed_of_12,
  b.step       AS blocking_step,
  b.task_type  AS blocking_task,
  COALESCE(u.first_name, IF(b.task_id IS NULL, '(no task row)', 'UNASSIGNED')) AS blocking_task_poc,
  COALESCE(b.status, 'DOES_NOT_EXIST') AS blocking_task_status,
  ROUND(TIMESTAMP_DIFF(CURRENT_TIMESTAMP(),
        COALESCE(b.created_at, p.last_completion_at, b.ticket_created_at), HOUR) / 24.0, 1)
    AS days_blocked,
  b.outbound_attempts AS calls_on_blocking_task,
  b.connected_calls   AS connects_on_blocking_task,
  ${ist("b.last_connected_at")} AS last_seller_contact_ist,
  CASE
    WHEN l.ticket_id IS NOT NULL
      THEN 'LAUNCHED -- escalation is likely commercial or post-launch'
    WHEN b.task_id IS NULL
         AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(),
             COALESCE(p.last_completion_at, b.ticket_created_at), HOUR) > 72
      THEN 'SYSTEM -- task never created (CRM gap)'
    WHEN b.task_type = 'fund_transfer'
         AND p.meta_completed_at IS NOT NULL
         AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), p.meta_completed_at, HOUR) < ${META_TO_FT_WAIT_HOURS}
      THEN 'POLICY WAIT -- inside the mandated 48h meta->fund_transfer window'
    WHEN TIMESTAMP_DIFF(CURRENT_TIMESTAMP(),
         COALESCE(b.created_at, b.ticket_created_at), HOUR) < ${premature}
      THEN 'IN PROGRESS -- younger than the premature_hours threshold'
    WHEN b.outbound_attempts = 0
      THEN 'OPS -- no outbound attempt on the blocking task'
    WHEN b.connected_calls = 0
      THEN 'SELLER -- attempted but never reached'
    ELSE 'SELLER-SIDE STALL -- contact made, no progress (docs or decision pending)'
  END AS likely_root_cause
FROM blocking b
JOIN progress p ON b.ticket_id = p.ticket_id
LEFT JOIN launched l ON b.ticket_id = l.ticket_id
LEFT JOIN ${bq.table("users")} u ON b.assigned_poc = u._id
ORDER BY days_blocked DESC`;

        const result = await bq.query(sql, { seller_ids });
        const found = new Set(result.rows.map((r) => String(r.seller_id)));
        const missing = seller_ids.filter((id) => !found.has(id));

        const notes = [
          "Tickets with all 12 tasks done have no blocking step and are omitted; check shopdeck_get_milestones to confirm they launched.",
          "The verdict is a hypothesis from timing and call activity, not a stated reason. Confirm against the journey and the call log before reporting it.",
          "POLICY WAIT is correct behaviour, not a delay -- do not count it as a breach.",
        ];
        if (missing.length > 0) {
          notes.push(
            `No ticket in the ${m}-month window for: ${missing.join(", ")}. These are either older than the window or fully complete.`,
          );
        }

        return rowsResponse(result, {
          notes,
          format: response_format,
          summary: `Diagnosis for ${result.rows.length} blocked ticket(s) across ${seller_ids.length} requested seller(s).`,
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_poc_sla_adherence",
    {
      title: "SLA adherence by POC",
      description:
        "SLA adherence per POC and task type over a trailing window. The clock is task turnaround (created_at to completed_at), so a POC is measured only on time the task sat with them. Tasks still open past their SLA count as breaches; tasks still open but inside SLA are excluded from the denominator and reported separately, so nobody scores well by leaving work open. " +
        "fund_transfer on pre-deploy tickets is given 48 extra hours because the mandated wait is baked into that task's lifetime. " +
        "SLA thresholds default to placeholder values -- pass sla_overrides with the real ops targets before treating the percentages as fact.",
      inputSchema: {
        window_days: z.number().int().min(1).max(365).default(30),
        task_types: z.array(z.enum(TASK_TYPES)).optional(),
        poc_name: z.string().optional().describe("Restrict to one POC first name."),
        min_tasks: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(5)
          .describe("Drop POC/task combinations with fewer evaluated tasks than this."),
        sla_overrides: z
          .record(z.number().int().min(1).max(10_000))
          .optional()
          .describe('Per-task SLA hours, e.g. {"cagd": 24, "gtg": 12}.'),
        lookback_months: lookback,
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
    async (args): Promise<ToolResponse> =>
      safeHandler(async () => {
        const m = months(args.lookback_months);
        const windowDays = safeInt(args.window_days, 1, 365, "window_days");
        const minTasks = safeInt(args.min_tasks, 1, 1000, "min_tasks");

        const params: Record<string, unknown> = {};
        const extra: string[] = [];
        if (args.task_types?.length) {
          extra.push("ot.type IN UNNEST(@task_types)");
          params.task_types = args.task_types;
        }

        const sql = `
WITH sla_config AS (
  ${slaConfigCte(args.sla_overrides ?? {})}
),
tickets AS (
  SELECT t.id, t.created_at,
    CASE WHEN t.created_at >= TIMESTAMP('${CRM_DEPLOY_TS_UTC}')
         THEN 'post_deploy' ELSE 'pre_deploy' END AS ticket_era
  FROM ${bq.table("ob_tickets")} t
  WHERE ${partitionWindow("t", Math.min(m + 1, 36))}
),
tasks AS (
  SELECT ot.id AS task_id, ot.seller_id, ot.ticket_id, ot.type AS task_type,
         ot.status, ot.assigned_poc, ot.created_at, ot.completed_at
  FROM ${bq.table("ob_tasks")} ot
  WHERE ${partitionWindow("ot", m)}
    AND LOWER(ot.status) != 'cancelled'
    ${extra.length ? `AND ${extra.join(" AND ")}` : ""}
),
scored AS (
  SELECT
    ta.*,
    tk.ticket_era,
    s.step,
    s.sla_hours + IF(ta.task_type = 'fund_transfer' AND tk.ticket_era = 'pre_deploy',
                     ${META_TO_FT_WAIT_HOURS}, 0) AS sla_hours_effective,
    (LOWER(ta.status) = 'completed' AND ta.completed_at IS NOT NULL) AS is_closed,
    TIMESTAMP_DIFF(COALESCE(ta.completed_at, CURRENT_TIMESTAMP()), ta.created_at, MINUTE) / 60.0
      AS elapsed_hours
  FROM tasks ta
  JOIN sla_config s ON s.task_type = ta.task_type
  LEFT JOIN tickets tk ON ta.ticket_id = tk.id
),
classified AS (
  SELECT *,
    CASE
      WHEN is_closed AND elapsed_hours <= sla_hours_effective THEN 'met'
      WHEN is_closed                                          THEN 'breached_closed'
      WHEN elapsed_hours > sla_hours_effective                THEN 'breached_open'
      ELSE 'in_flight'
    END AS sla_outcome
  FROM scored
),
in_window AS (
  SELECT * FROM classified
  WHERE (is_closed
         AND completed_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL ${windowDays} DAY))
         AND completed_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY)))
     OR (NOT is_closed
         AND created_at   >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL ${windowDays} DAY)))
)
SELECT
  COALESCE(u.first_name, 'UNASSIGNED') AS poc,
  w.task_type,
  ANY_VALUE(w.sla_hours_effective) AS sla_hours,
  COUNTIF(w.sla_outcome != 'in_flight') AS tasks_evaluated,
  COUNTIF(w.sla_outcome = 'met')        AS met_sla,
  COUNTIF(w.sla_outcome IN ('breached_closed', 'breached_open')) AS breached,
  COUNTIF(w.sla_outcome = 'breached_open') AS breached_still_open,
  COUNTIF(w.sla_outcome = 'in_flight')     AS open_in_flight,
  ROUND(SAFE_DIVIDE(COUNTIF(w.sla_outcome = 'met'),
                    COUNTIF(w.sla_outcome != 'in_flight')), 4) AS sla_adherence_rate,
  ROUND(APPROX_QUANTILES(IF(w.is_closed, w.elapsed_hours, NULL), 100)[SAFE_OFFSET(50)], 1) AS p50_turnaround_hrs,
  ROUND(APPROX_QUANTILES(IF(w.is_closed, w.elapsed_hours, NULL), 100)[SAFE_OFFSET(90)], 1) AS p90_turnaround_hrs,
  ROUND(AVG(IF(w.sla_outcome IN ('breached_closed', 'breached_open'),
               w.elapsed_hours - w.sla_hours_effective, NULL)), 1) AS avg_overshoot_hrs,
  COUNT(DISTINCT w.seller_id) AS distinct_sellers
FROM in_window w
LEFT JOIN ${bq.table("users")} u ON w.assigned_poc = u._id
${args.poc_name ? "WHERE LOWER(u.first_name) = LOWER(@poc_name)" : ""}
GROUP BY poc, w.task_type, w.step
HAVING tasks_evaluated >= ${minTasks}
ORDER BY sla_adherence_rate ASC, breached DESC`;

        if (args.poc_name) params.poc_name = args.poc_name;

        const result = await bq.query(sql, params);
        return rowsResponse(result, {
          format: args.response_format,
          notes: [
            args.sla_overrides
              ? "SLA thresholds were overridden for this call."
              : "SLA thresholds are this server's placeholder defaults, not ops-agreed targets. Say so when reporting these numbers.",
            "Wall-clock hours, not business hours. A task landing on Friday evening burns the weekend.",
            "Denominator excludes open tasks still inside SLA, whose outcome is undecided; they appear as open_in_flight.",
            "Duplicate task rows count separately here, because each is real work. Ask for a per-seller verdict instead if that is not what you want.",
          ],
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_find_stuck_sellers",
    {
      title: "Find sellers stalled between two tasks",
      description:
        "Sellers who completed one task but have not completed a later one after N days. Defaults to the meta_setup to fund_transfer hop, where the operational baseline for 'stuck' is more than 7 days. Returns an actionable list with the owning POC and call activity.",
      inputSchema: {
        from_task: z.enum(TASK_TYPES).default("meta_setup"),
        to_task: z.enum(TASK_TYPES).default("fund_transfer"),
        min_days_stuck: z.number().int().min(1).max(365).default(7),
        lookback_months: lookback,
        limit: z.number().int().min(1).max(1000).default(50).describe("Maximum rows per page."),
        offset: z.number().int().min(0).default(0).describe("Rows to skip, for paging."),
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
    async (args): Promise<ToolResponse> =>
      safeHandler(async () => {
        const m = months(args.lookback_months);
        const minDays = safeInt(args.min_days_stuck, 1, 365, "min_days_stuck");
        const limit = safeInt(args.limit, 1, 1000, "limit");
        const offset = safeInt(args.offset, 0, 100_000, "offset");

        if (args.from_task === args.to_task) {
          throw new Error("from_task and to_task must differ.");
        }

        const sql = `
WITH from_done AS (
  SELECT ot.seller_id, ot.ticket_id, MAX(ot.completed_at) AS from_at
  FROM ${bq.table("ob_tasks")} ot
  WHERE ot.type = @from_task AND LOWER(ot.status) = 'completed'
    AND ${partitionWindow("ot", m)}
  GROUP BY ot.seller_id, ot.ticket_id
),
to_done AS (
  SELECT ot.seller_id, MAX(ot.completed_at) AS to_at
  FROM ${bq.table("ob_tasks")} ot
  WHERE ot.type = @to_task AND LOWER(ot.status) = 'completed'
    AND ${partitionWindow("ot", m)}
  GROUP BY ot.seller_id
),
open_task AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT ot.ticket_id, ot.id AS task_id, ot.assigned_poc, ot.status,
           ROW_NUMBER() OVER (PARTITION BY ot.ticket_id ORDER BY ot.created_at DESC) AS rn
    FROM ${bq.table("ob_tasks")} ot
    WHERE ot.type = @to_task AND ${partitionWindow("ot", m)}
  ) WHERE rn = 1
),
calls AS (
  SELECT ec.entity_id AS task_id,
    COUNTIF(LOWER(ecd.call_type) = 'outbound') AS outbound_attempts,
    COUNTIF(UPPER(ecd.status) = 'CONNECTED')   AS connected_calls
  FROM ${bq.table("exotel_calls")} ec
  JOIN ${bq.table("exotel_call_details")} ecd
    ON ec.exotel_call_sid = ecd.sid AND ${partitionWindow("ecd", m)}
  WHERE ec.entity = 'ob-task' AND ${partitionWindow("ec", m)}
  GROUP BY task_id
)
SELECT
  f.seller_id,
  f.ticket_id,
  ${ist("f.from_at")} AS from_task_completed_ist,
  DATE_DIFF(CURRENT_DATE(), DATE(f.from_at), DAY) AS days_since_from_task,
  COALESCE(ot.status, 'TASK_NEVER_CREATED') AS to_task_status,
  COALESCE(u.first_name, 'UNASSIGNED')      AS to_task_poc,
  COALESCE(c.outbound_attempts, 0)          AS calls_on_to_task,
  COALESCE(c.connected_calls, 0)            AS connects_on_to_task
FROM from_done f
LEFT JOIN to_done t  ON f.seller_id = t.seller_id AND t.to_at >= f.from_at
LEFT JOIN open_task ot ON f.ticket_id = ot.ticket_id
LEFT JOIN calls c    ON ot.task_id = c.task_id
LEFT JOIN ${bq.table("users")} u ON ot.assigned_poc = u._id
WHERE t.to_at IS NULL
  AND DATE_DIFF(CURRENT_DATE(), DATE(f.from_at), DAY) > ${minDays}
ORDER BY days_since_from_task DESC
LIMIT ${probeLimit(limit)} OFFSET ${offset}`;

        const result = await bq.query(sql, {
          from_task: args.from_task,
          to_task: args.to_task,
        }, { maxRows: probeLimit(limit) });

        return rowsResponse(result, {
          page: { limit, offset },
          format: args.response_format,
          notes: [
            "The to_task match requires completion at or after the from_task, so a completion from an earlier journey cannot mask a current stall.",
            "TASK_NEVER_CREATED means the downstream task does not exist at all -- a CRM gap, not POC inaction.",
            args.to_task === "fund_transfer"
              ? "The first 48 hours after meta_setup are a mandated wait; keep min_days_stuck above 2 so policy compliance is not counted as a stall."
              : "Check the baseline gap for this hop before calling these sellers late.",
            "Batching: when an upstream task slows, the next one looks slow too because POCs work in batches. Confirm the upstream step before blaming this one.",
          ],
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_funnel_conversion",
    {
      title: "Cohort conversion to a task",
      description:
        "Weekly ticket cohorts and the share that completed a given task within N days. Applies a maturity gate: cohorts younger than the conversion window are excluded, because including them makes recent weeks look artificially bad. Use this for trend questions, not for single-week comparisons -- weekly volume swings 20-30% on its own.",
      inputSchema: {
        target_task: z.enum(TASK_TYPES).default("fund_transfer"),
        conversion_days: z.number().int().min(1).max(180).default(14),
        cohort_from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Earliest ticket creation date to include (YYYY-MM-DD)."),
        lookback_months: lookback,
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
    async (args): Promise<ToolResponse> =>
      safeHandler(async () => {
        const m = months(args.lookback_months);
        const days = safeInt(args.conversion_days, 1, 180, "conversion_days");

        const sql = `
WITH cohort AS (
  SELECT t.id AS ticket_id, t.seller_id, DATE(t.created_at) AS cohort_date,
    CASE WHEN t.created_at >= TIMESTAMP('${CRM_DEPLOY_TS_UTC}')
         THEN 'post_deploy' ELSE 'pre_deploy' END AS ticket_era
  FROM ${bq.table("ob_tickets")} t
  WHERE ${partitionWindow("t", m)}
    AND t.created_at >= TIMESTAMP(@cohort_from)
    -- Maturity gate: a cohort younger than the conversion window cannot have converted yet.
    AND t.created_at <  TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY))
),
task_done AS (
  SELECT ot.ticket_id, MAX(ot.completed_at) AS done_at
  FROM ${bq.table("ob_tasks")} ot
  WHERE ot.type = @target_task AND LOWER(ot.status) = 'completed'
    AND ${partitionWindow("ot", m)}
  GROUP BY ot.ticket_id
)
SELECT
  DATE_TRUNC(c.cohort_date, WEEK(MONDAY)) AS cohort_week,
  c.ticket_era,
  COUNT(*) AS cohort_size,
  COUNTIF(td.done_at IS NOT NULL
          AND DATE_DIFF(DATE(td.done_at), c.cohort_date, DAY) <= ${days}) AS converted_in_window,
  ROUND(SAFE_DIVIDE(
    COUNTIF(td.done_at IS NOT NULL
            AND DATE_DIFF(DATE(td.done_at), c.cohort_date, DAY) <= ${days}),
    COUNT(*)), 4) AS conversion_rate,
  ROUND(APPROX_QUANTILES(
    IF(td.done_at IS NOT NULL, DATE_DIFF(DATE(td.done_at), c.cohort_date, DAY), NULL),
    100)[SAFE_OFFSET(50)], 1) AS p50_days_to_complete
FROM cohort c
LEFT JOIN task_done td ON c.ticket_id = td.ticket_id
GROUP BY cohort_week, c.ticket_era
ORDER BY cohort_week DESC, c.ticket_era`;

        const result = await bq.query(sql, {
          target_task: args.target_task,
          cohort_from: args.cohort_from,
        });

        return rowsResponse(result, {
          format: args.response_format,
          notes: [
            `Cohorts newer than ${days} days are excluded by the maturity gate, so the most recent weeks are deliberately absent.`,
            "Split by ticket_era is kept because the CRM deploy changed when the fund_transfer task is created; pooling the eras hides that.",
            "A single week's dip is noise. Call a trend only on a sustained multi-week move.",
            "Grain is tickets, not sellers. A seller who re-onboarded appears in two cohorts.",
          ],
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_poc_throughput",
    {
      title: "Task completions by POC",
      description:
        "How many tasks each POC completed in a window, by task type, with median turnaround. Attribution is ob_tasks.assigned_poc, so reassignment is handled. Volume only -- pair with shopdeck_poc_sla_adherence for whether the work was on time.",
      inputSchema: {
        window_days: z.number().int().min(1).max(365).default(7),
        task_types: z.array(z.enum(TASK_TYPES)).optional(),
        lookback_months: lookback,
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
    async (args): Promise<ToolResponse> =>
      safeHandler(async () => {
        const m = months(args.lookback_months);
        const windowDays = safeInt(args.window_days, 1, 365, "window_days");
        const params: Record<string, unknown> = {};
        const extra: string[] = [];
        if (args.task_types?.length) {
          extra.push("ot.type IN UNNEST(@task_types)");
          params.task_types = args.task_types;
        }

        const sql = `
SELECT
  COALESCE(u.first_name, 'UNASSIGNED') AS poc,
  ot.type AS task_type,
  COUNT(*) AS tasks_completed,
  COUNT(DISTINCT ot.seller_id) AS distinct_sellers,
  ROUND(APPROX_QUANTILES(
    TIMESTAMP_DIFF(ot.completed_at, ot.created_at, MINUTE) / 60.0, 100)[SAFE_OFFSET(50)], 1)
    AS p50_turnaround_hrs
FROM ${bq.table("ob_tasks")} ot
LEFT JOIN ${bq.table("users")} u ON ot.assigned_poc = u._id
WHERE LOWER(ot.status) = 'completed'
  AND ot.completed_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL ${windowDays} DAY))
  AND ot.completed_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
  AND ${partitionWindow("ot", m)}
  ${extra.length ? `AND ${extra.join(" AND ")}` : ""}
GROUP BY poc, task_type
ORDER BY tasks_completed DESC`;

        const result = await bq.query(sql, params);
        return rowsResponse(result, {
          format: args.response_format,
          notes: [
            "Counts are task completions, not unique sellers; distinct_sellers is given alongside because the two differ when tasks are re-created.",
            "Today is a partial day and will look low. Compare whole days.",
          ],
        });
      }),
  );
}
