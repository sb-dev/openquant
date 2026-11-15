-- 0004_strategies: Strategy Versions, their lineage and the trials that registered them.
-- OQ-02 sections 1, 3.1 and 4; OQ-03 section 3. The Strategy Graph is a view derived from these tables; nothing here
-- asks for manual graph maintenance.

-- A Strategy Version is identified by the hash of its strategy-artefact/1 (OQ-02 section 1). In S1 a version is
-- DRAFT or EVALUATING: the lifecycle check has no PAPER value, so a version cannot reach paper (OQ-02 section 4).
CREATE TABLE strategy_versions (
  strategy_hash oq_digest PRIMARY KEY REFERENCES artefacts (digest),
  strategy_id oq_identifier NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  parent_hash oq_digest,
  lifecycle text NOT NULL DEFAULT 'DRAFT' CONSTRAINT strategy_versions_s1_lifecycle CHECK (lifecycle IN ('DRAFT', 'EVALUATING')),
  mission_id oq_identifier NOT NULL REFERENCES missions (mission_id),
  registered_at timestamptz NOT NULL,
  CONSTRAINT strategy_versions_identity UNIQUE (strategy_id, version),
  CONSTRAINT strategy_versions_hash_strategy UNIQUE (strategy_hash, strategy_id),
  CONSTRAINT strategy_versions_hash_parent UNIQUE (strategy_hash, parent_hash),
  -- A parent belongs to the same strategy, and a version has a parent exactly when it is not version 1.
  CONSTRAINT strategy_versions_parent FOREIGN KEY (parent_hash, strategy_id)
    REFERENCES strategy_versions (strategy_hash, strategy_id),
  CONSTRAINT strategy_versions_parent_iff_revision CHECK ((version = 1) = (parent_hash IS NULL)),
  CONSTRAINT strategy_versions_not_own_parent CHECK (parent_hash IS NULL OR parent_hash <> strategy_hash)
);

-- A version is immutable apart from its lifecycle, and the lifecycle moves DRAFT to EVALUATING only.
CREATE FUNCTION oq_strategy_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'strategy_versions is append-only: DELETE is not allowed'
      USING ERRCODE = '23514', CONSTRAINT = 'strategy_versions_immutable';
  END IF;
  IF (to_jsonb(NEW) - 'lifecycle') IS DISTINCT FROM (to_jsonb(OLD) - 'lifecycle') THEN
    RAISE EXCEPTION 'strategy_versions: only the lifecycle may change'
      USING ERRCODE = '23514', CONSTRAINT = 'strategy_versions_immutable';
  END IF;
  IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle AND NOT (OLD.lifecycle = 'DRAFT' AND NEW.lifecycle = 'EVALUATING') THEN
    RAISE EXCEPTION 'strategy_versions lifecycle % to % is not a listed transition', OLD.lifecycle, NEW.lifecycle
      USING ERRCODE = '23514', CONSTRAINT = 'strategy_versions_lifecycle_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER strategy_versions_guard BEFORE UPDATE OR DELETE ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION oq_strategy_versions_guard();
CREATE INDEX strategy_versions_mission ON strategy_versions (mission_id);

-- The recorded change of a controlled revision: which rule changed (OQ-02 section 3.1) and the validation result that
-- recomputed it. The parent in this row must be the parent of the version.
CREATE TABLE strategy_lineage (
  child_hash oq_digest PRIMARY KEY,
  parent_hash oq_digest NOT NULL,
  change_scope text NOT NULL CHECK (change_scope IN ('ENTRY', 'EXIT')),
  validation_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT strategy_lineage_version FOREIGN KEY (child_hash, parent_hash)
    REFERENCES strategy_versions (strategy_hash, parent_hash),
  CONSTRAINT strategy_lineage_child_differs CHECK (child_hash <> parent_hash)
);
CREATE TRIGGER strategy_lineage_immutable BEFORE UPDATE OR DELETE ON strategy_lineage
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- One trial per proposal that entered validation (OQ-02 section 3.1; A06): invalid and discarded proposals stay in the
-- search history. A trial is REGISTERED exactly when it names its Strategy Version, and a slot has one registered trial.
CREATE TABLE trials (
  trial_id oq_identifier PRIMARY KEY,
  mission_id oq_identifier NOT NULL,
  trial_slot oq_identifier NOT NULL,
  proposal_ordinal integer NOT NULL CHECK (proposal_ordinal BETWEEN 1 AND 100),
  draft_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  status text NOT NULL DEFAULT 'DRAFTED' CHECK (status IN ('DRAFTED', 'INVALID', 'REGISTERED', 'DISCARDED')),
  strategy_hash oq_digest REFERENCES strategy_versions (strategy_hash),
  reason text CHECK (char_length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  CONSTRAINT trials_slot FOREIGN KEY (mission_id, trial_slot) REFERENCES trial_slots (mission_id, trial_slot),
  CONSTRAINT trials_proposal_unique UNIQUE (mission_id, trial_slot, proposal_ordinal),
  CONSTRAINT trials_registered_iff_version CHECK ((status = 'REGISTERED') = (strategy_hash IS NOT NULL)),
  CONSTRAINT trials_failed_has_reason CHECK (status NOT IN ('INVALID', 'DISCARDED') OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX trials_one_registered_per_slot ON trials (mission_id, trial_slot) WHERE status = 'REGISTERED';
CREATE TRIGGER trials_transition BEFORE UPDATE OF status ON trials
  FOR EACH ROW EXECUTE FUNCTION oq_check_transition('trial');
