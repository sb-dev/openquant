-- 0006_evidence: dataset manifests, retrieval and validation results, findings and their treatment, Decisions, holdout
-- consumption, official results and metrics, gate reports, eligibility and mission outcomes.
-- OQ-02 sections 3.3, 3.6, 4 and 8; OQ-05 sections 4 and 7. Evidence is immutable: corrections append new records.

-- The frozen dataset snapshot of a mission (OQ-05 section 7.1). One snapshot per mission: a provider correction is a
-- new snapshot for a later mission (pilot profile, freshness policy).
CREATE TABLE dataset_manifests (
  manifest_digest oq_digest PRIMARY KEY REFERENCES artefacts (digest),
  mission_id oq_identifier NOT NULL REFERENCES missions (mission_id),
  job_id oq_identifier NOT NULL REFERENCES jobs (job_id),
  completeness text NOT NULL CHECK (completeness IN ('COMPLETE', 'PARTIAL', 'NO_OBSERVATIONS')),
  retrieved_at timestamptz NOT NULL,
  CONSTRAINT dataset_manifests_one_snapshot_per_mission UNIQUE (mission_id)
);
CREATE TRIGGER dataset_manifests_immutable BEFORE UPDATE OR DELETE ON dataset_manifests
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The accepted retrieval result of a retrieve job. A failure names its class and says whether a retry is allowed:
-- authentication, permission, unsupported capability, cancellation and egress refusal are never retried.
CREATE TABLE retrieval_results (
  job_id oq_identifier PRIMARY KEY REFERENCES jobs (job_id),
  attempt_id oq_identifier NOT NULL REFERENCES attempts (attempt_id),
  result_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  outcome text NOT NULL CHECK (outcome IN ('COMPLETE', 'PARTIAL', 'NO_OBSERVATIONS', 'FAILED')),
  manifest_digest oq_digest REFERENCES dataset_manifests (manifest_digest),
  error_class text CHECK (error_class IN (
    'AUTHENTICATION', 'PERMISSION', 'RATE_LIMITED', 'TIMEOUT', 'UNAVAILABLE_DATA', 'UNSUPPORTED_CAPABILITY',
    'MALFORMED_RESPONSE', 'CANCELLED', 'EGRESS_REFUSED'
  )),
  retryable boolean,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT retrieval_results_attempt_unique UNIQUE (attempt_id),
  CONSTRAINT retrieval_results_snapshot_iff_success CHECK ((outcome <> 'FAILED') = (manifest_digest IS NOT NULL)),
  CONSTRAINT retrieval_results_failure_shape CHECK (
    (outcome = 'FAILED') = (error_class IS NOT NULL AND retryable IS NOT NULL)
  ),
  CONSTRAINT retrieval_results_never_retry CHECK (
    NOT (COALESCE(retryable, false)
      AND error_class IN ('AUTHENTICATION', 'PERMISSION', 'UNSUPPORTED_CAPABILITY', 'CANCELLED', 'EGRESS_REFUSED'))
  )
);
CREATE TRIGGER retrieval_results_immutable BEFORE UPDATE OR DELETE ON retrieval_results
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The accepted validation result of a validate job. A VALID result may name the Strategy Version it registered.
CREATE TABLE validation_results (
  job_id oq_identifier PRIMARY KEY REFERENCES jobs (job_id),
  attempt_id oq_identifier NOT NULL REFERENCES attempts (attempt_id),
  result_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  draft_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  status text NOT NULL CHECK (status IN ('VALID', 'INVALID')),
  change_scope text CHECK (change_scope IN ('ENTRY', 'EXIT')),
  strategy_hash oq_digest REFERENCES strategy_versions (strategy_hash),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT validation_results_attempt_unique UNIQUE (attempt_id),
  CONSTRAINT validation_results_registered_only_when_valid CHECK (strategy_hash IS NULL OR status = 'VALID'),
  CONSTRAINT validation_results_scope_only_when_valid CHECK (change_scope IS NULL OR status = 'VALID')
);
CREATE TRIGGER validation_results_immutable BEFORE UPDATE OR DELETE ON validation_results
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- Critic findings (OQ-03 section 4) are recorded with the candidate hash they apply to. They are immutable; the
-- policy treatment is a separate row per lifecycle transition, so a critic cannot set or close it (OQ-02 section 3.6).
CREATE TABLE findings (
  finding_id oq_identifier PRIMARY KEY,
  mission_id oq_identifier NOT NULL REFERENCES missions (mission_id),
  strategy_hash oq_digest NOT NULL REFERENCES strategy_versions (strategy_hash),
  attempt_id oq_identifier NOT NULL REFERENCES attempts (attempt_id),
  critique_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1000),
  category text NOT NULL CHECK (category IN (
    'hypothesis_assumption', 'data_quality_alignment', 'causal_leakage', 'execution_accounting_assumption',
    'search_overfitting', 'policy_mismatch', 'portfolio_fit', 'operational_risk', 'source_uncertainty',
    'missing_evidence', 'method_advice'
  )),
  finding_source text NOT NULL CHECK (char_length(finding_source) BETWEEN 1 AND 100),
  affects_executable_rule boolean NOT NULL,
  required_evidence boolean NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT findings_position UNIQUE (critique_digest, ordinal),
  CONSTRAINT findings_id_strategy UNIQUE (finding_id, strategy_hash)
);
CREATE TRIGGER findings_immutable BEFORE UPDATE OR DELETE ON findings
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

CREATE TABLE finding_treatments (
  finding_id oq_identifier NOT NULL REFERENCES findings (finding_id),
  transition text NOT NULL CHECK (transition IN ('DRAFT_TO_EVALUATING', 'EVALUATING_TO_PAPER')),
  treatment text NOT NULL CHECK (treatment IN ('BLOCKING', 'ADVISORY')),
  policy_id oq_identifier NOT NULL,
  policy_revision integer NOT NULL,
  assigned_at timestamptz NOT NULL,
  resolved_by oq_identifier REFERENCES principals (principal_id),
  resolved_at timestamptz,
  PRIMARY KEY (finding_id, transition),
  CONSTRAINT finding_treatments_policy FOREIGN KEY (policy_id, policy_revision)
    REFERENCES cohort_policies (policy_id, revision),
  CONSTRAINT finding_treatments_resolution_pair CHECK ((resolved_by IS NULL) = (resolved_at IS NULL)),
  -- In S1 no finding category blocks DRAFT to EVALUATING (OQ-02 section 4).
  CONSTRAINT finding_treatments_s1_no_block_on_draft CHECK (transition <> 'DRAFT_TO_EVALUATING' OR treatment = 'ADVISORY')
);
-- Only the resolution may be written after the treatment: it is set once.
CREATE FUNCTION oq_finding_treatments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.resolved_at IS NOT NULL
    OR (to_jsonb(NEW) - 'resolved_by' - 'resolved_at') IS DISTINCT FROM (to_jsonb(OLD) - 'resolved_by' - 'resolved_at') THEN
    RAISE EXCEPTION 'finding_treatments: only a first resolution may be written after the treatment'
      USING ERRCODE = '23514', CONSTRAINT = 'finding_treatments_immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finding_treatments_guard BEFORE UPDATE OR DELETE ON finding_treatments
  FOR EACH ROW EXECUTE FUNCTION oq_finding_treatments_guard();

-- Decisions (OQ-02 section 1). S1 records two kinds: a Steward's approval of a cohort policy revision, and the
-- policy-determined DRAFT to EVALUATING Decision of the workflows service principal. The kind list has no
-- EVALUATING to PAPER value, so S1 cannot record that Decision (OQ-02 section 4).
CREATE TABLE decisions (
  decision_id oq_identifier PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('POLICY_APPROVAL', 'DRAFT_TO_EVALUATING')),
  outcome text NOT NULL CHECK (outcome IN ('APPROVED', 'REJECTED', 'DEFERRED')),
  actor_id oq_identifier NOT NULL,
  actor_kind text NOT NULL,
  policy_id oq_identifier NOT NULL,
  policy_revision integer NOT NULL,
  mission_id oq_identifier,
  trial_slot oq_identifier,
  strategy_hash oq_digest REFERENCES strategy_versions (strategy_hash),
  plan_digest oq_digest,
  policy_approval_decision oq_identifier,
  approval_kind text GENERATED ALWAYS AS (CASE WHEN policy_approval_decision IS NOT NULL THEN 'POLICY_APPROVAL' END) STORED,
  approval_outcome text GENERATED ALWAYS AS (CASE WHEN policy_approval_decision IS NOT NULL THEN 'APPROVED' END) STORED,
  mission_started_by oq_identifier,
  critique_status text CHECK (critique_status IN ('COMPLETED', 'NO_VALID_RESULT')),
  critique_digest oq_digest REFERENCES artefacts (digest),
  reason text CHECK (char_length(reason) BETWEEN 1 AND 1000),
  command_id oq_identifier,
  decided_at timestamptz NOT NULL,
  CONSTRAINT decisions_actor FOREIGN KEY (actor_id, actor_kind) REFERENCES principals (principal_id, kind),
  CONSTRAINT decisions_policy FOREIGN KEY (policy_id, policy_revision) REFERENCES cohort_policies (policy_id, revision),
  CONSTRAINT decisions_mission_policy FOREIGN KEY (mission_id, policy_id, policy_revision)
    REFERENCES missions (mission_id, policy_id, policy_revision),
  CONSTRAINT decisions_mission_started_by FOREIGN KEY (mission_id, mission_started_by)
    REFERENCES missions (mission_id, started_by),
  CONSTRAINT decisions_slot FOREIGN KEY (mission_id, trial_slot) REFERENCES trial_slots (mission_id, trial_slot),
  CONSTRAINT decisions_plan FOREIGN KEY (plan_digest, mission_id) REFERENCES evaluation_plans (plan_digest, mission_id),
  CONSTRAINT decisions_key UNIQUE (decision_id, kind, outcome, policy_id, policy_revision),
  -- The approval that a policy-determined Decision names is an APPROVED approval of the same policy revision.
  CONSTRAINT decisions_policy_approval FOREIGN KEY (policy_approval_decision, approval_kind, approval_outcome, policy_id, policy_revision)
    REFERENCES decisions (decision_id, kind, outcome, policy_id, policy_revision),
  CONSTRAINT decisions_kind_shape CHECK (
    (kind = 'POLICY_APPROVAL' AND actor_kind = 'HUMAN' AND outcome IN ('APPROVED', 'REJECTED')
      AND mission_id IS NULL AND trial_slot IS NULL AND strategy_hash IS NULL AND plan_digest IS NULL
      AND policy_approval_decision IS NULL AND mission_started_by IS NULL
      AND critique_status IS NULL AND critique_digest IS NULL)
    OR
    (kind = 'DRAFT_TO_EVALUATING' AND actor_kind = 'SERVICE'
      AND mission_id IS NOT NULL AND trial_slot IS NOT NULL AND strategy_hash IS NOT NULL AND plan_digest IS NOT NULL
      AND policy_approval_decision IS NOT NULL AND mission_started_by IS NOT NULL AND critique_status IS NOT NULL)
  ),
  -- DEFERRED exactly when the critique ended without a valid result (OQ-02 section 4).
  CONSTRAINT decisions_deferred_iff_no_critique CHECK (
    kind <> 'DRAFT_TO_EVALUATING' OR ((outcome = 'DEFERRED') = (critique_status = 'NO_VALID_RESULT'))
  ),
  CONSTRAINT decisions_critique_result CHECK ((critique_status = 'COMPLETED') = (critique_digest IS NOT NULL)),
  CONSTRAINT decisions_deferred_has_reason CHECK (outcome <> 'DEFERRED' OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX decisions_one_approval_per_policy ON decisions (policy_id, policy_revision)
  WHERE kind = 'POLICY_APPROVAL';
CREATE UNIQUE INDEX decisions_one_per_slot ON decisions (mission_id, trial_slot) WHERE kind = 'DRAFT_TO_EVALUATING';
CREATE TRIGGER decisions_immutable BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- Revealing a holdout result is consumption (OQ-02 section 3.3; A05): one record per holdout run, never removed, so a
-- consumed holdout cannot be relabelled untouched.
CREATE TABLE holdout_consumption (
  run_id oq_identifier PRIMARY KEY,
  window_role text NOT NULL DEFAULT 'HOLDOUT' CHECK (window_role = 'HOLDOUT'),
  revealed_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  revealed_at timestamptz NOT NULL,
  CONSTRAINT holdout_consumption_run FOREIGN KEY (run_id, window_role) REFERENCES runs (run_id, window_role)
);
CREATE TRIGGER holdout_consumption_immutable BEFORE UPDATE OR DELETE ON holdout_consumption
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The official result of a run: one row per run, so redelivery cannot create a second one (A11). It names the one
-- accepting attempt, which must be COMPLETED, and the run status that the outcome maps to (OQ-02 section 3.6):
-- COMPLETED and INSUFFICIENT give a COMPLETED run, FAILED and NOT_PREPARED give a FAILED run. NOT_PREPARED has no result.
CREATE TABLE results (
  run_id oq_identifier PRIMARY KEY,
  attempt_id oq_identifier NOT NULL,
  attempt_status text NOT NULL DEFAULT 'COMPLETED' CHECK (attempt_status = 'COMPLETED'),
  run_status text NOT NULL CHECK (run_status IN ('COMPLETED', 'FAILED')),
  outcome text NOT NULL CHECK (outcome IN ('COMPLETED', 'FAILED', 'INSUFFICIENT', 'NOT_PREPARED')),
  outcome_code text CHECK (char_length(outcome_code) BETWEEN 1 AND 100),
  submission_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  input_digest oq_digest REFERENCES artefacts (digest),
  result_digest oq_digest REFERENCES artefacts (digest),
  engine_digest oq_digest NOT NULL,
  method_digest oq_digest NOT NULL,
  executable_digest oq_digest NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT results_attempt_unique UNIQUE (attempt_id),
  CONSTRAINT results_outcome_key UNIQUE (run_id, outcome),
  CONSTRAINT results_accepting_attempt FOREIGN KEY (attempt_id, attempt_status, run_id)
    REFERENCES attempts (attempt_id, status, run_id),
  CONSTRAINT results_run_status FOREIGN KEY (run_id, run_status) REFERENCES runs (run_id, status),
  CONSTRAINT results_outcome_maps_to_run_status CHECK (
    (outcome IN ('COMPLETED', 'INSUFFICIENT')) = (run_status = 'COMPLETED')
  ),
  CONSTRAINT results_code_when_not_completed CHECK (outcome = 'COMPLETED' OR outcome_code IS NOT NULL),
  CONSTRAINT results_result_unless_not_prepared CHECK ((outcome = 'NOT_PREPARED') = (result_digest IS NULL))
);
CREATE TRIGGER results_immutable BEFORE UPDATE OR DELETE ON results
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- Official metrics exist only for a COMPLETED outcome: a FAILED or INSUFFICIENT run has none (OQ-02 section 3.6).
CREATE TABLE metrics (
  run_id oq_identifier PRIMARY KEY,
  result_outcome text NOT NULL DEFAULT 'COMPLETED' CHECK (result_outcome = 'COMPLETED'),
  metrics_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  method_digest oq_digest NOT NULL,
  metric_scale integer NOT NULL CHECK (metric_scale BETWEEN 0 AND 12),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT metrics_result FOREIGN KEY (run_id, result_outcome) REFERENCES results (run_id, outcome)
);
CREATE TRIGGER metrics_immutable BEFORE UPDATE OR DELETE ON metrics
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The gate report of one candidate, written by the assess job from official results (OQ-02 section 3.6). A gate
-- appears once in a report; INSUFFICIENT and NOT_APPLICABLE carry a reason code and PASS and FAIL do not.
CREATE TABLE gate_reports (
  report_digest oq_digest PRIMARY KEY REFERENCES artefacts (digest),
  mission_id oq_identifier NOT NULL REFERENCES missions (mission_id),
  job_id oq_identifier NOT NULL REFERENCES jobs (job_id),
  attempt_id oq_identifier NOT NULL REFERENCES attempts (attempt_id),
  strategy_hash oq_digest NOT NULL REFERENCES strategy_versions (strategy_hash),
  plan_digest oq_digest NOT NULL,
  policy_id oq_identifier NOT NULL,
  policy_revision integer NOT NULL,
  method_digest oq_digest NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT gate_reports_job_unique UNIQUE (job_id),
  CONSTRAINT gate_reports_attempt_unique UNIQUE (attempt_id),
  CONSTRAINT gate_reports_one_per_candidate UNIQUE (mission_id, strategy_hash),
  CONSTRAINT gate_reports_report_strategy UNIQUE (report_digest, strategy_hash),
  CONSTRAINT gate_reports_plan FOREIGN KEY (plan_digest, mission_id) REFERENCES evaluation_plans (plan_digest, mission_id),
  CONSTRAINT gate_reports_policy FOREIGN KEY (policy_id, policy_revision) REFERENCES cohort_policies (policy_id, revision)
);
CREATE TRIGGER gate_reports_immutable BEFORE UPDATE OR DELETE ON gate_reports
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

CREATE TABLE gate_results (
  report_digest oq_digest NOT NULL REFERENCES gate_reports (report_digest),
  gate_id text NOT NULL CHECK (gate_id IN (
    'DEFINITION_VALIDATION', 'DETERMINISTIC_REPLAY', 'ACCOUNTING_RECONCILIATION', 'SIGNAL_DATA_TIMING',
    'POINT_IN_TIME_DATA', 'BASE_COST_MODEL', 'EXCESS_OVER_BUY_AND_HOLD', 'WALK_FORWARD', 'MINIMUM_TRADE_COUNT',
    'COST_STRESS', 'PARAMETER_SENSITIVITY', 'EXECUTION_DELAY', 'ADVERSE_REGIMES', 'RESAMPLING',
    'PROSPECTIVE_EVIDENCE', 'PORTFOLIO_FIT', 'OPERATING_READINESS'
  )),
  category text NOT NULL CHECK (category IN (
    'CORRECTNESS', 'HISTORICAL_VALIDITY', 'ROBUSTNESS', 'PROSPECTIVE', 'PORTFOLIO_FIT', 'OPERATING_READINESS'
  )),
  result text NOT NULL CHECK (result IN ('PASS', 'FAIL', 'INSUFFICIENT', 'NOT_APPLICABLE')),
  reason_code text CHECK (reason_code IN (
    'POLICY_RECORDED', 'BELOW_THRESHOLD', 'VALIDATION_FAILED', 'RUN_FAILED', 'RUN_INSUFFICIENT', 'RUN_MISSING',
    'OUTSIDE_ENGINE_DOMAIN', 'METRICS_UNAVAILABLE', 'BENCHMARK_UNAVAILABLE'
  )),
  PRIMARY KEY (report_digest, gate_id),
  CONSTRAINT gate_results_reason_iff_undecided CHECK (
    (result IN ('INSUFFICIENT', 'NOT_APPLICABLE')) = (reason_code IS NOT NULL)
  )
);
CREATE TRIGGER gate_results_immutable BEFORE UPDATE OR DELETE ON gate_results
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- Eligibility for EVALUATING to PAPER (OQ-02 section 4) combines the gate results with the blocking findings. S1
-- records it, but writes no EVALUATING to PAPER Decision. A candidate that is not eligible names its reasons.
CREATE TABLE eligibility (
  mission_id oq_identifier NOT NULL REFERENCES missions (mission_id),
  strategy_hash oq_digest NOT NULL,
  report_digest oq_digest NOT NULL,
  state text NOT NULL CHECK (state IN ('ELIGIBLE', 'NOT_ELIGIBLE')),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (mission_id, strategy_hash),
  CONSTRAINT eligibility_report FOREIGN KEY (report_digest, strategy_hash)
    REFERENCES gate_reports (report_digest, strategy_hash),
  CONSTRAINT eligibility_not_eligible_has_reasons CHECK (state = 'ELIGIBLE' OR jsonb_array_length(reasons) > 0)
);
CREATE TRIGGER eligibility_immutable BEFORE UPDATE OR DELETE ON eligibility
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The recorded close of a mission: its one outcome, with a reason for every slot. The composite key keeps the row
-- equal to the mission's own status and outcome.
ALTER TABLE missions ADD CONSTRAINT missions_outcome_key UNIQUE (mission_id, status, outcome);
CREATE TABLE mission_outcomes (
  mission_id oq_identifier PRIMARY KEY,
  status text NOT NULL DEFAULT 'CONCLUDED' CHECK (status = 'CONCLUDED'),
  outcome text NOT NULL CHECK (outcome IN ('ELIGIBLE_FOUND', 'NO_ELIGIBLE_CANDIDATE')),
  slot_reasons jsonb NOT NULL CHECK (jsonb_typeof(slot_reasons) = 'array' AND jsonb_array_length(slot_reasons) > 0),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT mission_outcomes_mission FOREIGN KEY (mission_id, status, outcome)
    REFERENCES missions (mission_id, status, outcome)
);
CREATE TRIGGER mission_outcomes_immutable BEFORE UPDATE OR DELETE ON mission_outcomes
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();
