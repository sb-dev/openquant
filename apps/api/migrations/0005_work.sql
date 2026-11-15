-- 0005_work: runs, jobs, attempts, leases, the dispatch outbox, budget pools, reservations and the usage ledger.
-- OQ-05 section 4 (dispatch, ownership and completion); OQ-02 sections 3.6 and 8; OQ-03 section 1.
-- A logical run or job is separate from its operational attempts. Only the current attempt can commit a result.

-- An evaluation run (OQ-02 section 3.6 status). BACKTEST runs belong to a mission and to one planned run slot, and a
-- slot has at most one run. REPLAY runs (the synthetic S0 replay) belong to no mission, slot, window or plan.
CREATE TABLE runs (
  run_id oq_identifier PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('REPLAY', 'BACKTEST')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  mission_id oq_identifier,
  run_slot oq_identifier,
  trial_slot oq_identifier,
  window_role text CHECK (window_role IN ('DEVELOPMENT', 'VALIDATION', 'HOLDOUT')),
  cost_scenario text CHECK (cost_scenario IN ('BASE', 'COST_STRESS')),
  plan_digest oq_digest,
  strategy_hash oq_digest REFERENCES strategy_versions (strategy_hash),
  repeat_of_run oq_identifier REFERENCES runs (run_id),
  attempt_cap integer NOT NULL CHECK (attempt_cap BETWEEN 1 AND 10),
  failure_code text CHECK (char_length(failure_code) BETWEEN 1 AND 100),
  waiting_reason text CHECK (char_length(waiting_reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CONSTRAINT runs_backtest_shape CHECK (
    (mode = 'BACKTEST' AND mission_id IS NOT NULL AND run_slot IS NOT NULL AND trial_slot IS NOT NULL
      AND window_role IS NOT NULL AND cost_scenario IS NOT NULL AND plan_digest IS NOT NULL
      AND strategy_hash IS NOT NULL)
    OR (mode = 'REPLAY' AND mission_id IS NULL AND run_slot IS NULL AND trial_slot IS NULL
      AND window_role IS NULL AND cost_scenario IS NULL AND plan_digest IS NULL AND repeat_of_run IS NULL)
  ),
  CONSTRAINT runs_slot FOREIGN KEY (mission_id, run_slot, trial_slot, window_role, cost_scenario)
    REFERENCES run_slots (mission_id, run_slot, trial_slot, window_role, cost_scenario),
  CONSTRAINT runs_plan FOREIGN KEY (plan_digest, mission_id) REFERENCES evaluation_plans (plan_digest, mission_id),
  CONSTRAINT runs_terminal_completed_at CHECK ((status IN ('COMPLETED', 'FAILED', 'CANCELLED')) = (completed_at IS NOT NULL)),
  CONSTRAINT runs_failed_has_code CHECK ((status = 'FAILED') = (failure_code IS NOT NULL)),
  CONSTRAINT runs_waiting_only_when_queued CHECK (waiting_reason IS NULL OR status = 'QUEUED'),
  CONSTRAINT runs_cap_key UNIQUE (run_id, attempt_cap),
  CONSTRAINT runs_status_key UNIQUE (run_id, status),
  CONSTRAINT runs_window_key UNIQUE (run_id, window_role)
);
-- A planned run slot has at most one run: redelivery or a second command cannot write another.
CREATE UNIQUE INDEX runs_one_per_slot ON runs (mission_id, run_slot) WHERE run_slot IS NOT NULL;
CREATE TRIGGER runs_transition BEFORE UPDATE OF status ON runs
  FOR EACH ROW EXECUTE FUNCTION oq_check_transition('run');
CREATE INDEX runs_open ON runs (status) WHERE status IN ('QUEUED', 'RUNNING');

-- The typed jobs (retrieve, validate, assess) and an agent's logical run. They use the five job status values, are
-- not evaluation runs and are not trials (OQ-05 section 4). An evaluate job is a run, not a row here.
CREATE TABLE jobs (
  job_id oq_identifier PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('retrieve', 'validate', 'assess', 'agent')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  mission_id oq_identifier NOT NULL REFERENCES missions (mission_id),
  trial_slot oq_identifier,
  agent_role text CHECK (agent_role IN ('PROPOSER', 'CRITIC')),
  configuration_id oq_identifier,
  attempt_cap integer NOT NULL CHECK (attempt_cap BETWEEN 1 AND 10),
  failure_code text CHECK (char_length(failure_code) BETWEEN 1 AND 100),
  waiting_reason text CHECK (char_length(waiting_reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CONSTRAINT jobs_slot FOREIGN KEY (mission_id, trial_slot) REFERENCES trial_slots (mission_id, trial_slot),
  -- An agent job runs one configuration of its mission, in the role that configuration has.
  CONSTRAINT jobs_configuration FOREIGN KEY (mission_id, configuration_id, agent_role)
    REFERENCES mission_agent_configurations (mission_id, configuration_id, role),
  CONSTRAINT jobs_agent_shape CHECK (
    (kind = 'agent') = (agent_role IS NOT NULL AND configuration_id IS NOT NULL)
  ),
  CONSTRAINT jobs_terminal_completed_at CHECK ((status IN ('COMPLETED', 'FAILED', 'CANCELLED')) = (completed_at IS NOT NULL)),
  CONSTRAINT jobs_failed_has_code CHECK ((status = 'FAILED') = (failure_code IS NOT NULL)),
  CONSTRAINT jobs_waiting_only_when_queued CHECK (waiting_reason IS NULL OR status = 'QUEUED'),
  CONSTRAINT jobs_cap_key UNIQUE (job_id, attempt_cap)
);
CREATE TRIGGER jobs_transition BEFORE UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION oq_check_transition('job');
CREATE INDEX jobs_open ON jobs (status) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX jobs_mission ON jobs (mission_id, kind);

-- One operational attempt of one logical run or job. ownership_revision is the attempt's ordinal and its fencing
-- revision: it is fixed when the attempt is created and never exceeds the attempt cap. A run or job has at most one
-- live (PENDING or CLAIMED) attempt, and revision N exists only when N - 1 does.
CREATE TABLE attempts (
  attempt_id oq_identifier PRIMARY KEY,
  run_id oq_identifier,
  job_id oq_identifier,
  ownership_revision integer NOT NULL CHECK (ownership_revision >= 1),
  previous_revision integer GENERATED ALWAYS AS (CASE WHEN ownership_revision > 1 THEN ownership_revision - 1 END) STORED,
  attempt_cap integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'LEASE_EXPIRED', 'CANCELLED')),
  failure_code text CHECK (char_length(failure_code) BETWEEN 1 AND 100),
  agent_outcome text CHECK (agent_outcome IN (
    'completion', 'refusal', 'malformed_result', 'denied_capability', 'authentication_failure', 'cancellation', 'timeout'
  )),
  worker_id oq_identifier,
  executable_name oq_identifier,
  executable_version oq_identifier,
  executable_digest oq_digest,
  dispatch_digest oq_digest,
  created_at timestamptz NOT NULL,
  claimed_at timestamptz,
  ended_at timestamptz,
  CONSTRAINT attempts_one_parent CHECK ((run_id IS NULL) <> (job_id IS NULL)),
  CONSTRAINT attempts_cap_not_exceeded CHECK (ownership_revision <= attempt_cap),
  CONSTRAINT attempts_run_cap FOREIGN KEY (run_id, attempt_cap) REFERENCES runs (run_id, attempt_cap),
  CONSTRAINT attempts_job_cap FOREIGN KEY (job_id, attempt_cap) REFERENCES jobs (job_id, attempt_cap),
  CONSTRAINT attempts_run_revision UNIQUE (run_id, ownership_revision),
  CONSTRAINT attempts_job_revision UNIQUE (job_id, ownership_revision),
  CONSTRAINT attempts_run_previous FOREIGN KEY (run_id, previous_revision) REFERENCES attempts (run_id, ownership_revision),
  CONSTRAINT attempts_job_previous FOREIGN KEY (job_id, previous_revision) REFERENCES attempts (job_id, ownership_revision),
  CONSTRAINT attempts_revision_key UNIQUE (attempt_id, ownership_revision),
  CONSTRAINT attempts_status_key UNIQUE (attempt_id, status),
  CONSTRAINT attempts_result_key UNIQUE (attempt_id, status, run_id),
  CONSTRAINT attempts_claimed_identity CHECK (
    status IN ('PENDING', 'CANCELLED')
    OR (claimed_at IS NOT NULL AND worker_id IS NOT NULL AND executable_name IS NOT NULL
      AND executable_version IS NOT NULL AND executable_digest IS NOT NULL AND dispatch_digest IS NOT NULL)
  ),
  CONSTRAINT attempts_pending_not_claimed CHECK (status <> 'PENDING' OR claimed_at IS NULL),
  CONSTRAINT attempts_ended_at CHECK ((status IN ('COMPLETED', 'FAILED', 'LEASE_EXPIRED', 'CANCELLED')) = (ended_at IS NOT NULL)),
  CONSTRAINT attempts_failed_has_reason CHECK (status <> 'FAILED' OR failure_code IS NOT NULL OR agent_outcome IS NOT NULL)
);
-- At most one PENDING or CLAIMED attempt per logical run or job (OQ-05 section 4).
CREATE UNIQUE INDEX attempts_one_live_per_run ON attempts (run_id)
  WHERE run_id IS NOT NULL AND status IN ('PENDING', 'CLAIMED');
CREATE UNIQUE INDEX attempts_one_live_per_job ON attempts (job_id)
  WHERE job_id IS NOT NULL AND status IN ('PENDING', 'CLAIMED');
CREATE TRIGGER attempts_transition BEFORE UPDATE OF status ON attempts
  FOR EACH ROW EXECUTE FUNCTION oq_check_transition('attempt');
CREATE INDEX attempts_claimed ON attempts (attempt_id) WHERE status = 'CLAIMED';

ALTER TABLE artefacts
  ADD CONSTRAINT artefacts_uploaded_by_attempt FOREIGN KEY (uploaded_by_attempt) REFERENCES attempts (attempt_id);

-- The application lease of a claimed attempt (OQ-05 section 4), separate from any queue receipt. The capability
-- hash binds the attempt-scoped token that the claim returned; the token expires with the lease.
CREATE TABLE leases (
  attempt_id oq_identifier PRIMARY KEY,
  ownership_revision integer NOT NULL,
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'RELEASED', 'EXPIRED')),
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  capability_hash oq_digest NOT NULL,
  CONSTRAINT leases_attempt FOREIGN KEY (attempt_id, ownership_revision) REFERENCES attempts (attempt_id, ownership_revision),
  CONSTRAINT leases_expiry_after_grant CHECK (expires_at > granted_at),
  CONSTRAINT leases_held_not_released CHECK ((status = 'HELD') = (released_at IS NULL)),
  CONSTRAINT leases_capability_unique UNIQUE (capability_hash)
);
CREATE TRIGGER leases_transition BEFORE UPDATE OF status ON leases
  FOR EACH ROW EXECUTE FUNCTION oq_check_transition('lease');
CREATE INDEX leases_held_expiry ON leases (expires_at) WHERE status = 'HELD';

-- The lease is HELD exactly while its attempt is CLAIMED (OQ-05 section 4). Checked when the transaction commits,
-- so a claim can write the attempt and the lease in either order.
CREATE FUNCTION oq_check_lease_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_status text;
  lease_status text;
BEGIN
  SELECT status INTO attempt_status FROM attempts WHERE attempt_id = NEW.attempt_id;
  SELECT status INTO lease_status FROM leases WHERE attempt_id = NEW.attempt_id;
  IF attempt_status IS NOT NULL AND (attempt_status = 'CLAIMED') IS DISTINCT FROM COALESCE(lease_status = 'HELD', false) THEN
    RAISE EXCEPTION 'attempt % is % but its lease is %', NEW.attempt_id, attempt_status, COALESCE(lease_status, 'missing')
      USING ERRCODE = '23514', CONSTRAINT = 'leases_held_iff_attempt_claimed';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER attempts_lease_consistency AFTER INSERT OR UPDATE OF status ON attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION oq_check_lease_consistency();
CREATE CONSTRAINT TRIGGER leases_lease_consistency AFTER INSERT OR UPDATE OF status ON leases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION oq_check_lease_consistency();

-- The dispatch outbox: written in the transaction that creates the attempt, sent later under the same attempt id.
CREATE TABLE outbox (
  attempt_id oq_identifier PRIMARY KEY REFERENCES attempts (attempt_id) DEFERRABLE INITIALLY DEFERRED,
  destination text NOT NULL CHECK (destination IN ('BATCH_QUEUE', 'AGENT_RUNNER')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'CANCELLED')),
  message jsonb NOT NULL CHECK (jsonb_typeof(message) = 'object'),
  message_digest oq_digest NOT NULL,
  created_at timestamptz NOT NULL,
  sent_at timestamptz,
  CONSTRAINT outbox_sent_has_time CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE TRIGGER outbox_transition BEFORE UPDATE OF status ON outbox
  FOR EACH ROW EXECUTE FUNCTION oq_check_transition('outbox');
CREATE INDEX outbox_pending ON outbox (created_at) WHERE status = 'PENDING';

-- Budget pools. A pool is one limit that reservations draw on: a dimension of a mission budget (model spend, split by
-- agent configuration; provider requests; batch and agent compute seconds) or of a period cap. committed counts the
-- reservations and the spend of the pool and can never exceed the limit, so two overlapping calls cannot overspend
-- (OQ-03 section 1). overrun records usage above a reservation; it blocks further reservations (OQ-05 section 4).
CREATE TABLE budget_pools (
  pool_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('MISSION', 'PERIOD')),
  mission_id oq_identifier REFERENCES missions (mission_id),
  configuration_id oq_identifier,
  budget_id oq_identifier,
  budget_revision integer,
  dimension text NOT NULL
    CHECK (dimension IN ('MODEL_SPEND', 'PROVIDER_REQUESTS', 'BATCH_COMPUTE_SECONDS', 'AGENT_COMPUTE_SECONDS')),
  limit_amount numeric(24, 8) NOT NULL CHECK (limit_amount >= 0),
  committed numeric(24, 8) NOT NULL DEFAULT 0 CHECK (committed >= 0),
  overrun numeric(24, 8) NOT NULL DEFAULT 0 CHECK (overrun >= 0),
  CONSTRAINT budget_pools_not_overspent CHECK (committed <= limit_amount),
  CONSTRAINT budget_pools_scope_shape CHECK (
    (scope = 'MISSION' AND mission_id IS NOT NULL AND budget_id IS NULL AND budget_revision IS NULL)
    OR (scope = 'PERIOD' AND mission_id IS NULL AND configuration_id IS NULL
      AND budget_id IS NOT NULL AND budget_revision IS NOT NULL)
  ),
  CONSTRAINT budget_pools_configuration_is_model_spend CHECK (configuration_id IS NULL OR dimension = 'MODEL_SPEND'),
  CONSTRAINT budget_pools_configuration FOREIGN KEY (mission_id, configuration_id)
    REFERENCES mission_agent_configurations (mission_id, configuration_id),
  CONSTRAINT budget_pools_period FOREIGN KEY (budget_id, budget_revision) REFERENCES budget_caps (budget_id, revision)
);
CREATE UNIQUE INDEX budget_pools_mission_dimension ON budget_pools (mission_id, dimension)
  WHERE scope = 'MISSION' AND configuration_id IS NULL;
CREATE UNIQUE INDEX budget_pools_mission_configuration ON budget_pools (mission_id, dimension, configuration_id)
  WHERE scope = 'MISSION' AND configuration_id IS NOT NULL;
CREATE UNIQUE INDEX budget_pools_period_dimension ON budget_pools (budget_id, budget_revision, dimension)
  WHERE scope = 'PERIOD';

-- One reservation per attempt, written with the attempt and its outbox row (OQ-05 section 4).
CREATE TABLE reservations (
  attempt_id oq_identifier PRIMARY KEY REFERENCES attempts (attempt_id) DEFERRABLE INITIALLY DEFERRED,
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'SETTLED', 'UNRECONCILED', 'RELEASED')),
  reserved_at timestamptz NOT NULL,
  settled_at timestamptz,
  released_at timestamptz,
  CONSTRAINT reservations_settled_has_time CHECK ((status = 'SETTLED') = (settled_at IS NOT NULL)),
  CONSTRAINT reservations_released_has_time CHECK ((status = 'RELEASED') = (released_at IS NOT NULL))
);
CREATE TRIGGER reservations_transition BEFORE UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION oq_check_transition('reservation');

-- What a reservation holds in each pool. used is NULL until a usage report arrives. An unknown report keeps the full
-- reservation (OQ-03 section 1): its label is 'unknown' and it carries no amount, never zero.
CREATE TABLE reservation_lines (
  attempt_id oq_identifier NOT NULL REFERENCES reservations (attempt_id) DEFERRABLE INITIALLY DEFERRED,
  pool_id bigint NOT NULL REFERENCES budget_pools (pool_id),
  reserved numeric(24, 8) NOT NULL CHECK (reserved >= 0),
  used numeric(24, 8) CONSTRAINT reservation_lines_used_not_negative CHECK (used >= 0),
  usage_label text CHECK (usage_label IN ('observed', 'estimated', 'unknown')),
  PRIMARY KEY (attempt_id, pool_id),
  CONSTRAINT reservation_lines_label_matches_amount CHECK (
    COALESCE(usage_label IN ('observed', 'estimated'), false) = (used IS NOT NULL)
  )
);

-- Attempt, reservation, outbox row and at least one reservation line commit together or not at all.
CREATE FUNCTION oq_check_attempt_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reservations WHERE attempt_id = NEW.attempt_id)
    OR NOT EXISTS (SELECT 1 FROM outbox WHERE attempt_id = NEW.attempt_id)
    OR NOT EXISTS (SELECT 1 FROM reservation_lines WHERE attempt_id = NEW.attempt_id) THEN
    RAISE EXCEPTION 'attempt % needs its reservation, a reservation line and its outbox row in the same transaction', NEW.attempt_id
      USING ERRCODE = '23514', CONSTRAINT = 'attempts_have_reservation_and_outbox';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER attempts_complete AFTER INSERT ON attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION oq_check_attempt_complete();

-- Every movement of reserved or used amounts, append-only. UNRECONCILE counts the full reservation as spent.
CREATE TABLE usage_ledger (
  ledger_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id oq_identifier NOT NULL REFERENCES attempts (attempt_id),
  pool_id bigint NOT NULL REFERENCES budget_pools (pool_id),
  entry_kind text NOT NULL
    CHECK (entry_kind IN ('RESERVE', 'SETTLE', 'UNRECONCILE', 'RELEASE', 'OVERRUN', 'RECONCILE')),
  amount numeric(24, 8) NOT NULL CHECK (amount >= 0),
  usage_label text CHECK (usage_label IN ('observed', 'estimated', 'unknown')),
  recorded_at timestamptz NOT NULL
);
CREATE TRIGGER usage_ledger_immutable BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();
CREATE INDEX usage_ledger_attempt ON usage_ledger (attempt_id);

-- Platform failures and blocked work that an operator must see. The specifications name attention items but no status
-- values; OPEN, ACKNOWLEDGED and RESOLVED are an assumption, flagged for the owner (OQ-02 section 3.6).
CREATE TABLE attention_items (
  item_id oq_identifier PRIMARY KEY,
  mission_id oq_identifier REFERENCES missions (mission_id),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CONSTRAINT attention_items_resolved_has_time CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
);
