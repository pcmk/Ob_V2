/**
 * Canonical ShopDeck onboarding domain knowledge.
 *
 * This is the single source of truth for the funnel's shape. Tools read from
 * here rather than restating it, so correcting a fact once corrects it
 * everywhere -- including in `shopdeck_describe_schema`, which serves this file
 * to the model so it can orient itself without guessing.
 */

/** Every table except `users` is partitioned on created_at and rejects unfiltered reads. */
export const PARTITIONED_TABLES = [
  "ob_tickets",
  "ob_tasks",
  "seller_journey_milestones",
  "exotel_calls",
  "exotel_call_details",
  "seller_offers",
] as const;

export const UNPARTITIONED_TABLES = ["users"] as const;

/**
 * CRM enforcement of the 48-hour meta_setup -> fund_transfer gap went live at
 * this instant (Jul 8 2026, 7:52 PM IST). Tickets created before it are
 * grandfathered onto the old workflow, where the fund_transfer task was created
 * immediately and the POC was expected to wait manually.
 */
export const CRM_DEPLOY_TS_UTC = "2026-07-08 14:22:00 UTC";

/** The 48-hour policy itself went live on-ground (verbal instruction) on Jul 1 2026. */
export const POLICY_START_DATE = "2026-07-01";

export const META_TO_FT_WAIT_HOURS = 48;

export interface TaskDef {
  step: number;
  type: string;
  /** Which POC field on ob_tickets nominally owns this task. */
  ownerTeam: string;
  /** Column on ob_tickets carrying that owner's user id. */
  ticketPocColumn: string;
  description: string;
}

/** The 12 tasks, in execution order. */
export const TASK_ORDER: readonly TaskDef[] = [
  { step: 1, type: "cagd", ownerTeam: "ob_poc", ticketPocColumn: "ob_poc", description: "Collect and get documents from the seller (KYC, PAN, GST, bank)." },
  { step: 2, type: "gtg", ownerTeam: "gtg_poc", ticketPocColumn: "gtg_poc", description: "Green-To-Go internal check; an approver reviews the seller." },
  { step: 3, type: "catalogue_config", ownerTeam: "cataloging_poc", ticketPocColumn: "cataloging_poc", description: "Set up catalogue structure and product data." },
  { step: 4, type: "poc_intro", ownerTeam: "ob_poc", ticketPocColumn: "ob_poc", description: "POC introduction call with the seller." },
  { step: 5, type: "web_config", ownerTeam: "website_poc", ticketPocColumn: "website_poc", description: "Configure website settings." },
  { step: 6, type: "website_discussion", ownerTeam: "website_poc", ticketPocColumn: "website_poc", description: "Website design discussion with the seller." },
  { step: 7, type: "domain_transfer", ownerTeam: "website_poc", ticketPocColumn: "website_poc", description: "Domain registration or transfer (GoDaddy partner)." },
  { step: 8, type: "meta_setup", ownerTeam: "ob_poc", ticketPocColumn: "ob_poc", description: "Facebook OAuth and Meta ad-account setup." },
  { step: 9, type: "price_parity_check", ownerTeam: "qc_poc", ticketPocColumn: "qc_poc", description: "Verify pricing matches across channels." },
  { step: 10, type: "fund_transfer", ownerTeam: "ob_poc", ticketPocColumn: "ob_poc", description: "Seller funds their ad account; unlocks launch. Subject to the 48h policy." },
  { step: 11, type: "qc_check", ownerTeam: "qc_poc", ticketPocColumn: "qc_poc", description: "Final quality check." },
  { step: 12, type: "seller_consent", ownerTeam: "ob_poc", ticketPocColumn: "ob_poc", description: "Final seller consent to go live." },
] as const;

/** Typed as a non-empty tuple so it can be handed straight to z.enum(). */
export const TASK_TYPES: [string, ...string[]] = TASK_ORDER.map((t) => t.type) as [
  string,
  ...string[],
];

export function taskByType(type: string): TaskDef | undefined {
  return TASK_ORDER.find((t) => t.type === type);
}

/**
 * Default SLA targets per task, in wall-clock hours.
 *
 * WARNING: these are placeholders. No per-task SLA is documented in the
 * onboarding data model -- the only codified time rule is the 48h meta->ft
 * policy. Override them per call via the sla_overrides argument, or set them
 * here once ops signs off.
 */
export const DEFAULT_SLA_HOURS: Readonly<Record<string, number>> = {
  cagd: 48,
  gtg: 24,
  catalogue_config: 72,
  poc_intro: 24,
  web_config: 48,
  website_discussion: 48,
  domain_transfer: 72,
  meta_setup: 24,
  price_parity_check: 24,
  fund_transfer: 48,
  qc_check: 24,
  seller_consent: 24,
};

/**
 * Milestone step_name values carry aliases in the source data. Filtering on a
 * single spelling silently drops rows, so always merge.
 */
export const MILESTONE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  document: ["Document"],
  catalogue: ["Catalogue", "Catalogue Creation", "Catalogue Sharing"],
  marketing: ["Marketing", "Marketing & Platform setup"],
  website: ["Website", "Website Creation"],
  launch: ["Launch"],
};

export const MILESTONES = Object.keys(MILESTONE_ALIASES);

/** POC role -> the tasks that role owns. */
export const POC_OWNERSHIP: Readonly<Record<string, readonly string[]>> = {
  ob_poc: ["cagd", "poc_intro", "meta_setup", "fund_transfer", "seller_consent"],
  gtg_poc: ["gtg"],
  gtg_approver_poc: [],
  cataloging_poc: ["catalogue_config"],
  website_poc: ["web_config", "website_discussion", "domain_transfer"],
  qc_poc: ["price_parity_check", "qc_check"],
  creatives_poc: [],
};

export interface OfferDef {
  offerId: string;
  offerName: string;
  trigger: string;
  appliedBy: string;
}

/** Offer names live in code, not in any table. New offers must be added here. */
export const OFFERS: readonly OfferDef[] = [
  { offerId: "XBneu1fr", offerName: "5K Credit + 0% Commission Combo", trigger: "hits 15000", appliedBy: "mark_ops" },
  { offerId: "7mZ2BUrf", offerName: "5K Credit After 10K Spend", trigger: "hits 10000", appliedBy: "mark_ops" },
  { offerId: "oHG3ohja", offerName: "5K Credit After 15K Spend", trigger: "hits 15000", appliedBy: "mark_ops" },
  { offerId: "E2LBHeyl", offerName: "5K Deposit + 5K Marketing", trigger: "go_live", appliedBy: "mark_ops" },
  { offerId: "q_4WEFzQ", offerName: "2K Deposit + 5K Marketing", trigger: "go_live", appliedBy: "mark_ops" },
  { offerId: "YjCrnYRz", offerName: "0% Commission for First 30 Days", trigger: "none", appliedBy: "finance" },
];

/** Cardinality traps that produce wrong numbers when ignored. */
export const CARDINALITY_NOTES: readonly string[] = [
  "A seller can have more than one ticket (re-onboarding). Grouping by seller can merge two distinct journeys.",
  "A ticket can carry duplicate rows of the same task type when a stuck task is re-created. De-duplicate with the newest row per (ticket_id, type) unless task events are the unit of analysis.",
  "Milestone step_name has aliases; merge them or undercount.",
  "ob_tasks.assigned_poc can differ from the ticket-level POC when a ticket is reassigned mid-flow. Use assigned_poc to answer 'who actually did this'.",
  "Absence of a task row is meaningful: it means the task was never created, which is not the same as a task with status 'cancelled'.",
  "seller_journey_milestones completion time is updated_at, not created_at.",
];

export const BUSINESS_RULES: readonly string[] = [
  `The 48-hour policy: from ${POLICY_START_DATE}, POCs must wait ${META_TO_FT_WAIT_HOURS}h between completing meta_setup and completing fund_transfer, because Meta flags ad accounts funded immediately after setup.`,
  `CRM enforcement deployed at ${CRM_DEPLOY_TS_UTC}. Tickets created at or after that instant get the fund_transfer task auto-created 48h after meta_setup completes. Earlier tickets are grandfathered: the task was created immediately and the wait was manual.`,
  "Consequence for analysis: a pre-deploy ticket completing fund_transfer with a near-zero task age is correct behaviour; a post-deploy ticket doing the same is a bug. Always split fund_transfer analysis by ticket era.",
  "Launch is signalled by the Launch milestone reaching status 'completed'. All 12 tasks completing is necessary but not sufficient.",
  "ShopDeck earns commission only on delivered orders, so a seller stalled in onboarding is direct lost revenue.",
  "Storage is UTC; the business operates in IST (Asia/Kolkata, UTC+5:30). Render timestamps in IST for humans.",
];
