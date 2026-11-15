-- 0007_control: guarded commands and release records.
-- OQ-05 sections 3, 9 and 11. A command has a client command ID. The same ID returns the first result, and the same
-- ID with another body is COMMAND_ID_REUSED, which the API decides from body_digest.

CREATE TABLE commands (
  command_id oq_identifier PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN (
    'register_research_profile', 'register_cohort_policy', 'register_budget', 'register_seed', 'create_mission',
    'run_mission_now', 'cancel_mission', 'record_evaluation_decision', 'freeze_candidates'
  )),
  actor_id oq_identifier NOT NULL REFERENCES principals (principal_id),
  body_digest oq_digest NOT NULL,
  expected_revision integer NOT NULL CHECK (expected_revision BETWEEN 0 AND 1000000),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'APPLIED', 'REJECTED')),
  received_at timestamptz NOT NULL,
  applied_at timestamptz,
  rejected_at timestamptz,
  record_id oq_identifier,
  record_revision integer CHECK (record_revision BETWEEN 1 AND 1000000),
  error_code text CHECK (error_code IN (
    'UNSUPPORTED_SCHEMA_VERSION', 'SCHEMA_VIOLATION', 'INVALID_DECIMAL', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND',
    'REVISION_CONFLICT', 'COMMAND_ID_REUSED', 'STALE_OWNERSHIP', 'LEASE_EXPIRED', 'ATTEMPT_NOT_CLAIMABLE',
    'IDENTITY_MISMATCH', 'DIGEST_MISMATCH', 'POLICY_VIOLATION', 'BUDGET_EXHAUSTED', 'EXECUTION_DISABLED',
    'LIMIT_EXCEEDED', 'RATE_LIMITED', 'UNAVAILABLE', 'INTERNAL'
  )),
  error_message text CHECK (char_length(error_message) BETWEEN 1 AND 1000),
  CONSTRAINT commands_state_shape CHECK (
    (state = 'PENDING' AND applied_at IS NULL AND rejected_at IS NULL AND record_id IS NULL
      AND record_revision IS NULL AND error_code IS NULL AND error_message IS NULL)
    OR (state = 'APPLIED' AND applied_at IS NOT NULL AND rejected_at IS NULL AND record_id IS NOT NULL
      AND record_revision IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
    OR (state = 'REJECTED' AND rejected_at IS NOT NULL AND applied_at IS NULL AND record_id IS NULL
      AND record_revision IS NULL AND error_code IS NOT NULL AND error_message IS NOT NULL)
  )
);

-- A command is accepted once. It leaves PENDING once, for APPLIED or REJECTED, and then never changes.
CREATE FUNCTION oq_commands_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'PENDING'
    OR (to_jsonb(NEW) - 'state' - 'applied_at' - 'rejected_at' - 'record_id' - 'record_revision' - 'error_code' - 'error_message')
      IS DISTINCT FROM
      (to_jsonb(OLD) - 'state' - 'applied_at' - 'rejected_at' - 'record_id' - 'record_revision' - 'error_code' - 'error_message') THEN
    RAISE EXCEPTION 'commands: a command leaves PENDING once and its identity never changes'
      USING ERRCODE = '23514', CONSTRAINT = 'commands_immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commands_guard BEFORE UPDATE OR DELETE ON commands
  FOR EACH ROW EXECUTE FUNCTION oq_commands_guard();
CREATE INDEX commands_pending ON commands (received_at) WHERE state = 'PENDING';

-- Release identity (OQ-05 section 11, OQ-06 section 3): the release-manifest/1 that deploy.yml recorded, kept whole.
-- The current release of an environment is its highest release_id. The same manifest is recorded once per environment.
CREATE TABLE release_records (
  release_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  environment oq_environment NOT NULL,
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  manifest_digest oq_digest NOT NULL,
  migration_level oq_identifier NOT NULL,
  document jsonb NOT NULL,
  recorded_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT release_records_once_per_environment UNIQUE (environment, manifest_digest),
  CONSTRAINT release_records_document_matches CHECK (
    jsonb_typeof(document) = 'object'
    AND document ->> 'schema_version' = 'release-manifest/1'
    AND document ->> 'environment' = environment
    AND document ->> 'source_commit' = source_commit
    AND document ->> 'migration_level' = migration_level
  )
);
CREATE TRIGGER release_records_immutable BEFORE UPDATE OR DELETE ON release_records
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();
CREATE INDEX release_records_current ON release_records (environment, release_id DESC);
