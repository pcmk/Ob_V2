-- =============================================================================
-- ESCALATION FORENSICS -- end-to-end reconstruction for a list of sellers
--
-- Purpose: given sellers who triggered an internal escalation, rebuild their
-- whole journey and identify WHERE it stalled and WHOSE side the stall was on.
--
-- NOTE ON SCOPE: the escalation record itself does not live in this schema.
-- These queries reconstruct the conditions that produced it -- they do not read
-- the escalation ticket, its raiser, or its stated reason. If an escalations
-- table exists elsewhere, wire it in; otherwise treat the stated reason as an
-- input you bring, and use these results to confirm or contradict it.
--
-- HOW TO RUN: paste seller IDs into the DECLARE below and run the whole script
-- in the BigQuery console -- each statement returns its own result tab. For a
-- single-statement runner (Metabase etc.), replace every `UNNEST(seller_ids)`
-- with an inline array literal and run the queries one at a time.
--
-- Run order matters: Q1 for context, Q3 for the verdict, Q2/Q5 for the evidence.
-- =============================================================================

DECLARE seller_ids ARRAY<STRING> DEFAULT [
  'PASTE_SELLER_ID_1',
  'PASTE_SELLER_ID_2'
  -- ... add as many as you need
];

-- Widen this if any escalated seller onboarded more than 6 months ago. Every
-- table here except `users` is partitioned and will reject an unfiltered read.
DECLARE lookback_months INT64 DEFAULT 6;


-- =============================================================================
-- Q1. TICKET HEADER -- who owned this seller, and what did they sign up for
-- =============================================================================
SELECT
  t.seller_id,
  t.id                                            AS ticket_id,
  DATETIME(t.created_at, 'Asia/Kolkata')          AS ticket_created_ist,
  DATE_DIFF(CURRENT_DATE(), DATE(t.created_at), DAY) AS ticket_age_days,
  CASE WHEN t.created_at >= TIMESTAMP('2026-07-08 14:22:00 UTC')
       THEN 'post_deploy' ELSE 'pre_deploy' END   AS ticket_era,

  -- Questionnaire: sets expectations. A large catalogue or an aggressive
  -- marketing timeline changes what "late" means for this seller.
  JSON_VALUE(t.journey_questionnaire, '$.category')            AS category,
  JSON_VALUE(t.journey_questionnaire, '$.catalogue_size')      AS catalogue_size,
  JSON_VALUE(t.journey_questionnaire, '$.marketing_timeline')  AS marketing_timeline,
  ARRAY_TO_STRING(
    JSON_VALUE_ARRAY(t.journey_questionnaire, '$.catalogue_sharing_preference'),
    ', ')                                                      AS catalogue_sharing_pref,

  -- The POC roster at ticket level. Cross-check against Q2's assigned_poc:
  -- a divergence means the ticket was reassigned mid-flow, which is itself a
  -- common escalation trigger (handoff dropped).
  ob.first_name   AS ob_poc,
  gtg.first_name  AS gtg_poc,
  gtga.first_name AS gtg_approver_poc,
  cat.first_name  AS cataloging_poc,
  web.first_name  AS website_poc,
  qc.first_name   AS qc_poc,
  cre.first_name  AS creatives_poc

FROM `blitzscale-prod-project.nushop.ob_tickets` t
LEFT JOIN `blitzscale-prod-project.nushop.users` ob   ON t.ob_poc            = ob._id
LEFT JOIN `blitzscale-prod-project.nushop.users` gtg  ON t.gtg_poc           = gtg._id
LEFT JOIN `blitzscale-prod-project.nushop.users` gtga ON t.gtg_approver_poc  = gtga._id
LEFT JOIN `blitzscale-prod-project.nushop.users` cat  ON t.cataloging_poc    = cat._id
LEFT JOIN `blitzscale-prod-project.nushop.users` web  ON t.website_poc       = web._id
LEFT JOIN `blitzscale-prod-project.nushop.users` qc   ON t.qc_poc            = qc._id
LEFT JOIN `blitzscale-prod-project.nushop.users` cre  ON t.creatives_poc     = cre._id
WHERE t.seller_id IN UNNEST(seller_ids)
  AND t.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
  AND t.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
ORDER BY t.seller_id, t.created_at DESC;
-- If a seller returns 2+ rows they re-onboarded. Every later query is at
-- ticket grain for exactly this reason -- do not collapse them to the seller.


-- =============================================================================
-- Q2. THE SPINE -- full 12-step grid per ticket, including steps that never
--     happened. This is the query that shows you where it broke.
--
--     Rows come from a CROSS JOIN of the canonical task list, NOT from
--     ob_tasks, so a task that was never created still appears -- as a row with
--     a NULL task_id. That absence is a finding, not a gap in the data: it
--     means the CRM never generated the task (a real failure mode, especially
--     for post-deploy fund_transfer auto-creation).
-- =============================================================================
WITH task_order AS (
  SELECT * FROM UNNEST([
    STRUCT( 1 AS step, 'cagd'               AS task_type, 'ob_poc'         AS owner_team),
    STRUCT( 2 AS step, 'gtg'                AS task_type, 'gtg_poc'        AS owner_team),
    STRUCT( 3 AS step, 'catalogue_config'   AS task_type, 'cataloging_poc' AS owner_team),
    STRUCT( 4 AS step, 'poc_intro'          AS task_type, 'ob_poc'         AS owner_team),
    STRUCT( 5 AS step, 'web_config'         AS task_type, 'website_poc'    AS owner_team),
    STRUCT( 6 AS step, 'website_discussion' AS task_type, 'website_poc'    AS owner_team),
    STRUCT( 7 AS step, 'domain_transfer'    AS task_type, 'website_poc'    AS owner_team),
    STRUCT( 8 AS step, 'meta_setup'         AS task_type, 'ob_poc'         AS owner_team),
    STRUCT( 9 AS step, 'price_parity_check' AS task_type, 'qc_poc'         AS owner_team),
    STRUCT(10 AS step, 'fund_transfer'      AS task_type, 'ob_poc'         AS owner_team),
    STRUCT(11 AS step, 'qc_check'           AS task_type, 'qc_poc'         AS owner_team),
    STRUCT(12 AS step, 'seller_consent'     AS task_type, 'ob_poc'         AS owner_team)
  ])
),
tickets AS (
  SELECT id AS ticket_id, seller_id, created_at AS ticket_created_at
  FROM `blitzscale-prod-project.nushop.ob_tickets`
  WHERE seller_id IN UNNEST(seller_ids)
    AND created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
    AND created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
),
tasks_raw AS (
  SELECT
    id AS task_id, seller_id, ticket_id, type AS task_type, status,
    assigned_poc, created_at, completed_at,
    -- A ticket can carry duplicate rows of one task type (recovery path).
    -- Keep the newest; surface the count so you know it happened.
    ROW_NUMBER() OVER (PARTITION BY ticket_id, type ORDER BY created_at DESC) AS rn,
    COUNT(*)    OVER (PARTITION BY ticket_id, type)                           AS row_count_for_type
  FROM `blitzscale-prod-project.nushop.ob_tasks`
  WHERE seller_id IN UNNEST(seller_ids)
    AND created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
    AND created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
),
tasks AS (SELECT * FROM tasks_raw WHERE rn = 1),
calls_per_task AS (
  SELECT
    ec.entity_id AS task_id,
    COUNT(*)                                                    AS total_calls,
    COUNTIF(LOWER(ecd.call_type) = 'outbound')                  AS outbound_attempts,
    COUNTIF(LOWER(ecd.call_type) = 'inbound')                   AS inbound_calls,
    COUNTIF(UPPER(ecd.status) = 'CONNECTED')                    AS connected_calls,
    MAX(IF(UPPER(ecd.status) = 'CONNECTED', ec.created_at, NULL)) AS last_connected_at
  FROM `blitzscale-prod-project.nushop.exotel_calls` ec
  JOIN `blitzscale-prod-project.nushop.exotel_call_details` ecd
    ON ec.exotel_call_sid = ecd.sid
   AND ecd.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
   AND ecd.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
  WHERE ec.entity = 'ob-task'
    AND ec.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
    AND ec.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
  GROUP BY task_id
),
grid AS (
  SELECT
    tk.seller_id, tk.ticket_id, tk.ticket_created_at,
    o.step, o.task_type, o.owner_team,
    ta.task_id, ta.status, ta.assigned_poc, ta.created_at, ta.completed_at,
    ta.row_count_for_type,
    c.total_calls, c.outbound_attempts, c.inbound_calls, c.connected_calls,
    c.last_connected_at
  FROM tickets tk
  CROSS JOIN task_order o
  LEFT JOIN tasks ta ON ta.ticket_id = tk.ticket_id AND ta.task_type = o.task_type
  LEFT JOIN calls_per_task c ON c.task_id = ta.task_id
)
SELECT
  seller_id,
  ticket_id,
  step,
  task_type,
  owner_team,
  COALESCE(u.first_name, IF(task_id IS NULL, '(task never created)', 'UNASSIGNED'))
                                                   AS worked_by,
  COALESCE(status, 'DOES_NOT_EXIST')               AS status,
  DATETIME(created_at,   'Asia/Kolkata')           AS task_created_ist,
  DATETIME(completed_at, 'Asia/Kolkata')           AS task_completed_ist,

  -- How long this task sat, open or closed.
  ROUND(TIMESTAMP_DIFF(COALESCE(completed_at, CURRENT_TIMESTAMP()),
                       created_at, MINUTE) / 60.0, 1)  AS hours_in_queue,

  -- Dead air between the previous step closing and this one closing. Large
  -- values here, not in hours_in_queue, mean the handoff was the problem.
  ROUND(TIMESTAMP_DIFF(
    COALESCE(completed_at, CURRENT_TIMESTAMP()),
    LAG(completed_at) OVER (PARTITION BY ticket_id ORDER BY step),
    MINUTE) / 60.0, 1)                             AS hours_since_prev_step_done,

  total_calls, outbound_attempts, inbound_calls, connected_calls,
  DATETIME(last_connected_at, 'Asia/Kolkata')      AS last_connected_ist,
  IF(row_count_for_type > 1, row_count_for_type, NULL) AS duplicate_task_rows

FROM grid
LEFT JOIN `blitzscale-prod-project.nushop.users` u ON grid.assigned_poc = u._id
ORDER BY seller_id, ticket_id, step;


-- =============================================================================
-- Q3. THE VERDICT -- one row per ticket, classifying the stall
--
--     Read this first, then go back to Q2 for the detail behind it.
--     The classification separates the two failure modes that matter for an
--     escalation post-mortem: we dropped it, vs the seller went dark.
-- =============================================================================
WITH task_order AS (
  SELECT * FROM UNNEST([
    STRUCT( 1 AS step, 'cagd'               AS task_type),
    STRUCT( 2 AS step, 'gtg'                AS task_type),
    STRUCT( 3 AS step, 'catalogue_config'   AS task_type),
    STRUCT( 4 AS step, 'poc_intro'          AS task_type),
    STRUCT( 5 AS step, 'web_config'         AS task_type),
    STRUCT( 6 AS step, 'website_discussion' AS task_type),
    STRUCT( 7 AS step, 'domain_transfer'    AS task_type),
    STRUCT( 8 AS step, 'meta_setup'         AS task_type),
    STRUCT( 9 AS step, 'price_parity_check' AS task_type),
    STRUCT(10 AS step, 'fund_transfer'      AS task_type),
    STRUCT(11 AS step, 'qc_check'           AS task_type),
    STRUCT(12 AS step, 'seller_consent'     AS task_type)
  ])
),
tickets AS (
  SELECT id AS ticket_id, seller_id, created_at AS ticket_created_at,
    CASE WHEN created_at >= TIMESTAMP('2026-07-08 14:22:00 UTC')
         THEN 'post_deploy' ELSE 'pre_deploy' END AS ticket_era
  FROM `blitzscale-prod-project.nushop.ob_tickets`
  WHERE seller_id IN UNNEST(seller_ids)
    AND created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
    AND created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
),
tasks AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT id AS task_id, ticket_id, type AS task_type, status, assigned_poc,
           created_at, completed_at,
           ROW_NUMBER() OVER (PARTITION BY ticket_id, type ORDER BY created_at DESC) AS rn
    FROM `blitzscale-prod-project.nushop.ob_tasks`
    WHERE seller_id IN UNNEST(seller_ids)
      AND created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
      AND created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
  ) WHERE rn = 1
),
calls_per_task AS (
  SELECT ec.entity_id AS task_id,
    COUNTIF(LOWER(ecd.call_type) = 'outbound')  AS outbound_attempts,
    COUNTIF(UPPER(ecd.status) = 'CONNECTED')    AS connected_calls,
    MAX(IF(UPPER(ecd.status) = 'CONNECTED', ec.created_at, NULL)) AS last_connected_at
  FROM `blitzscale-prod-project.nushop.exotel_calls` ec
  JOIN `blitzscale-prod-project.nushop.exotel_call_details` ecd
    ON ec.exotel_call_sid = ecd.sid
   AND ecd.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
   AND ecd.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
  WHERE ec.entity = 'ob-task'
    AND ec.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
    AND ec.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
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
  LEFT JOIN calls_per_task c ON c.task_id = ta.task_id
),
-- The blocking step = lowest-numbered step not yet done.
blocking AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT g.*, ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY step) AS rn
    FROM grid g WHERE NOT g.is_done
  ) WHERE rn = 1
),
progress AS (
  SELECT ticket_id,
         COUNTIF(is_done)                        AS steps_done,
         MAX(IF(is_done, step, 0))               AS furthest_step_done,
         MAX(IF(task_type = 'meta_setup' AND is_done, completed_at, NULL)) AS meta_completed_at
  FROM grid GROUP BY ticket_id
),
launched AS (
  SELECT DISTINCT ticket_id
  FROM `blitzscale-prod-project.nushop.seller_journey_milestones`
  WHERE step_name = 'Launch' AND LOWER(status) = 'completed'
    AND created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
    AND created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
)
SELECT
  b.seller_id,
  b.ticket_id,
  b.ticket_era,
  DATETIME(b.ticket_created_at, 'Asia/Kolkata')      AS ticket_created_ist,
  DATE_DIFF(CURRENT_DATE(), DATE(b.ticket_created_at), DAY) AS days_in_funnel,
  p.steps_done                                       AS steps_completed_of_12,
  b.step                                             AS blocking_step,
  b.task_type                                        AS blocking_task,
  COALESCE(u.first_name,
           IF(b.task_id IS NULL, '(no task row)', 'UNASSIGNED')) AS blocking_task_poc,
  COALESCE(b.status, 'DOES_NOT_EXIST')               AS blocking_task_status,

  -- Age of the block: from task creation if it exists, else from when the
  -- previous step closed (i.e. how long we have sat with nothing created).
  ROUND(TIMESTAMP_DIFF(CURRENT_TIMESTAMP(),
        COALESCE(b.created_at, prev.prev_done_at, b.ticket_created_at),
        HOUR) / 24.0, 1)                             AS days_blocked,

  b.outbound_attempts                                AS calls_on_blocking_task,
  b.connected_calls                                  AS connects_on_blocking_task,
  DATETIME(b.last_connected_at, 'Asia/Kolkata')      AS last_seller_contact_ist,

  -- ---- THE CLASSIFICATION -------------------------------------------------
  CASE
    WHEN l.ticket_id IS NOT NULL THEN 'LAUNCHED -- escalation likely commercial or post-launch'
    -- CRM never generated the task. Nobody could have worked it.
    WHEN b.task_id IS NULL
         AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(),
             COALESCE(prev.prev_done_at, b.ticket_created_at), HOUR) > 72
      THEN 'SYSTEM -- task never created (CRM gap)'
    -- Mandated 48h gap between meta_setup and fund_transfer. Not a delay.
    WHEN b.task_type = 'fund_transfer'
         AND p.meta_completed_at IS NOT NULL
         AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), p.meta_completed_at, HOUR) < 48
      THEN 'POLICY WAIT -- inside the mandated 48h meta->ft window'
    WHEN TIMESTAMP_DIFF(CURRENT_TIMESTAMP(),
         COALESCE(b.created_at, b.ticket_created_at), HOUR) < 48
      THEN 'IN PROGRESS -- under 48h, likely premature escalation'
    -- Past 48h and nobody ever picked up the phone.
    WHEN b.outbound_attempts = 0
      THEN 'OPS -- no outbound attempt on the blocking task'
    -- We tried; the seller never answered.
    WHEN b.connected_calls = 0
      THEN 'SELLER -- attempted but never reached'
    -- We reached them and it still has not moved.
    ELSE 'SELLER-SIDE STALL -- contact made, no progress (docs/decision pending)'
  END                                                AS likely_root_cause

FROM blocking b
JOIN progress p ON b.ticket_id = p.ticket_id
LEFT JOIN launched l ON b.ticket_id = l.ticket_id
LEFT JOIN `blitzscale-prod-project.nushop.users` u ON b.assigned_poc = u._id
LEFT JOIN (
  SELECT ticket_id, MAX(completed_at) AS prev_done_at
  FROM grid WHERE is_done GROUP BY ticket_id
) prev ON b.ticket_id = prev.ticket_id
ORDER BY days_blocked DESC;


-- =============================================================================
-- Q4. MILESTONE vs TASK CONSISTENCY
--     Catches the escalation that is really a reporting artifact: tasks are
--     done but the milestone was never flipped, so dashboards show the seller
--     as stuck when operationally they are fine. Task completion does not
--     imply launch -- only the Launch milestone does.
-- =============================================================================
SELECT
  t.seller_id,
  m.ticket_id,
  -- Merge the aliased step names, or you will undercount catalogue/marketing.
  CASE
    WHEN m.step_name IN ('Catalogue', 'Catalogue Creation', 'Catalogue Sharing') THEN 'catalogue'
    WHEN m.step_name IN ('Marketing', 'Marketing & Platform setup')              THEN 'marketing'
    WHEN m.step_name IN ('Website', 'Website Creation')                          THEN 'website'
    WHEN m.step_name = 'Document'                                                THEN 'document'
    WHEN m.step_name = 'Launch'                                                  THEN 'launch'
    ELSE LOWER(m.step_name)
  END                                              AS milestone,
  m.step_name                                      AS raw_step_name,
  m.status,
  DATETIME(m.updated_at, 'Asia/Kolkata')           AS milestone_updated_ist
FROM `blitzscale-prod-project.nushop.seller_journey_milestones` m
JOIN `blitzscale-prod-project.nushop.ob_tickets` t
  ON m.ticket_id = t.id
 AND t.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
 AND t.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
WHERE t.seller_id IN UNNEST(seller_ids)
  AND m.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
  AND m.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
ORDER BY t.seller_id, m.ticket_id, m.updated_at;


-- =============================================================================
-- Q5. CALL LOG -- every contact attempt, in order. This is the evidence you
--     attach when replying to the escalation.
-- =============================================================================
SELECT
  ot.seller_id,
  ot.ticket_id,
  ot.type                                          AS task_type,
  DATETIME(ec.created_at, 'Asia/Kolkata')          AS call_time_ist,
  LOWER(ecd.call_type)                             AS direction,
  UPPER(ecd.status)                                AS call_status,
  ec.exotel_call_sid
FROM `blitzscale-prod-project.nushop.exotel_calls` ec
JOIN `blitzscale-prod-project.nushop.exotel_call_details` ecd
  ON ec.exotel_call_sid = ecd.sid
 AND ecd.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
 AND ecd.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
JOIN `blitzscale-prod-project.nushop.ob_tasks` ot
  ON ec.entity_id = ot.id
 AND ot.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
 AND ot.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
WHERE ec.entity = 'ob-task'
  AND ot.seller_id IN UNNEST(seller_ids)
  AND ec.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
  AND ec.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
ORDER BY ot.seller_id, ec.created_at;


-- =============================================================================
-- Q6. OFFERS -- run this when the escalation smells commercial ("I was
--     promised X credit"). Offer names are not in any table; they are
--     hardcoded here and in the analytics Apps Script.
-- =============================================================================
WITH offer_map AS (
  SELECT * FROM UNNEST([
    STRUCT('XBneu1fr' AS offer_id, '5K Credit + 0% Commission Combo' AS offer_name),
    STRUCT('7mZ2BUrf' AS offer_id, '5K Credit After 10K Spend'       AS offer_name),
    STRUCT('oHG3ohja' AS offer_id, '5K Credit After 15K Spend'       AS offer_name),
    STRUCT('E2LBHeyl' AS offer_id, '5K Deposit + 5K Marketing'       AS offer_name),
    STRUCT('q_4WEFzQ' AS offer_id, '2K Deposit + 5K Marketing'       AS offer_name),
    STRUCT('YjCrnYRz' AS offer_id, '0% Commission for First 30 Days' AS offer_name)
  ])
)
SELECT
  so.seller_id,
  COALESCE(om.offer_name, CONCAT('UNMAPPED: ', so.offer_id)) AS offer_name,
  so.status,
  so.is_zero_percentage_commission,
  DATETIME(so.recorded_at, 'Asia/Kolkata')         AS recorded_ist,
  so.start_date,
  so.end_date
FROM `blitzscale-prod-project.nushop.seller_offers` so
LEFT JOIN offer_map om ON so.offer_id = om.offer_id
WHERE so.seller_id IN UNNEST(seller_ids)
  AND so.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL lookback_months MONTH))
  AND so.created_at <  TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))
ORDER BY so.seller_id, so.recorded_at DESC;
-- An UNMAPPED offer_id means a new offer was launched and this list is stale.
