/**
 * The orientation tool. Serves the domain model so the agent can plan a query
 * without guessing at table names, task order, or the business rules that make
 * a technically-correct query still wrong.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { safeHandler, type ToolResponse } from "../format.js";
import {
  BUSINESS_RULES,
  CARDINALITY_NOTES,
  CRM_DEPLOY_TS_UTC,
  DEFAULT_SLA_HOURS,
  MILESTONE_ALIASES,
  OFFERS,
  PARTITIONED_TABLES,
  POC_OWNERSHIP,
  TASK_ORDER,
  UNPARTITIONED_TABLES,
} from "../domain.js";

const TABLE_DOCS: Record<string, { grain: string; keyColumns: string[] }> = {
  ob_tickets: {
    grain: "One row per (seller x journey attempt). Usually one per seller; more when a seller re-onboards.",
    keyColumns: [
      "id -- ticket id, matches ob_tasks.ticket_id",
      "seller_id",
      "created_at -- partition column, ticket creation (UTC)",
      "ob_poc / gtg_poc / gtg_approver_poc / cataloging_poc / website_poc / qc_poc / creatives_poc -- user ids, join to users._id",
      "journey_questionnaire -- JSON: category, catalogue_size, catalogue_sharing_preference (array), marketing_timeline",
    ],
  },
  ob_tasks: {
    grain: "Many rows per ticket (up to 12+). Duplicates of one type occur when a stuck task is re-created.",
    keyColumns: [
      "id -- task id, referenced by exotel_calls.entity_id when entity='ob-task'",
      "seller_id, ticket_id",
      "type -- one of the 12 task types",
      "status -- completed | pending | cancelled | blocked",
      "assigned_poc -- who actually worked it; join to users._id",
      "completed_at -- nullable",
      "created_at -- partition column",
    ],
  },
  seller_journey_milestones: {
    grain: "Many rows per ticket: 5 milestone types, plus alias spellings.",
    keyColumns: [
      "ticket_id",
      "step_name -- aliased; merge per MILESTONE_ALIASES",
      "status -- filter to 'completed'",
      "updated_at -- completion time. NOT created_at",
      "created_at -- partition column",
    ],
  },
  users: {
    grain: "One row per user. The only unpartitioned table.",
    keyColumns: ["_id -- matches POC fields", "first_name, last_name, email"],
  },
  exotel_calls: {
    grain: "Many rows per task; one per call placed.",
    keyColumns: [
      "entity -- filter to 'ob-task'",
      "entity_id -- the ob_tasks.id",
      "exotel_call_sid -- joins to exotel_call_details.sid",
      "created_at -- partition column",
    ],
  },
  exotel_call_details: {
    grain: "Roughly 1:1 with exotel_calls via sid.",
    keyColumns: [
      "sid",
      "call_type -- lowercase inbound | outbound",
      "status -- uppercase CONNECTED | BUSY | NO_ANSWER | FAILED",
      "created_at -- partition column",
    ],
  },
  seller_offers: {
    grain: "Many rows per seller; offers are assigned and reassigned over time.",
    keyColumns: [
      "seller_id, offer_id -- names are not in any table, see the offers topic",
      "status, recorded_at, start_date, end_date, is_zero_percentage_commission",
      "created_at -- partition column",
    ],
  },
};

const TOPICS = [
  "all",
  "tables",
  "tasks",
  "milestones",
  "pocs",
  "offers",
  "business_rules",
  "pitfalls",
] as const;

export function registerReferenceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "shopdeck_describe_schema",
    {
      title: "Describe the onboarding data model",
      description:
        "Return the ShopDeck onboarding funnel's structure: tables and their grain, the 12 tasks in execution order, milestone aliases, POC ownership, offer id-to-name mapping, the business rules that change how results must be read (notably the 48-hour meta_setup to fund_transfer policy), and the cardinality traps that silently produce wrong numbers. Call this before composing any non-trivial query.",
      inputSchema: {
        topic: z
          .enum(TOPICS)
          .default("all")
          .describe("Restrict the answer to one area. Defaults to everything."),
      },
      outputSchema: {
        project: z.string(),
        dataset: z.string(),
        topic: z.string(),
        reference: z.record(z.any()).describe("The requested domain reference."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic }): Promise<ToolResponse> =>
      safeHandler(async () => {
        const want = (name: string) => topic === "all" || topic === name;
        const reference: Record<string, unknown> = {};

        if (want("tables")) {
          reference.tables = Object.fromEntries(
            Object.entries(TABLE_DOCS).map(([name, doc]) => [
              name,
              {
                fully_qualified: `${ctx.config.projectId}.${ctx.config.dataset}.${name}`,
                partitioned: (PARTITIONED_TABLES as readonly string[]).includes(name),
                ...doc,
              },
            ]),
          );
          reference.partition_rule =
            `Partitioned tables (${PARTITIONED_TABLES.join(", ")}) reject queries without a created_at filter. ` +
            `Unpartitioned: ${UNPARTITIONED_TABLES.join(", ")}. Filter join-side tables inside a CTE or in the ON clause -- ` +
            "a WHERE clause after the JOIN is evaluated too late.";
        }

        if (want("tasks")) {
          reference.task_order = TASK_ORDER;
          reference.default_sla_hours = DEFAULT_SLA_HOURS;
          reference.sla_caveat =
            "These SLA hours are placeholders, not ops-signed-off targets. No per-task SLA is documented in the data model. Override them per call.";
        }

        if (want("milestones")) {
          reference.milestone_aliases = MILESTONE_ALIASES;
          reference.milestone_note =
            "Milestones are 5 coarse stages; tasks are the 12 granular steps. Launch is confirmed by the Launch milestone reaching 'completed', not by all tasks completing.";
        }

        if (want("pocs")) {
          reference.poc_ownership = POC_OWNERSHIP;
          reference.poc_note =
            "Ticket-level POC fields carry the nominal owner. ob_tasks.assigned_poc carries whoever actually worked the task; the two diverge when a ticket is reassigned mid-flow.";
        }

        if (want("offers")) {
          reference.offers = OFFERS;
          reference.offer_note =
            "Offer names exist only in code. An offer_id absent from this list means a new offer shipped and this mapping is stale.";
        }

        if (want("business_rules")) {
          reference.business_rules = BUSINESS_RULES;
          reference.crm_deploy_ts_utc = CRM_DEPLOY_TS_UTC;
        }

        if (want("pitfalls")) {
          reference.cardinality_notes = CARDINALITY_NOTES;
        }

        const summary = [
          `**ShopDeck onboarding** — \`${ctx.config.projectId}.${ctx.config.dataset}\` (topic: ${topic})`,
          "",
          "```json",
          JSON.stringify(reference, null, 2),
          "```",
        ].join("\n");

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            project: ctx.config.projectId,
            dataset: ctx.config.dataset,
            topic,
            reference,
          },
        };
      }),
  );
}
