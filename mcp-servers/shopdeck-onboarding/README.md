# shopdeck-mcp-server

An MCP server (stdio) exposing the ShopDeck seller-onboarding funnel — the `nushop`
BigQuery dataset — as tools an agent can use without re-deriving the domain's
correctness rules on every question.

The point of this server is not that it can run SQL. It is that the rules which
make a technically-valid query still *wrong* are applied inside the tools, where
they cannot be forgotten: the 48-hour `meta_setup` → `fund_transfer` policy and
its pre/post-deploy split, milestone alias merging, task de-duplication, cohort
maturity gates, and mandatory partition filters.

## Setup

### 1. Install

```bash
npm install
```

### 2. Authenticate

Authentication uses Application Default Credentials — the server never handles
credentials itself, and none are stored in this repo:

```bash
gcloud auth application-default login
# or point GOOGLE_APPLICATION_CREDENTIALS at a service-account key
```

Your account needs **two** roles, and one is not enough on its own:

| Role | Scope | Why |
|---|---|---|
| BigQuery Job User | project | Permission to *run* queries |
| BigQuery Data Viewer | dataset | Permission to *read* the tables |

Data Viewer alone is the usual near-miss: you can see the schema, and every
query fails.

### 3. Point it at your dataset

```bash
cp .env.example .env      # then edit, or just export the variables
export SHOPDECK_BQ_PROJECT=blitzscale-prod-project
export SHOPDECK_BQ_DATASET=nushop
```

### 4. Preflight

```bash
npm run check
```

This walks the exact path the server takes — credentials, project, dataset,
region, every expected table and its partition column, then a dry-run query that
bills nothing — and prints the specific fix for whatever is wrong. Run it before
touching any client config; it turns the two failures that produce misleading
errors into plain statements:

- **Region mismatch.** If your dataset lives in `asia-south1` and the server is
  configured for `US`, jobs get created in one region and polled in another, and
  BigQuery reports `Not found: Job` — which reads like a bug, not a config
  error. The check reads the dataset's real region and tells you the value to
  set. **Given ShopDeck operates out of Bengaluru, expect `asia-south1` rather
  than the `US` default.**
- **Missing Job User.** Reported as "cannot run queries" with the role to grant,
  rather than a raw 403.

### 5. Build and register

```bash
npm run build
npm run inspect      # optional: exercise the tools interactively first
```

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SHOPDECK_BQ_PROJECT` | *(required)* | GCP project, e.g. `blitzscale-prod-project`. Falls back to `GOOGLE_CLOUD_PROJECT`. |
| `SHOPDECK_BQ_DATASET` | `nushop` | Dataset name. |
| `SHOPDECK_BQ_LOCATION` | `US` | Must match the dataset's region or every job 404s. |
| `SHOPDECK_MAX_BYTES_BILLED` | `21474836480` (20 GB) | Ceiling per query. Jobs above it are refused before they bill. |
| `SHOPDECK_DEFAULT_LOOKBACK_MONTHS` | `6` | Default partition window. |
| `SHOPDECK_MAX_ROWS` | `500` | Row cap per response. |

### Client registration

```json
{
  "mcpServers": {
    "shopdeck": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-servers/shopdeck-onboarding/dist/index.js"],
      "env": {
        "SHOPDECK_BQ_PROJECT": "blitzscale-prod-project",
        "SHOPDECK_BQ_DATASET": "nushop",
        "SHOPDECK_BQ_LOCATION": "asia-south1"
      }
    }
  }
}
```

Set `SHOPDECK_BQ_LOCATION` to whatever `npm run check` reported — the client
environment does not inherit your shell, so exporting it in a terminal is not
enough.

## Conventions shared by every tool

**`response_format`** — `markdown` (default) renders a readable table; `json`
returns the raw rows. `structuredContent` carries the rows either way, so a
programmatic caller never needs to parse the text.

**Pagination** — listing tools take `limit` (default 50) and `offset`, and
return `has_more` plus `next_offset`. They fetch one row beyond the limit to
establish `has_more` exactly. `total_count` is `null` on paginated queries: a
true total needs a second `COUNT(*)` over the same partitions, which would
double the scan cost for a number nobody usually needs.

**`notes`** — every response carries the caveats that would otherwise cause the
numbers to be misread: maturity gates, era splits, partial days, placeholder
SLA thresholds.

## Examples

**Investigating an escalation.** Start with the verdict, then get the timeline,
then pull the evidence:

```jsonc
// 1. What is blocking them, and whose fault is it?
{"tool": "shopdeck_diagnose_escalation",
 "args": {"seller_ids": ["66f1a2b3c4d5e6f708192a3b"]}}

// 2. The full step-by-step for the ticket behind that verdict
{"tool": "shopdeck_get_seller_journey",
 "args": {"seller_ids": ["66f1a2b3c4d5e6f708192a3b"]}}

// 3. Every call attempt, to attach to the escalation reply
{"tool": "shopdeck_get_calls",
 "args": {"seller_ids": ["66f1a2b3c4d5e6f708192a3b"], "limit": 100}}
```

**POC performance.** Volume and timeliness are different questions:

```jsonc
// Worst adherence first, with your own SLA targets rather than the placeholders
{"tool": "shopdeck_poc_sla_adherence",
 "args": {"window_days": 30, "sla_overrides": {"cagd": 24, "gtg": 12}}}

// Who is carrying the load this week
{"tool": "shopdeck_poc_throughput", "args": {"window_days": 7}}

// One POC, one task type, as JSON for further processing
{"tool": "shopdeck_poc_sla_adherence",
 "args": {"poc_name": "Priya", "task_types": ["cagd"], "response_format": "json"}}
```

**Funnel health.** Cohorts, stalls, and the escape hatch:

```jsonc
// Weekly conversion to fund_transfer, maturity gate applied automatically
{"tool": "shopdeck_funnel_conversion",
 "args": {"target_task": "fund_transfer", "conversion_days": 14,
          "cohort_from": "2026-05-01"}}

// Sellers past meta_setup but stuck before funding for over a week
{"tool": "shopdeck_find_stuck_sellers",
 "args": {"from_task": "meta_setup", "to_task": "fund_transfer",
          "min_days_stuck": 7, "limit": 50}}

// Check the scan size before running something broad
{"tool": "shopdeck_run_sql",
 "args": {"sql": "SELECT type, COUNT(*) c FROM `proj.nushop.ob_tasks` WHERE created_at >= TIMESTAMP('2026-07-01') GROUP BY type",
          "dry_run": true}}
```

## Resources

`shopdeck://schema` serves the same domain reference as
`shopdeck_describe_schema`, for clients that prefer attaching reference material
as context rather than calling a tool for it.

## Tools

| Tool | What it answers |
|---|---|
| `shopdeck_describe_schema` | Tables and grain, the 12 tasks in order, milestone aliases, POC ownership, offer mapping, business rules, cardinality traps. Call it first. |
| `shopdeck_get_seller_journey` | The full 12-step grid per ticket, with POC, timings, handoff gaps and call activity. |
| `shopdeck_diagnose_escalation` | Per ticket: the blocking step and a classified root cause. |
| `shopdeck_find_stuck_sellers` | Sellers who cleared one task but not a later one after N days. |
| `shopdeck_poc_sla_adherence` | SLA adherence by POC and task type. |
| `shopdeck_poc_throughput` | Completion volume and median turnaround by POC. |
| `shopdeck_funnel_conversion` | Weekly cohort conversion with a maturity gate. |
| `shopdeck_list_tickets` | Ticket search with POC roster, era, questionnaire. |
| `shopdeck_list_tasks` | Task-level search. |
| `shopdeck_get_milestones` | Milestone history with aliases merged. |
| `shopdeck_get_calls` | Raw call log — the evidence trail. |
| `shopdeck_get_offers` | Offer assignments with ids resolved to names. |
| `shopdeck_run_sql` | Guarded read-only escape hatch. |

Every tool is annotated `readOnlyHint: true`. The server issues no writes of any
kind, and `shopdeck_run_sql` rejects anything that is not a single `SELECT`/`WITH`.

## Design notes

**Absence is data.** `shopdeck_get_seller_journey` builds its rows by crossing
tickets with the canonical task list, not by reading `ob_tasks`. A task that was
never created therefore appears as `DOES_NOT_EXIST` rather than vanishing. That
distinction matters: post-deploy, `fund_transfer` is auto-created 48h after
`meta_setup`, so a silent auto-creation failure is invisible to any query built
off the task table alone.

**Cost guard before correctness guard.** Every query is dry-run first and refused
if it exceeds the byte ceiling. The partitioned tables here are wide enough that
one forgotten filter is a genuinely expensive mistake.

**Errors are instructions.** Permission, partition, location and cost failures
each return a specific next step rather than a stack trace, so the agent can
recover without a human.

## Known limitations

- **SLA thresholds in `src/domain.ts` are placeholders.** No per-task SLA is
  documented anywhere in the onboarding data model; the only codified time rule
  is the 48-hour policy. `shopdeck_poc_sla_adherence` says so in its own output
  until you pass real targets via `sla_overrides` or edit the defaults.
- **Escalations are not in this dataset.** `shopdeck_diagnose_escalation`
  reconstructs the conditions behind an escalation. It cannot read who raised
  one, when, or why.
- **Offer names are hardcoded.** A new offer shows up as `UNMAPPED` until
  `OFFERS` in `src/domain.ts` is updated. The tool flags this when it happens.
- **SLA measurement is wall-clock, not business hours.** Work landing on a
  Friday evening burns the weekend.
- **Input schemas are not `.strict()`.** `registerTool` takes a Zod raw shape
  and builds the object itself, so there is no place to reject unknown keys.
  Every field is individually constrained instead; unknown extras are ignored
  rather than refused.
- **`total_count` is null on paginated tools.** Computing it means a second
  scan. `has_more` is exact, which covers the case that actually matters.
