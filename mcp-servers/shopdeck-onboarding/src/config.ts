/**
 * Server configuration, resolved from the environment at startup.
 *
 * Nothing here is secret: BigQuery auth comes from Application Default
 * Credentials (gcloud auth application-default login, or a service-account key
 * pointed at by GOOGLE_APPLICATION_CREDENTIALS). The server never handles
 * credentials itself.
 */

export interface Config {
  /** GCP project holding the dataset. */
  projectId: string;
  /** Dataset name. Practically always `nushop`. */
  dataset: string;
  /** BigQuery job location; must match the dataset's region. */
  location: string;
  /** Hard ceiling on bytes billed per query. Jobs above this are refused. */
  maxBytesBilled: number;
  /** Default partition lookback for tools that do not take an explicit window. */
  defaultLookbackMonths: number;
  /** Ceiling on rows returned to the model in one response. */
  maxRows: number;
}

const DEFAULTS = {
  dataset: "nushop",
  location: "US",
  // 20 GB. These tables are wide; an unfiltered scan will blow past this,
  // which is exactly the point -- it fails before it bills.
  maxBytesBilled: 20 * 1024 ** 3,
  defaultLookbackMonths: 6,
  maxRows: 500,
} as const;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive number, got ${JSON.stringify(raw)}.`,
    );
  }
  return Math.floor(parsed);
}

export function loadConfig(): Config {
  const projectId =
    process.env.SHOPDECK_BQ_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;

  if (!projectId) {
    throw new Error(
      "No BigQuery project configured. Set SHOPDECK_BQ_PROJECT (e.g. " +
        "blitzscale-prod-project) or GOOGLE_CLOUD_PROJECT before starting the server.",
    );
  }

  return {
    projectId,
    dataset: process.env.SHOPDECK_BQ_DATASET ?? DEFAULTS.dataset,
    location: process.env.SHOPDECK_BQ_LOCATION ?? DEFAULTS.location,
    maxBytesBilled: intFromEnv(
      "SHOPDECK_MAX_BYTES_BILLED",
      DEFAULTS.maxBytesBilled,
    ),
    defaultLookbackMonths: intFromEnv(
      "SHOPDECK_DEFAULT_LOOKBACK_MONTHS",
      DEFAULTS.defaultLookbackMonths,
    ),
    maxRows: intFromEnv("SHOPDECK_MAX_ROWS", DEFAULTS.maxRows),
  };
}
