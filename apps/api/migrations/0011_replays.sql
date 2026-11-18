-- 0011_replays: the connected REPLAY of a frozen synthetic input (OQ-05 section 4, "Replay runs"; OQ-02 sections 3.4
-- and 3.6). An Administrator's start_replay writes one replay record, its own budget pool, its REPLAY run, the first
-- attempt, its reservation and its outbox entry in one transaction. A replay belongs to no mission: it is not a trial,
-- has no slot, window, plan or Strategy Version, and is never competition evidence.
CREATE TABLE replays (
  replay_id oq_identifier PRIMARY KEY,
  -- The run of the replay. runs.replay_id points back here, so this column is unique but not a foreign key.
  run_id oq_identifier NOT NULL UNIQUE,
  fixture_set oq_identifier NOT NULL,
  case_id oq_identifier NOT NULL,
  strategy_id oq_identifier NOT NULL,
  strategy_version integer NOT NULL CHECK (strategy_version >= 1),
  strategy_digest oq_digest NOT NULL,
  input_digest oq_digest NOT NULL,
  -- What one attempt of the replay reserves and the lease of its claim is built from (the evaluate timeout).
  evaluate_seconds integer NOT NULL CHECK (evaluate_seconds BETWEEN 1 AND 3600),
  requested_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  requested_at timestamptz NOT NULL
);

-- A REPLAY run names its replay record, and only a REPLAY run does.
ALTER TABLE runs ADD COLUMN replay_id oq_identifier REFERENCES replays (replay_id);
ALTER TABLE runs ADD CONSTRAINT runs_replay_record CHECK ((mode = 'REPLAY') = (replay_id IS NOT NULL));
CREATE UNIQUE INDEX runs_one_per_replay ON runs (replay_id) WHERE replay_id IS NOT NULL;

-- The replay budget: one pool of batch compute seconds per replay, which no mission or period budget feeds and no
-- other work draws on.
ALTER TABLE budget_pools ADD COLUMN replay_id oq_identifier REFERENCES replays (replay_id);
ALTER TABLE budget_pools DROP CONSTRAINT budget_pools_scope_check;
ALTER TABLE budget_pools ADD CONSTRAINT budget_pools_scope_check CHECK (scope IN ('MISSION', 'PERIOD', 'REPLAY'));
ALTER TABLE budget_pools DROP CONSTRAINT budget_pools_scope_shape;
ALTER TABLE budget_pools ADD CONSTRAINT budget_pools_scope_shape CHECK (
  (scope = 'MISSION' AND mission_id IS NOT NULL AND budget_id IS NULL AND budget_revision IS NULL AND replay_id IS NULL)
  OR (scope = 'PERIOD' AND mission_id IS NULL AND configuration_id IS NULL
    AND budget_id IS NOT NULL AND budget_revision IS NOT NULL AND replay_id IS NULL)
  OR (scope = 'REPLAY' AND replay_id IS NOT NULL AND mission_id IS NULL AND configuration_id IS NULL
    AND budget_id IS NULL AND budget_revision IS NULL AND dimension = 'BATCH_COMPUTE_SECONDS')
);
CREATE UNIQUE INDEX budget_pools_replay ON budget_pools (replay_id) WHERE scope = 'REPLAY';
