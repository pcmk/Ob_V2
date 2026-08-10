#!/usr/bin/env node
/**
 * Connection preflight.
 *
 * Run this before wiring the server into an MCP client. It walks the same path
 * the server takes -- credentials, project, dataset, region, tables, query
 * permission -- and stops at the first thing that is actually wrong, with the
 * specific fix rather than a stack trace.
 *
 *   node scripts/check-connection.mjs
 *
 * Runs on the raw source (no build needed), so it works immediately after
 * `npm install`.
 */

import { BigQuery } from "@google-cloud/bigquery";

const EXPECTED_TABLES = [
  "ob_tickets",
  "ob_tasks",
  "seller_journey_milestones",
  "users",
  "exotel_calls",
  "exotel_call_details",
  "seller_offers",
];

const PARTITIONED = new Set(
  EXPECTED_TABLES.filter((t) => t !== "users"),
);

const projectId =
  process.env.SHOPDECK_BQ_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
const dataset = process.env.SHOPDECK_BQ_DATASET ?? "nushop";
const configuredLocation = process.env.SHOPDECK_BQ_LOCATION ?? "US";

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failed = false;

function pass(label, detail = "") {
  console.log(`${green("PASS")}  ${label}${detail ? dim("  " + detail) : ""}`);
}
function warn(label, detail = "") {
  console.log(`${yellow("WARN")}  ${label}${detail ? dim("  " + detail) : ""}`);
}
function fail(label, fixes) {
  failed = true;
  console.log(`${red("FAIL")}  ${label}`);
  for (const fix of fixes) console.log(`      → ${fix}`);
}

console.log("\nShopDeck MCP server — connection preflight\n");

// ---------------------------------------------------------------------------
// 1. Configuration present
// ---------------------------------------------------------------------------
if (!projectId) {
  fail("No project configured", [
    "export SHOPDECK_BQ_PROJECT=blitzscale-prod-project",
    "Or set GOOGLE_CLOUD_PROJECT, which the server also accepts.",
  ]);
  console.log("\nCannot continue without a project.\n");
  process.exit(1);
}
pass("Project configured", projectId);
console.log(dim(`      dataset=${dataset}  location=${configuredLocation}\n`));

const bq = new BigQuery({ projectId });

// ---------------------------------------------------------------------------
// 2. Credentials resolve and the project is reachable
// ---------------------------------------------------------------------------
try {
  await bq.getDatasets({ maxResults: 1 });
  pass("Credentials accepted", "Application Default Credentials resolved");
} catch (error) {
  const message = error?.message ?? String(error);
  if (/could not load the default credentials|ENOENT|no credentials/i.test(message)) {
    fail("No credentials found", [
      "gcloud auth application-default login",
      "Or: export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json",
    ]);
  } else if (/permission|denied|403/i.test(message)) {
    fail(`Credentials rejected by ${projectId}`, [
      "Your account needs the BigQuery Job User role on this project.",
      "Confirm you are on the right account: gcloud auth list",
    ]);
  } else {
    fail(`Could not reach the project: ${message}`, [
      "Check the project id for typos.",
      "Confirm network access to bigquery.googleapis.com.",
    ]);
  }
  console.log("\nStopping: nothing below can pass without credentials.\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Dataset exists, and its region matches what the server is configured with
// ---------------------------------------------------------------------------
let datasetLocation = null;
try {
  const [metadata] = await bq.dataset(dataset).getMetadata();
  datasetLocation = metadata.location;
  pass("Dataset found", `${projectId}.${dataset}`);

  if (datasetLocation?.toUpperCase() !== configuredLocation.toUpperCase()) {
    // This is the single most common cause of "Not found: Job" errors: the job
    // is created in one region and polled in another.
    fail(
      `Region mismatch: dataset is in ${datasetLocation}, server configured for ${configuredLocation}`,
      [
        `export SHOPDECK_BQ_LOCATION=${datasetLocation}`,
        "Left unfixed, every query fails with a confusing 'Not found: Job' error.",
      ],
    );
  } else {
    pass("Region matches", datasetLocation);
  }
} catch (error) {
  const message = error?.message ?? String(error);
  if (/not found|404/i.test(message)) {
    fail(`Dataset ${dataset} not found in ${projectId}`, [
      "Check SHOPDECK_BQ_DATASET spelling.",
      "List what you can see: bq ls --project_id=" + projectId,
    ]);
  } else {
    fail(`Cannot read dataset metadata: ${message}`, [
      "Your account needs BigQuery Data Viewer on the dataset.",
    ]);
  }
}

// ---------------------------------------------------------------------------
// 4. Expected tables exist, with the partition column the server relies on
// ---------------------------------------------------------------------------
console.log();
for (const name of EXPECTED_TABLES) {
  try {
    const [metadata] = await bq.dataset(dataset).table(name).getMetadata();
    const fields = (metadata.schema?.fields ?? []).map((f) => f.name);
    const partitionField = metadata.timePartitioning?.field;
    const isPartitioned = Boolean(metadata.timePartitioning);
    const requiresFilter = metadata.requirePartitionFilter === true ||
      metadata.timePartitioning?.requirePartitionFilter === true;

    if (PARTITIONED.has(name)) {
      if (!fields.includes("created_at")) {
        fail(`${name}: no created_at column`, [
          "Every tool filters on created_at. The schema has drifted from what this server assumes.",
          `Columns present: ${fields.slice(0, 12).join(", ")}${fields.length > 12 ? " …" : ""}`,
        ]);
      } else if (!isPartitioned) {
        warn(
          `${name}: created_at present but table is not partitioned`,
          "queries will work but scan more than expected",
        );
      } else if (partitionField && partitionField !== "created_at") {
        warn(
          `${name}: partitioned on ${partitionField}, not created_at`,
          "the server's filters will not prune partitions",
        );
      } else {
        pass(
          `${name}`,
          `partitioned on created_at${requiresFilter ? ", filter required" : ""}`,
        );
      }
    } else {
      pass(`${name}`, `${fields.length} columns, unpartitioned as expected`);
    }
  } catch (error) {
    const message = error?.message ?? String(error);
    if (/not found|404/i.test(message)) {
      fail(`Table ${name} not found`, [
        "The server assumes this table exists. Either the dataset is wrong or the schema has changed.",
      ]);
    } else {
      fail(`${name}: ${message}`, ["Check Data Viewer permission on the dataset."]);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Query permission, via a dry run that bills nothing
// ---------------------------------------------------------------------------
console.log();
try {
  const query = `
    SELECT COUNT(*) AS n
    FROM \`${projectId}.${dataset}.ob_tickets\`
    WHERE created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY))
      AND created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))`;

  const [job] = await bq.createQueryJob({
    query,
    location: datasetLocation ?? configuredLocation,
    dryRun: true,
  });

  const bytes = Number(job.metadata?.statistics?.totalBytesProcessed ?? 0);
  const mb = (bytes / 1024 ** 2).toFixed(1);
  pass("Query permission confirmed", `7-day ticket scan ≈ ${mb} MB`);

  if (bytes > 20 * 1024 ** 3) {
    warn(
      "A 7-day scan already exceeds the default 20 GB ceiling",
      "raise SHOPDECK_MAX_BYTES_BILLED or expect refusals",
    );
  }
} catch (error) {
  const message = error?.message ?? String(error);
  if (/permission|denied|403/i.test(message)) {
    fail("Cannot run queries", [
      "Your account needs BigQuery Job User on the project (Data Viewer alone is not enough).",
    ]);
  } else if (/partition/i.test(message)) {
    fail(`Partition filter rejected: ${message}`, [
      "The table may require a filter on a different column than created_at.",
    ]);
  } else {
    fail(`Dry run failed: ${message}`, ["See the message above for the cause."]);
  }
}

// ---------------------------------------------------------------------------
console.log();
if (failed) {
  console.log(red("Preflight failed.") + " Fix the items above, then re-run.\n");
  process.exit(1);
}
console.log(green("Preflight passed.") + " The server can reach your data.\n");
console.log("Next:");
console.log("  npm run build");
console.log("  npm run inspect        # exercise the tools interactively");
console.log("  then add the client config from the README\n");
