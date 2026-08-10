import type { BigQueryClient } from "../bigquery.js";
import type { Config } from "../config.js";

/** Shared dependencies handed to every tool registration function. */
export interface ToolContext {
  bq: BigQueryClient;
  config: Config;
}
