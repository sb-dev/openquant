-- 0009_attempt_routes: what the attempt, result and recovery routes of P2 part C need beyond the tables of 0001 to 0008.
-- OQ-05 sections 4 and 7; OQ-02 sections 3.1 and 8; OQ-03 section 4. Nothing here is deployed yet.

-- A validate job validates one draft. The job names the draft and, for a revision, the registered parent, so that a
-- retry of the job builds the same message and the validation result can be bound to the draft that was asked for.
ALTER TABLE jobs ADD COLUMN draft_digest oq_digest REFERENCES artefacts (digest);
ALTER TABLE jobs ADD COLUMN parent_hash oq_digest REFERENCES strategy_versions (strategy_hash);
ALTER TABLE jobs ADD CONSTRAINT jobs_draft_only_for_validate CHECK (
  kind = 'validate' OR (draft_digest IS NULL AND parent_hash IS NULL)
);
ALTER TABLE jobs ADD CONSTRAINT jobs_parent_needs_draft CHECK (parent_hash IS NULL OR draft_digest IS NOT NULL);

-- The result document that an attempt ended with (a retrieval, validation, evaluation, gate or agent result), by digest.
-- A repeat of the same submission finds it and returns the stored outcome instead of a second one (OQ-05 section 4).
ALTER TABLE attempts ADD COLUMN result_digest oq_digest REFERENCES artefacts (digest);

-- The accepted record of one agent attempt: the host-captured result (agent-attempt-result/1, kept as an artefact) and,
-- for a completion, the role output that the API parsed again. Until now no table linked an attempt to the result that
-- it produced (the critique that a Decision cites is found through this row). One row per attempt: a repeat of the same
-- report finds the row and changes nothing.
CREATE TABLE agent_results (
  attempt_id oq_identifier PRIMARY KEY REFERENCES attempts (attempt_id),
  job_id oq_identifier NOT NULL REFERENCES jobs (job_id),
  role text NOT NULL CHECK (role IN ('PROPOSER', 'CRITIC')),
  outcome text NOT NULL CHECK (outcome IN (
    'completion', 'refusal', 'malformed_result', 'denied_capability', 'authentication_failure', 'cancellation', 'timeout'
  )),
  reason text CHECK (char_length(reason) BETWEEN 1 AND 100),
  result_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  output_contract text CHECK (output_contract IN ('strategy-formulation.result/1', 'strategy-critique.result/1')),
  output_digest oq_digest REFERENCES artefacts (digest),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT agent_results_output_iff_completion CHECK (
    (outcome = 'completion') = (output_digest IS NOT NULL AND output_contract IS NOT NULL)
  )
);
CREATE TRIGGER agent_results_immutable BEFORE UPDATE OR DELETE ON agent_results
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();
CREATE INDEX agent_results_job ON agent_results (job_id);
