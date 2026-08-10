-- =============================================================================
-- POC-LEVEL SLA ADHERENCE
-- Grain: one row per (assigned POC x task type), trailing 30 days.
--
-- SLA clock      : ob_tasks.created_at -> completed_at (task turnaround only).
--                  This attributes to a POC only the time the task actually sat
--                  in their queue -- they are not penalised for upstream delay.
-- POC attribution: ob_tasks.assigned_poc (who actually worked it). The
--                  ticket-level owner is carried alongside so you can see where
--                  mid-flow reassignment moved the blame.
-- Open tasks     : a still-open task already past its SLA counts as a breach.
--                  An open task still inside its SLA has an undetermined
--                  outcome, so it is EXCLUDED from the denominator and reported
--                  separately as `open_in_flight`.
--
-- !! THRESHOLDS BELOW ARE PLACEHOLDERS. No per-task SLA is documented anywhere
-- !! in the onboarding data model. Replace sla_config with the real ops targets
-- !! before anyone treats these percentages as fact.
-- =============================================================================

WITH
-- ---------------------------------------------------------------------------
-- 1. EDIT ME. SLA target per task type, in wall-clock hours.
--    `funnel_step` is only used for output ordering.
-- ---------------------------------------------------------------------------
sla_config AS (
  SELECT * FROM UNNEST([
    STRUCT('cagd'               AS task_type,  1 AS funnel_step, 48 AS sla_hours),
    STRUCT('gtg'                AS task_type,  2 AS funnel_step, 24 AS sla_hours),
    STRUCT('catalogue_config'   AS task_type,  3 AS funnel_step, 72 AS sla_hours),
    STRUCT('poc_intro'          AS task_type,  4 AS funnel_step, 24 AS sla_hours),
    STRUCT('web_config'         AS task_type,  5 AS funnel_step, 48 AS sla_hours),
    STRUCT('website_discussion' AS task_type,  6 AS funnel_step, 48 AS sla_hours),
    STRUCT('domain_transfer'    AS task_type,  7 AS funnel_step, 72 AS sla_hours),
    STRUCT('meta_setup'         AS task_type,  8 AS funnel_step, 24 AS sla_hours),
    STRUCT('price_parity_check' AS task_type,  9 AS funnel_step, 24 AS sla_hours),
    STRUCT('fund_transfer'      AS task_type, 10 AS funnel_step, 48 AS sla_hours),
    STRUCT('qc_check'           AS task_type, 11 AS funnel_step, 24 AS sla_hours),
    STRUCT('seller_consent'     AS task_type, 12 AS funnel_step, 24 AS sla_hours)
  ])
),

-- ---------------------------------------------------------------------------
-- 2. Task rows. Partition window (120d) is deliberately much wider than the
--    30d reporting window: a task completed yesterday may have been created
--    months ago, and it must still be in scope.
--    Cancelled tasks are dropped -- they were withdrawn, not missed.
-- ---------------------------------------------------------------------------
tasks_filtered AS (
  SELECT
    ot.id            AS task_id,
    ot.seller_id,
    ot.ticket_id,
    ot.type          AS task_type,
    ot.status,
    ot.assigned_poc,
    ot.created_at,
    ot.completed_at
  FROM `blitzscale-prod-project.nushop.ob_tasks` ot
  WHERE ot.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL 120 DAY))
    AND ot.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
    AND LOWER(ot.status) != 'cancelled'
),

-- ---------------------------------------------------------------------------
-- 3. Tickets, for era + ticket-level POC. Window extends past the task window
--    because a task created 120d ago belongs to a ticket created earlier still.
-- ---------------------------------------------------------------------------
tickets_filtered AS (
  SELECT
    t.id, t.created_at, t.ob_poc, t.gtg_poc, t.cataloging_poc,
    t.website_poc, t.qc_poc, t.creatives_poc
  FROM `blitzscale-prod-project.nushop.ob_tickets` t
  WHERE t.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH))
    AND t.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
),

-- ---------------------------------------------------------------------------
-- 4. Attach era and the ticket-level owner for the task's team.
-- ---------------------------------------------------------------------------
enriched AS (
  SELECT
    tf.*,
    tk.created_at AS ticket_created_at,
    CASE
      WHEN tk.created_at >= TIMESTAMP('2026-07-08 14:22:00 UTC') THEN 'post_deploy'
      WHEN tk.created_at IS NULL                                 THEN 'unknown'
      ELSE 'pre_deploy'
    END AS ticket_era,
    CASE tf.task_type
      WHEN 'gtg'                THEN tk.gtg_poc
      WHEN 'catalogue_config'   THEN tk.cataloging_poc
      WHEN 'web_config'         THEN tk.website_poc
      WHEN 'website_discussion' THEN tk.website_poc
      WHEN 'domain_transfer'    THEN tk.website_poc
      WHEN 'price_parity_check' THEN tk.qc_poc
      WHEN 'qc_check'           THEN tk.qc_poc
      ELSE tk.ob_poc  -- cagd, poc_intro, meta_setup, fund_transfer, seller_consent
    END AS ticket_level_poc
  FROM tasks_filtered tf
  LEFT JOIN tickets_filtered tk
    ON tf.ticket_id = tk.id
),

-- ---------------------------------------------------------------------------
-- 5. Apply the SLA and classify each task's outcome.
--
--    fund_transfer adjustment: on PRE-deploy tickets the ft task is created
--    immediately after meta_setup, but the POC is required to sit on it for 48
--    hours (the Jul 1 policy). Charging that mandated wait against the POC
--    would manufacture breaches, so pre-deploy ft gets +48h of headroom. On
--    post-deploy tickets the CRM already delays task creation by 48h, so the
--    raw clock is clean.
-- ---------------------------------------------------------------------------
scored AS (
  SELECT
    e.*,
    s.funnel_step,
    s.sla_hours + IF(e.task_type = 'fund_transfer'
                     AND e.ticket_era = 'pre_deploy', 48, 0) AS sla_hours_effective,
    LOWER(e.status) = 'completed' AND e.completed_at IS NOT NULL AS is_closed,
    TIMESTAMP_DIFF(
      COALESCE(e.completed_at, CURRENT_TIMESTAMP()), e.created_at, MINUTE
    ) / 60.0 AS elapsed_hours
  FROM enriched e
  JOIN sla_config s
    ON s.task_type = e.task_type   -- inner join also restricts to the 12 canonical types
),

classified AS (
  SELECT
    *,
    CASE
      WHEN is_closed AND elapsed_hours <= sla_hours_effective THEN 'met'
      WHEN is_closed                                          THEN 'breached_closed'
      WHEN elapsed_hours > sla_hours_effective                THEN 'breached_open'
      ELSE 'in_flight'   -- still open, still inside SLA: outcome not yet decided
    END AS sla_outcome
  FROM scored
),

-- ---------------------------------------------------------------------------
-- 6. Reporting window (30d). Closed tasks are anchored on completion; open
--    tasks on creation, since they have no completion to anchor to.
-- ---------------------------------------------------------------------------
in_window AS (
  SELECT *
  FROM classified
  WHERE (is_closed
         AND completed_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
         AND completed_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY)))
     OR (NOT is_closed
         AND created_at   >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)))
)

SELECT
  COALESCE(u.first_name, 'UNASSIGNED')            AS poc,
  w.task_type,
  ANY_VALUE(w.sla_hours_effective)                AS sla_hours,

  -- Denominator: decided outcomes only (met + both flavours of breach).
  COUNTIF(w.sla_outcome != 'in_flight')           AS tasks_evaluated,
  COUNTIF(w.sla_outcome = 'met')                  AS met_sla,
  COUNTIF(w.sla_outcome IN ('breached_closed', 'breached_open')) AS breached,
  COUNTIF(w.sla_outcome = 'breached_open')        AS breached_still_open,
  COUNTIF(w.sla_outcome = 'in_flight')            AS open_in_flight,

  SAFE_DIVIDE(
    COUNTIF(w.sla_outcome = 'met'),
    COUNTIF(w.sla_outcome != 'in_flight')
  )                                               AS sla_adherence_rate,

  -- Turnaround distribution, closed tasks only (open tasks have no final time).
  ROUND(APPROX_QUANTILES(IF(w.is_closed, w.elapsed_hours, NULL), 100)
        [SAFE_OFFSET(50)], 1)                     AS p50_turnaround_hrs,
  ROUND(APPROX_QUANTILES(IF(w.is_closed, w.elapsed_hours, NULL), 100)
        [SAFE_OFFSET(90)], 1)                     AS p90_turnaround_hrs,

  -- How badly the breaches miss, not just how many.
  ROUND(AVG(IF(w.sla_outcome IN ('breached_closed', 'breached_open'),
               w.elapsed_hours - w.sla_hours_effective, NULL)), 1) AS avg_overshoot_hrs,

  COUNT(DISTINCT w.seller_id)                     AS distinct_sellers,
  -- Reassignment check: share of tasks where the worker != the ticket owner.
  ROUND(SAFE_DIVIDE(
    COUNTIF(w.ticket_level_poc IS NOT NULL AND w.ticket_level_poc != w.assigned_poc),
    COUNT(*)), 3)                                 AS pct_reassigned_from_ticket_poc

FROM in_window w
LEFT JOIN `blitzscale-prod-project.nushop.users` u   -- users is the one unpartitioned table
  ON w.assigned_poc = u._id
GROUP BY poc, w.task_type, w.funnel_step
-- Small denominators are noise; raise this if the list is too long.
HAVING tasks_evaluated >= 5
ORDER BY sla_adherence_rate ASC, breached DESC
;
