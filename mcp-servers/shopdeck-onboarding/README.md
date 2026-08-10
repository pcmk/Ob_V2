# ShopDeck Onboarding MCP Server

An MCP server exposing the ShopDeck seller-onboarding funnel — the `nushop`
BigQuery dataset — as tools an agent can use without re-deriving the domain's
correctness rules on every question.

The point of this server is not that it can run SQL. It is that the rules which
make a technically-valid query still *wrong* are applied inside the tools, where
they cannot be forgotten: the 48-hour `meta_setup` → `fund_transfer` policy and
its pre/post-deploy split, milestone alias merging, task de-duplication, cohort
maturity gates, and mandatory partition filters.

## Setup

```bash
npm install
npm run build
```

Authentication uses Application Default Credentials — the server never handles
credentials itself:

```bash
gcloud auth application-default login
# or point GOOGLE_APPLICATION_CREDENTIALS at a service-account key
```

The account needs **BigQuery Job User** on the project and **Data Viewer** on
the dataset.

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
    "shopdeck-onboarding": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-servers/shopdeck-onboarding/dist/index.js"],
      "env": { "SHOPDECK_BQ_PROJECT": "blitzscale-prod-project" }
    }
  }
}
```

Verify interactively with `npm run inspect`.

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
