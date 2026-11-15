-- 0003_missions: seed drafts and their source interpretation, missions, mission budgets, agent configurations,
-- the evaluation plan with its comparison, trial slots and run slots.
-- OQ-02 sections 1, 3.1, 3.3 and 4; OQ-03 section 1. The state rules of the specification are stated as constraints.

-- The seed is stored as a draft by its draft digest (OQ-02 section 4). It is not a Strategy Version.
CREATE TABLE seed_drafts (
  draft_digest oq_digest PRIMARY KEY REFERENCES artefacts (digest),
  origin text NOT NULL CHECK (origin IN ('researcher_authored')),
  registered_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  registered_at timestamptz NOT NULL
);
CREATE TRIGGER seed_drafts_immutable BEFORE UPDATE OR DELETE ON seed_drafts
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The source-interpretation record of a seed: its sources and every source-to-seed difference (OQ-03 section 1).
CREATE TABLE source_interpretations (
  draft_digest oq_digest PRIMARY KEY REFERENCES seed_drafts (draft_digest),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 8),
  source_differences jsonb NOT NULL
    CHECK (jsonb_typeof(source_differences) = 'array' AND jsonb_array_length(source_differences) <= 64),
  recorded_at timestamptz NOT NULL
);
CREATE TRIGGER source_interpretations_immutable BEFORE UPDATE OR DELETE ON source_interpretations
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The mission status and the pairs that go with it (OQ-02 section 1): an outcome exists exactly when the mission is
-- CONCLUDED, a BLOCKED mission names its reason, and a WITHDRAWN mission names who withdrew it and when.
CREATE TABLE missions (
  mission_id oq_identifier PRIMARY KEY,
  status text NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'IN_PROGRESS', 'BLOCKED', 'WITHDRAWN', 'CONCLUDED')),
  outcome text CHECK (outcome IN ('ELIGIBLE_FOUND', 'NO_ELIGIBLE_CANDIDATE')),
  outcome_reason text CHECK (char_length(outcome_reason) BETWEEN 1 AND 2000),
  blocked_reason text CHECK (char_length(blocked_reason) BETWEEN 1 AND 1000),
  objective text NOT NULL CHECK (char_length(objective) <= 2000),
  instrument_id oq_identifier NOT NULL,
  symbol text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  provider oq_identifier NOT NULL,
  provider_asset_id oq_identifier NOT NULL,
  instrument_effective_from date NOT NULL,
  profile_id oq_identifier NOT NULL,
  profile_revision integer NOT NULL,
  policy_id oq_identifier NOT NULL,
  policy_revision integer NOT NULL,
  seed_draft_digest oq_digest NOT NULL REFERENCES seed_drafts (draft_digest),
  created_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  created_at timestamptz NOT NULL,
  started_by oq_identifier REFERENCES principals (principal_id),
  started_at timestamptz,
  withdrawn_by oq_identifier REFERENCES principals (principal_id),
  withdrawn_at timestamptz,
  concluded_at timestamptz,
  -- The compare-and-set revision of the guarded commands: expected_revision of a command is checked against it.
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CONSTRAINT missions_profile FOREIGN KEY (profile_id, profile_revision)
    REFERENCES research_profiles (profile_id, revision),
  CONSTRAINT missions_policy FOREIGN KEY (policy_id, policy_revision)
    REFERENCES cohort_policies (policy_id, revision),
  CONSTRAINT missions_outcome_iff_concluded CHECK ((status = 'CONCLUDED') = (outcome IS NOT NULL)),
  CONSTRAINT missions_outcome_has_reason CHECK (outcome IS NULL OR outcome_reason IS NOT NULL),
  CONSTRAINT missions_blocked_has_reason CHECK (status <> 'BLOCKED' OR blocked_reason IS NOT NULL),
  CONSTRAINT missions_withdrawn_shape CHECK (
    (status = 'WITHDRAWN') = (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL)
  ),
  CONSTRAINT missions_concluded_at CHECK ((status = 'CONCLUDED') = (concluded_at IS NOT NULL)),
  CONSTRAINT missions_started_before_work CHECK (
    status IN ('CREATED', 'WITHDRAWN') OR (started_by IS NOT NULL AND started_at IS NOT NULL)
  ),
  CONSTRAINT missions_id_policy UNIQUE (mission_id, policy_id, policy_revision),
  CONSTRAINT missions_id_profile UNIQUE (mission_id, profile_id, profile_revision),
  CONSTRAINT missions_id_started_by UNIQUE (mission_id, started_by)
);
CREATE TRIGGER missions_transition BEFORE UPDATE OF status ON missions
  FOR EACH ROW EXECUTE FUNCTION oq_check_transition('mission');
CREATE INDEX missions_status ON missions (status);

-- The per-mission budget (OQ-03 section 1, MissionBudget). The schema cannot compare values; these constraints do.
CREATE TABLE mission_budgets (
  mission_id oq_identifier PRIMARY KEY REFERENCES missions (mission_id),
  currency oq_identifier NOT NULL,
  candidates integer NOT NULL CHECK (candidates BETWEEN 0 AND 1000),
  experiments integer NOT NULL CHECK (experiments BETWEEN 0 AND 10000),
  revisions_per_proposer integer NOT NULL CHECK (revisions_per_proposer BETWEEN 0 AND 100),
  new_families integer NOT NULL CHECK (new_families BETWEEN 0 AND 1000),
  proposer_count integer NOT NULL CHECK (proposer_count BETWEEN 1 AND 4),
  model_spend oq_money NOT NULL,
  model_spend_per_attempt oq_money NOT NULL,
  proposer_spend oq_money NOT NULL,
  proposer_attempts integer NOT NULL CHECK (proposer_attempts BETWEEN 0 AND 1000),
  critic_spend oq_money NOT NULL,
  critic_attempts integer NOT NULL CHECK (critic_attempts BETWEEN 0 AND 1000),
  provider_requests bigint NOT NULL CHECK (provider_requests BETWEEN 0 AND 1000000),
  batch_compute_seconds bigint NOT NULL CHECK (batch_compute_seconds BETWEEN 0 AND 100000000),
  agent_compute_seconds bigint NOT NULL CHECK (agent_compute_seconds BETWEEN 0 AND 100000000),
  attempt_cap integer NOT NULL CHECK (attempt_cap BETWEEN 1 AND 10),
  CONSTRAINT mission_budgets_model_spend_sum CHECK (model_spend = proposer_count * proposer_spend + critic_spend),
  CONSTRAINT mission_budgets_proposer_allowance CHECK (proposer_spend = proposer_attempts * model_spend_per_attempt),
  CONSTRAINT mission_budgets_critic_allowance CHECK (critic_spend = critic_attempts * model_spend_per_attempt)
);
CREATE TRIGGER mission_budgets_immutable BEFORE UPDATE OR DELETE ON mission_budgets
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- An agent configuration: executor profile plus bundle hash, and the model's knowledge cutoff as the provider states
-- it, or unknown with the reason, never inferred (OQ-03 section 2).
CREATE TABLE mission_agent_configurations (
  mission_id oq_identifier NOT NULL REFERENCES missions (mission_id),
  configuration_id oq_identifier NOT NULL,
  role text NOT NULL CHECK (role IN ('PROPOSER', 'CRITIC')),
  executor_model oq_identifier NOT NULL,
  executor_effort text NOT NULL
    CHECK (executor_effort IN ('executor_default', 'low', 'medium', 'high', 'xhigh', 'max')),
  bundle_hash oq_digest NOT NULL,
  cutoff_status text NOT NULL CHECK (cutoff_status IN ('published', 'unknown')),
  cutoff text CHECK (cutoff ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'),
  cutoff_source text CHECK (char_length(cutoff_source) <= 300),
  cutoff_read_on date,
  cutoff_unknown_reason text CHECK (char_length(cutoff_unknown_reason) <= 500),
  PRIMARY KEY (mission_id, configuration_id),
  CONSTRAINT mission_agent_role_key UNIQUE (mission_id, configuration_id, role),
  CONSTRAINT mission_agent_cutoff_shape CHECK (
    (cutoff_status = 'published' AND cutoff IS NOT NULL AND cutoff_source IS NOT NULL
      AND cutoff_read_on IS NOT NULL AND cutoff_unknown_reason IS NULL)
    OR (cutoff_status = 'unknown' AND cutoff IS NULL AND cutoff_source IS NULL
      AND cutoff_read_on IS NULL AND cutoff_unknown_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX mission_agent_one_critic ON mission_agent_configurations (mission_id) WHERE role = 'CRITIC';
CREATE TRIGGER mission_agent_configurations_immutable BEFORE UPDATE OR DELETE ON mission_agent_configurations
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The evaluation plan, recorded once when the mission starts and never changed (OQ-02 section 3.1). The three
-- scored windows hold the resolved first and last scored session of each window rule. They must not overlap, and
-- they run in the order D, V, H (OQ-02 section 3.3).
CREATE TABLE evaluation_plans (
  plan_digest oq_digest PRIMARY KEY REFERENCES artefacts (digest),
  plan_id oq_identifier NOT NULL,
  mission_id oq_identifier NOT NULL,
  profile_id oq_identifier NOT NULL,
  profile_revision integer NOT NULL,
  policy_id oq_identifier NOT NULL,
  policy_revision integer NOT NULL,
  suite_id oq_identifier NOT NULL,
  calendar_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  warmup_sessions integer NOT NULL CHECK (warmup_sessions BETWEEN 1 AND 399),
  d_start date NOT NULL,
  d_end date NOT NULL,
  v_start date NOT NULL,
  v_end date NOT NULL,
  h_start date NOT NULL,
  h_end date NOT NULL,
  recorded_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT evaluation_plans_mission_once UNIQUE (mission_id),
  CONSTRAINT evaluation_plans_id_unique UNIQUE (plan_id),
  CONSTRAINT evaluation_plans_digest_mission UNIQUE (plan_digest, mission_id),
  CONSTRAINT evaluation_plans_mission_profile FOREIGN KEY (mission_id, profile_id, profile_revision)
    REFERENCES missions (mission_id, profile_id, profile_revision),
  CONSTRAINT evaluation_plans_mission_policy FOREIGN KEY (mission_id, policy_id, policy_revision)
    REFERENCES missions (mission_id, policy_id, policy_revision),
  CONSTRAINT evaluation_plans_window_d CHECK (d_end >= d_start),
  CONSTRAINT evaluation_plans_window_v CHECK (v_end >= v_start),
  CONSTRAINT evaluation_plans_window_h CHECK (h_end >= h_start),
  CONSTRAINT evaluation_plans_windows_do_not_overlap CHECK (d_end < v_start AND v_end < h_start)
);
CREATE TRIGGER evaluation_plans_immutable BEFORE UPDATE OR DELETE ON evaluation_plans
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The registered comparison: the conditions that every candidate runs under, frozen with the plan. The cost cases
-- and the one run that is evaluated a second time for the deterministic replay gate.
CREATE TABLE comparisons (
  plan_digest oq_digest PRIMARY KEY REFERENCES evaluation_plans (plan_digest),
  cost_stress_multiplier numeric(12, 6) NOT NULL CHECK (cost_stress_multiplier > 1),
  repeat_window_role text NOT NULL CHECK (repeat_window_role IN ('DEVELOPMENT', 'VALIDATION', 'HOLDOUT')),
  repeat_cost_scenario text NOT NULL CHECK (repeat_cost_scenario IN ('BASE', 'COST_STRESS'))
);
CREATE TRIGGER comparisons_immutable BEFORE UPDATE OR DELETE ON comparisons
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- A trial slot is a candidate place in the comparison: the seed, or the one controlled revision of a proposer
-- configuration. Slots are planned, not runs. terminal_reason is set when a slot gets no runs.
CREATE TABLE trial_slots (
  mission_id oq_identifier NOT NULL REFERENCES missions (mission_id),
  trial_slot oq_identifier NOT NULL,
  plan_digest oq_digest NOT NULL,
  slot_kind text NOT NULL CHECK (slot_kind IN ('SEED', 'REVISION')),
  strategy_id oq_identifier,
  draft_digest oq_digest REFERENCES seed_drafts (draft_digest),
  parent_slot oq_identifier,
  -- A revision slot belongs to a proposer configuration and descends from the seed slot: the generated columns
  -- turn those two facts into composite foreign keys.
  parent_kind text GENERATED ALWAYS AS (CASE WHEN parent_slot IS NOT NULL THEN 'SEED' END) STORED,
  configuration_id oq_identifier,
  configuration_role text GENERATED ALWAYS AS (CASE WHEN configuration_id IS NOT NULL THEN 'PROPOSER' END) STORED,
  terminal_reason text
    CHECK (terminal_reason IN ('DECISION_DEFERRED', 'NO_REGISTERED_VERSION', 'SEED_NOT_EVALUATED')),
  terminal_at timestamptz,
  PRIMARY KEY (mission_id, trial_slot),
  CONSTRAINT trial_slots_kind_key UNIQUE (mission_id, trial_slot, slot_kind),
  CONSTRAINT trial_slots_parent FOREIGN KEY (mission_id, parent_slot, parent_kind)
    REFERENCES trial_slots (mission_id, trial_slot, slot_kind),
  CONSTRAINT trial_slots_configuration FOREIGN KEY (mission_id, configuration_id, configuration_role)
    REFERENCES mission_agent_configurations (mission_id, configuration_id, role),
  CONSTRAINT trial_slots_shape CHECK (
    (slot_kind = 'SEED' AND strategy_id IS NOT NULL AND draft_digest IS NOT NULL
      AND parent_slot IS NULL AND configuration_id IS NULL)
    OR (slot_kind = 'REVISION' AND strategy_id IS NULL AND draft_digest IS NULL
      AND parent_slot IS NOT NULL AND configuration_id IS NOT NULL)
  ),
  CONSTRAINT trial_slots_seed_not_evaluated_is_a_revision CHECK (
    terminal_reason IS DISTINCT FROM 'SEED_NOT_EVALUATED' OR slot_kind = 'REVISION'
  ),
  CONSTRAINT trial_slots_terminal_pair CHECK ((terminal_reason IS NULL) = (terminal_at IS NULL)),
  CONSTRAINT trial_slots_plan FOREIGN KEY (plan_digest, mission_id)
    REFERENCES evaluation_plans (plan_digest, mission_id)
);
CREATE UNIQUE INDEX trial_slots_one_seed ON trial_slots (mission_id) WHERE slot_kind = 'SEED';
CREATE UNIQUE INDEX trial_slots_one_revision_per_configuration ON trial_slots (mission_id, configuration_id)
  WHERE slot_kind = 'REVISION';

-- A run slot is one planned run of one trial slot. HOLDOUT runs are written only by freeze_candidates, and every
-- other run by the policy-determined Decision (OQ-02 section 4). A repeat names the run slot that it repeats.
CREATE TABLE run_slots (
  mission_id oq_identifier NOT NULL,
  run_slot oq_identifier NOT NULL,
  trial_slot oq_identifier NOT NULL,
  window_role text NOT NULL CHECK (window_role IN ('DEVELOPMENT', 'VALIDATION', 'HOLDOUT')),
  cost_scenario text NOT NULL CHECK (cost_scenario IN ('BASE', 'COST_STRESS')),
  written_by text NOT NULL CHECK (written_by IN ('EVALUATING_DECISION', 'FREEZE_CANDIDATES')),
  replay_of oq_identifier,
  PRIMARY KEY (mission_id, run_slot),
  CONSTRAINT run_slots_trial FOREIGN KEY (mission_id, trial_slot) REFERENCES trial_slots (mission_id, trial_slot),
  CONSTRAINT run_slots_replay FOREIGN KEY (mission_id, replay_of) REFERENCES run_slots (mission_id, run_slot),
  CONSTRAINT run_slots_holdout_by_freeze CHECK ((window_role = 'HOLDOUT') = (written_by = 'FREEZE_CANDIDATES')),
  CONSTRAINT run_slots_replay_is_another_slot CHECK (replay_of IS NULL OR replay_of <> run_slot),
  CONSTRAINT run_slots_window_key UNIQUE (mission_id, run_slot, trial_slot, window_role, cost_scenario)
);
-- Each window and cost case of a trial slot has one planned run; the repeat is the one other slot of its cell.
CREATE UNIQUE INDEX run_slots_one_per_cell ON run_slots (mission_id, trial_slot, window_role, cost_scenario)
  WHERE replay_of IS NULL;
CREATE UNIQUE INDEX run_slots_one_repeat_per_cell ON run_slots (mission_id, trial_slot, window_role, cost_scenario)
  WHERE replay_of IS NOT NULL;
