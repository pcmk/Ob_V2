/**
 * Entity reads: tickets, tasks, milestones, calls, offers, and the end-to-end
 * per-seller journey grid.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { rowsOutputShape, rowsResponse, safeHandler, type ToolResponse } from "../format.js";
import {
  CRM_DEPLOY_TS_UTC,
  MILESTONE_ALIASES,
  OFFERS,
  TASK_TYPES,
} from "../domain.js";
import { ist, partitionWindow, safeInt, taskOrderCte } from "../sql.js";

const sellerIds = z
  .array(z.string().min(1))
  .min(1)
  .max(200)
  .describe("Seller ids to look up (24-character hex strings).");

const lookback = z
  .number()
  .int()
  .min(1)
  .max(36)
  .optional()
  .describe(
    "Partition lookback in months. Widen it if a seller onboarded long ago; rows outside the window are invisible, not absent.",
  );

const limitArg = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(200)
  .describe("Maximum rows to return.");

const offsetArg = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Rows to skip, for paging.");

/** Milestone alias-merging CASE, shared by the milestone tools. */
function milestoneCase(column: string): string {
  const branches = Object.entries(MILESTONE_ALIASES)
    .map(([canonical, aliases]) => {
      const list = aliases.map((a) => `'${a.replace(/'/g, "\\'")}'`).join(", ");
      return `      WHEN ${column} IN (${list}) THEN '${canonical}'`;
    })
    .join("\n");
  return `CASE\n${branches}\n      ELSE LOWER(${column}) END`;
}

export function registerJourneyTools(server: McpServer, ctx: ToolContext): void {
  const { bq, config } = ctx;
  const months = (value: number | undefined) =>
    safeInt(value ?? config.defaultLookbackMonths, 1, 36, "lookback_months");

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_get_seller_journey",
    {
      title: "End-to-end journey for specific sellers",
      description:
        "Reconstruct the full onboarding journey for one or more sellers: all 12 steps per ticket in execution order, with assigned POC, status, timestamps in IST, how long each task sat open, the dead air since the previous step closed, and call activity per task. " +
        "Steps are generated from the canonical task list rather than from the task table, so a task that was never created still appears with status DOES_NOT_EXIST -- that absence is a real failure mode (the CRM never generated it), not missing data. " +
        "This is the right first call when investigating why a seller stalled or why an escalation was raised.",
      inputSchema: { seller_ids: sellerIds, lookback_months: lookback },
      outputSchema: rowsOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ seller_ids, lookback_months }): Promise<ToolResponse> =>
      safeHandler(async () => {
        const m = months(lookback_months);
        const sql = `
WITH task_order AS (
  ${taskOrderCte()}
),
tickets AS (
  SELECT t.id AS ticket_id, t.seller_id, t.created_at AS ticket_created_at
  FROM ${bq.table("ob_tickets")} t
  WHERE t.seller_id IN UNNEST(@seller_ids)
    AND ${partitionWindow("t", m)}
),
tasks AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT
      ot.id AS task_id, ot.ticket_id, ot.type AS task_type, ot.status,
      ot.assigned_poc, ot.created_at, ot.completed_at,
      ROW_NUMBER() OVER (PARTITION BY ot.ticket_id, ot.type ORDER BY ot.created_at DESC) AS rn,
      COUNT(*)   OVER (PARTITION BY ot.ticket_id, ot.type) AS row_count_for_type
    FROM ${bq.table("ob_tasks")} ot
    WHERE ot.seller_id IN UNNEST(@seller_ids)
      AND ${partitionWindow("ot", m)}
  ) WHERE rn = 1
),
calls AS (
  SELECT
    ec.entity_id AS task_id,
    COUNTIF(LOWER(ecd.call_type) = 'outbound') AS outbound_attempts,
    COUNTIF(LOWER(ecd.call_type) = 'inbound')  AS inbound_calls,
    COUNTIF(UPPER(ecd.status) = 'CONNECTED')   AS connected_calls,
    MAX(IF(UPPER(ecd.status) = 'CONNECTED', ec.created_at, NULL)) AS last_connected_at
  FROM ${bq.table("exotel_calls")} ec
  JOIN ${bq.table("exotel_call_details")} ecd
    ON ec.exotel_call_sid = ecd.sid AND ${partitionWindow("ecd", m)}
  WHERE ec.entity = 'ob-task' AND ${partitionWindow("ec", m)}
  GROUP BY task_id
),
grid AS (
  SELECT
    tk.seller_id, tk.ticket_id, tk.ticket_created_at,
    o.step, o.task_type, o.owner_team,
    ta.task_id, ta.status, ta.assigned_poc, ta.created_at, ta.completed_at,
    ta.row_count_for_type,
    COALESCE(c.outbound_attempts, 0) AS outbound_attempts,
    COALESCE(c.inbound_calls, 0)     AS inbound_calls,
    COALESCE(c.connected_calls, 0)   AS connected_calls,
    c.last_connected_at
  FROM tickets tk
  CROSS JOIN task_order o
  LEFT JOIN tasks ta ON ta.ticket_id = tk.ticket_id AND ta.task_type = o.task_type
  LEFT JOIN calls c  ON c.task_id = ta.task_id
)
SELECT
  g.seller_id,
  g.ticket_id,
  CASE WHEN g.ticket_created_at >= TIMESTAMP('${CRM_DEPLOY_TS_UTC}')
       THEN 'post_deploy' ELSE 'pre_deploy' END AS ticket_era,
  g.step,
  g.task_type,
  g.owner_team,
  COALESCE(u.first_name,
           IF(g.task_id IS NULL, '(task never created)', 'UNASSIGNED')) AS worked_by,
  COALESCE(g.status, 'DOES_NOT_EXIST') AS status,
  ${ist("g.created_at")}   AS task_created_ist,
  ${ist("g.completed_at")} AS task_completed_ist,
  ROUND(TIMESTAMP_DIFF(COALESCE(g.completed_at, CURRENT_TIMESTAMP()), g.created_at, MINUTE) / 60.0, 1)
    AS hours_in_queue,
  ROUND(TIMESTAMP_DIFF(
    COALESCE(g.completed_at, CURRENT_TIMESTAMP()),
    LAG(g.completed_at) OVER (PARTITION BY g.ticket_id ORDER BY g.step),
    MINUTE) / 60.0, 1) AS hours_since_prev_step_done,
  g.outbound_attempts,
  g.inbound_calls,
  g.connected_calls,
  ${ist("g.last_connected_at")} AS last_connected_ist,
  IF(g.row_count_for_type > 1, g.row_count_for_type, NULL) AS duplicate_task_rows
FROM grid g
LEFT JOIN ${bq.table("users")} u ON g.assigned_poc = u._id
ORDER BY g.seller_id, g.ticket_id, g.step`;

        const result = await bq.query(sql, { seller_ids });
        const found = new Set(result.rows.map((r) => String(r.seller_id)));
        const missing = seller_ids.filter((id) => !found.has(id));

        const notes = [
          "status DOES_NOT_EXIST means the task row was never created, which is different from a cancelled task.",
          "hours_in_queue is how long that task sat. hours_since_prev_step_done is the handoff gap. A large second number with a small first one points at the upstream team, not the assignee.",
          "fund_transfer on a pre_deploy ticket includes the mandated 48h wait inside hours_in_queue; on post_deploy tickets the CRM delays task creation instead.",
        ];
        if (missing.length > 0) {
          notes.push(
            `No ticket found within the ${m}-month window for: ${missing.join(", ")}. Retry with a larger lookback_months before concluding these sellers do not exist.`,
          );
        }

        return rowsResponse(result, {
          notes,
          summary: `Journey grid for ${found.size} of ${seller_ids.length} requested seller(s).`,
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_list_tickets",
    {
      title: "List onboarding tickets",
      description:
        "List tickets with their POC roster, era, and journey questionnaire. Filter by creation date, POC name, era, or seller. Use this to build a cohort before analysing it.",
      inputSchema: {
        seller_ids: sellerIds.optional(),
        created_from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Inclusive lower bound on ticket creation date (YYYY-MM-DD, UTC)."),
        created_to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Exclusive upper bound on ticket creation date (YYYY-MM-DD, UTC)."),
        poc_name: z
          .string()
          .optional()
          .describe("Match any POC role by first name (case-insensitive)."),
        era: z
          .enum(["pre_deploy", "post_deploy", "any"])
          .default("any")
          .describe("Split on the Jul 8 2026 CRM enforcement deploy."),
        lookback_months: lookback,
        limit: limitArg,
        offset: offsetArg,
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
        const params: Record<string, unknown> = {};
        const where: string[] = [partitionWindow("t", m)];

        if (args.seller_ids?.length) {
          where.push("t.seller_id IN UNNEST(@seller_ids)");
          params.seller_ids = args.seller_ids;
        }
        if (args.created_from) {
          where.push("t.created_at >= TIMESTAMP(@created_from)");
          params.created_from = args.created_from;
        }
        if (args.created_to) {
          where.push("t.created_at < TIMESTAMP(@created_to)");
          params.created_to = args.created_to;
        }
        if (args.era === "pre_deploy") {
          where.push(`t.created_at < TIMESTAMP('${CRM_DEPLOY_TS_UTC}')`);
        } else if (args.era === "post_deploy") {
          where.push(`t.created_at >= TIMESTAMP('${CRM_DEPLOY_TS_UTC}')`);
        }
        if (args.poc_name) {
          where.push(
            `LOWER(@poc_name) IN (
               LOWER(IFNULL(ob.first_name, '')), LOWER(IFNULL(gtg.first_name, '')),
               LOWER(IFNULL(cat.first_name, '')), LOWER(IFNULL(web.first_name, '')),
               LOWER(IFNULL(qc.first_name, '')))`,
          );
          params.poc_name = args.poc_name;
        }

        const limit = safeInt(args.limit, 1, 1000, "limit");
        const offset = safeInt(args.offset, 0, 100000, "offset");

        const sql = `
SELECT
  t.seller_id,
  t.id AS ticket_id,
  ${ist("t.created_at")} AS ticket_created_ist,
  DATE_DIFF(CURRENT_DATE(), DATE(t.created_at), DAY) AS ticket_age_days,
  CASE WHEN t.created_at >= TIMESTAMP('${CRM_DEPLOY_TS_UTC}')
       THEN 'post_deploy' ELSE 'pre_deploy' END AS ticket_era,
  JSON_VALUE(t.journey_questionnaire, '$.category')           AS category,
  JSON_VALUE(t.journey_questionnaire, '$.catalogue_size')     AS catalogue_size,
  JSON_VALUE(t.journey_questionnaire, '$.marketing_timeline') AS marketing_timeline,
  ob.first_name  AS ob_poc,
  gtg.first_name AS gtg_poc,
  cat.first_name AS cataloging_poc,
  web.first_name AS website_poc,
  qc.first_name  AS qc_poc
FROM ${bq.table("ob_tickets")} t
LEFT JOIN ${bq.table("users")} ob  ON t.ob_poc         = ob._id
LEFT JOIN ${bq.table("users")} gtg ON t.gtg_poc        = gtg._id
LEFT JOIN ${bq.table("users")} cat ON t.cataloging_poc = cat._id
LEFT JOIN ${bq.table("users")} web ON t.website_poc    = web._id
LEFT JOIN ${bq.table("users")} qc  ON t.qc_poc         = qc._id
WHERE ${where.join("\n  AND ")}
ORDER BY t.created_at DESC
LIMIT ${limit} OFFSET ${offset}`;

        const result = await bq.query(sql, params, { maxRows: limit });
        return rowsResponse(result, {
          limit,
          offset,
          notes: [
            "A seller appearing twice re-onboarded. Do not collapse the rows -- they are separate journeys.",
          ],
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_list_tasks",
    {
      title: "List onboarding tasks",
      description:
        "List individual task rows with the POC who actually worked them. Filter by seller, ticket, task type, status, POC, or completion window. Use this when the task event is the unit of analysis; use shopdeck_get_seller_journey when you want a seller's whole story.",
      inputSchema: {
        seller_ids: sellerIds.optional(),
        ticket_id: z.string().optional().describe("Restrict to a single ticket."),
        task_types: z
          .array(z.enum(TASK_TYPES))
          .optional()
          .describe("Restrict to specific task types."),
        statuses: z
          .array(z.string())
          .optional()
          .describe("Task statuses, e.g. completed, pending, blocked, cancelled."),
        poc_name: z.string().optional().describe("Assigned POC first name (case-insensitive)."),
        completed_from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Inclusive lower bound on completion date (UTC)."),
        completed_to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Exclusive upper bound on completion date (UTC)."),
        lookback_months: lookback,
        limit: limitArg,
        offset: offsetArg,
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
        const params: Record<string, unknown> = {};
        const where: string[] = [partitionWindow("ot", m)];

        if (args.seller_ids?.length) {
          where.push("ot.seller_id IN UNNEST(@seller_ids)");
          params.seller_ids = args.seller_ids;
        }
        if (args.ticket_id) {
          where.push("ot.ticket_id = @ticket_id");
          params.ticket_id = args.ticket_id;
        }
        if (args.task_types?.length) {
          where.push("ot.type IN UNNEST(@task_types)");
          params.task_types = args.task_types;
        }
        if (args.statuses?.length) {
          where.push("LOWER(ot.status) IN UNNEST(@statuses)");
          params.statuses = args.statuses.map((s) => s.toLowerCase());
        }
        if (args.poc_name) {
          where.push("LOWER(u.first_name) = LOWER(@poc_name)");
          params.poc_name = args.poc_name;
        }
        if (args.completed_from) {
          where.push("ot.completed_at >= TIMESTAMP(@completed_from)");
          params.completed_from = args.completed_from;
        }
        if (args.completed_to) {
          where.push("ot.completed_at < TIMESTAMP(@completed_to)");
          params.completed_to = args.completed_to;
        }

        const limit = safeInt(args.limit, 1, 1000, "limit");
        const offset = safeInt(args.offset, 0, 100000, "offset");

        const sql = `
SELECT
  ot.seller_id,
  ot.ticket_id,
  ot.id AS task_id,
  ot.type AS task_type,
  ot.status,
  COALESCE(u.first_name, 'UNASSIGNED') AS assigned_poc,
  ${ist("ot.created_at")}   AS task_created_ist,
  ${ist("ot.completed_at")} AS task_completed_ist,
  ROUND(TIMESTAMP_DIFF(COALESCE(ot.completed_at, CURRENT_TIMESTAMP()), ot.created_at, MINUTE) / 60.0, 1)
    AS hours_in_queue
FROM ${bq.table("ob_tasks")} ot
LEFT JOIN ${bq.table("users")} u ON ot.assigned_poc = u._id
WHERE ${where.join("\n  AND ")}
ORDER BY ot.created_at DESC
LIMIT ${limit} OFFSET ${offset}`;

        const result = await bq.query(sql, params, { maxRows: limit });
        return rowsResponse(result, {
          limit,
          offset,
          notes: [
            "The partition filter constrains task CREATION date. A task completed recently may have been created long before the window; widen lookback_months if completions look missing.",
            "Duplicate rows of one task type on a ticket are real -- they come from the stuck-task recovery path.",
          ],
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_get_milestones",
    {
      title: "Milestone history",
      description:
        "Return milestone rows for sellers or tickets, with the aliased step_name values merged into the five canonical milestones (document, catalogue, marketing, website, launch). Completion time is updated_at. Use this to check whether a seller actually launched -- task completion alone does not establish that.",
      inputSchema: {
        seller_ids: sellerIds.optional(),
        ticket_ids: z.array(z.string()).min(1).max(200).optional(),
        completed_only: z
          .boolean()
          .default(false)
          .describe("Restrict to milestones with status 'completed'."),
        lookback_months: lookback,
        limit: limitArg,
        offset: offsetArg,
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
        if (!args.seller_ids?.length && !args.ticket_ids?.length) {
          throw new Error(
            "Provide seller_ids or ticket_ids. An unbounded milestone scan is refused because it is expensive and rarely what is wanted.",
          );
        }
        const m = months(args.lookback_months);
        const params: Record<string, unknown> = {};
        const where: string[] = [partitionWindow("sm", m)];

        if (args.seller_ids?.length) {
          where.push("t.seller_id IN UNNEST(@seller_ids)");
          params.seller_ids = args.seller_ids;
        }
        if (args.ticket_ids?.length) {
          where.push("sm.ticket_id IN UNNEST(@ticket_ids)");
          params.ticket_ids = args.ticket_ids;
        }
        if (args.completed_only) where.push("LOWER(sm.status) = 'completed'");

        const limit = safeInt(args.limit, 1, 1000, "limit");
        const offset = safeInt(args.offset, 0, 100000, "offset");

        const sql = `
SELECT
  t.seller_id,
  sm.ticket_id,
  ${milestoneCase("sm.step_name")} AS milestone,
  sm.step_name AS raw_step_name,
  sm.status,
  ${ist("sm.updated_at")} AS milestone_updated_ist
FROM ${bq.table("seller_journey_milestones")} sm
JOIN ${bq.table("ob_tickets")} t
  ON sm.ticket_id = t.id AND ${partitionWindow("t", m)}
WHERE ${where.join("\n  AND ")}
ORDER BY t.seller_id, sm.ticket_id, sm.updated_at
LIMIT ${limit} OFFSET ${offset}`;

        const result = await bq.query(sql, params, { maxRows: limit });
        return rowsResponse(result, {
          limit,
          offset,
          notes: [
            "raw_step_name is kept alongside the merged milestone so alias drift stays visible.",
            "A seller is launched only when the launch milestone reads 'completed'.",
          ],
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_get_calls",
    {
      title: "Call log for sellers or tasks",
      description:
        "Every POC-to-seller call attempt tied to onboarding tasks, in time order, with direction and connect status. This is the evidence trail for whether ops actually tried to reach a seller.",
      inputSchema: {
        seller_ids: sellerIds.optional(),
        task_ids: z.array(z.string()).min(1).max(200).optional(),
        connected_only: z.boolean().default(false).describe("Restrict to CONNECTED calls."),
        lookback_months: lookback,
        limit: limitArg,
        offset: offsetArg,
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
        if (!args.seller_ids?.length && !args.task_ids?.length) {
          throw new Error(
            "Provide seller_ids or task_ids. An unbounded call-log scan is refused.",
          );
        }
        const m = months(args.lookback_months);
        const params: Record<string, unknown> = {};
        const where: string[] = [
          "ec.entity = 'ob-task'",
          partitionWindow("ec", m),
        ];

        if (args.seller_ids?.length) {
          where.push("ot.seller_id IN UNNEST(@seller_ids)");
          params.seller_ids = args.seller_ids;
        }
        if (args.task_ids?.length) {
          where.push("ot.id IN UNNEST(@task_ids)");
          params.task_ids = args.task_ids;
        }
        if (args.connected_only) where.push("UPPER(ecd.status) = 'CONNECTED'");

        const limit = safeInt(args.limit, 1, 1000, "limit");
        const offset = safeInt(args.offset, 0, 100000, "offset");

        const sql = `
SELECT
  ot.seller_id,
  ot.ticket_id,
  ot.id AS task_id,
  ot.type AS task_type,
  ${ist("ec.created_at")} AS call_time_ist,
  LOWER(ecd.call_type)    AS direction,
  UPPER(ecd.status)       AS call_status,
  ec.exotel_call_sid
FROM ${bq.table("exotel_calls")} ec
JOIN ${bq.table("exotel_call_details")} ecd
  ON ec.exotel_call_sid = ecd.sid AND ${partitionWindow("ecd", m)}
JOIN ${bq.table("ob_tasks")} ot
  ON ec.entity_id = ot.id AND ${partitionWindow("ot", m)}
WHERE ${where.join("\n  AND ")}
ORDER BY ot.seller_id, ec.created_at
LIMIT ${limit} OFFSET ${offset}`;

        const result = await bq.query(sql, params, { maxRows: limit });
        return rowsResponse(result, {
          limit,
          offset,
          notes: [
            "Zero rows for a seller means no call was ever placed on their tasks -- an ops finding, not a data gap.",
          ],
        });
      }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "shopdeck_get_offers",
    {
      title: "Offer assignments for sellers",
      description:
        "Offers assigned to sellers, with ids resolved to names. Offer names are hardcoded in this server because no table carries them; an UNMAPPED result means a new offer shipped and the mapping is stale. Use this when an escalation is commercial ('I was promised credit').",
      inputSchema: {
        seller_ids: sellerIds,
        latest_only: z
          .boolean()
          .default(false)
          .describe("Return only the most recently recorded offer per seller."),
        lookback_months: lookback,
      },
      outputSchema: rowsOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ seller_ids, latest_only, lookback_months }): Promise<ToolResponse> =>
      safeHandler(async () => {
        const m = months(lookback_months);
        const offerRows = OFFERS.map(
          (o) => `    STRUCT('${o.offerId}' AS offer_id, '${o.offerName}' AS offer_name)`,
        ).join(",\n");

        const sql = `
WITH offer_map AS (
  SELECT * FROM UNNEST([
${offerRows}
  ])
),
ranked AS (
  SELECT
    so.seller_id, so.offer_id, so.status, so.is_zero_percentage_commission,
    so.recorded_at, so.start_date, so.end_date,
    ROW_NUMBER() OVER (PARTITION BY so.seller_id ORDER BY so.recorded_at DESC) AS rn
  FROM ${bq.table("seller_offers")} so
  WHERE so.seller_id IN UNNEST(@seller_ids)
    AND ${partitionWindow("so", m)}
)
SELECT
  r.seller_id,
  COALESCE(om.offer_name, CONCAT('UNMAPPED: ', r.offer_id)) AS offer_name,
  r.offer_id,
  r.status,
  r.is_zero_percentage_commission,
  ${ist("r.recorded_at")} AS recorded_ist,
  r.start_date,
  r.end_date
FROM ranked r
LEFT JOIN offer_map om ON r.offer_id = om.offer_id
${latest_only ? "WHERE r.rn = 1" : ""}
ORDER BY r.seller_id, r.recorded_at DESC`;

        const result = await bq.query(sql, { seller_ids });
        const unmapped = result.rows.some((r) =>
          String(r.offer_name).startsWith("UNMAPPED"),
        );
        const notes = [
          "A seller can hold several offers over time; recorded_at orders them.",
        ];
        if (unmapped) {
          notes.push(
            "An UNMAPPED offer_id appeared. A new offer has shipped and this server's hardcoded mapping needs updating in src/domain.ts.",
          );
        }
        return rowsResponse(result, { notes });
      }),
  );
}
