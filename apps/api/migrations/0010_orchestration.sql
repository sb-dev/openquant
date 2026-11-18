-- 0010_orchestration: the cancellation requests to the agent runner (OQ-05 section 4, the cancel_mission row:
-- "Cancellation request to the worker or runner"; OQ-03 section 5). cancel_mission writes one row, in its transaction,
-- for every agent attempt that it cancels while claimed. The dispatcher sends it to the runner's cancel route and marks
-- it SENT, as it sends the dispatch outbox: a failed send stays PENDING and is sent again.
CREATE TABLE runner_cancellations (
  attempt_id oq_identifier PRIMARY KEY REFERENCES attempts (attempt_id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT')),
  created_at timestamptz NOT NULL,
  sent_at timestamptz,
  CONSTRAINT runner_cancellations_sent_has_time CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
-- The outbox moves of the transition table: PENDING to SENT.
CREATE TRIGGER runner_cancellations_transition BEFORE UPDATE OF status ON runner_cancellations
  FOR EACH ROW EXECUTE FUNCTION oq_check_transition('outbox');
CREATE INDEX runner_cancellations_pending ON runner_cancellations (created_at) WHERE status = 'PENDING';

-- A finding is keyed by the attempt that produced it and its position, not by the critique digest: two critiques of
-- different candidates can be byte-identical (the role output does not name the candidate), and each must keep its
-- findings (OQ-03 section 4).
ALTER TABLE findings DROP CONSTRAINT findings_position;
ALTER TABLE findings ADD CONSTRAINT findings_position UNIQUE (attempt_id, ordinal);
