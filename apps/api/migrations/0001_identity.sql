-- 0001_identity: shared domains, the transition guard, principals, roles, credentials and the audit log.
-- OQ-05 sections 4 and 9. Credentials are stored as hashes only. Audit rows are append-only.
-- A migration file holds no BEGIN or COMMIT: the runner applies each file in its own transaction.

-- Value domains. They repeat the patterns of packages/api-contracts/schemas/common.schema.json, so a value that
-- the contract layer would refuse cannot be stored.
CREATE DOMAIN oq_identifier AS text
  CONSTRAINT oq_identifier_pattern CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$');
CREATE DOMAIN oq_digest AS text
  CONSTRAINT oq_digest_pattern CHECK (VALUE ~ '^sha256:[0-9a-f]{64}$');
CREATE DOMAIN oq_money AS numeric(24, 8)
  CONSTRAINT oq_money_not_negative CHECK (VALUE >= 0);
CREATE DOMAIN oq_environment AS text
  CONSTRAINT oq_environment_values CHECK (VALUE IN ('DEVELOPMENT', 'STAGING', 'PRODUCTION'));
CREATE DOMAIN oq_route_id AS text
  CONSTRAINT oq_route_id_pattern CHECK (VALUE ~ '^[a-z][a-z0-9.-]{0,63}$');

-- Append-only tables raise a check violation on UPDATE and DELETE. The constraint name tells the test which table.
CREATE FUNCTION oq_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_immutable';
END
$$;

-- The transition table of OQ-05 section 4. A status change that is not listed is refused, and a terminal state
-- has no row to move from. The trigger below is the second line of defence behind the guarded commands.
CREATE TABLE state_transitions (
  entity text NOT NULL CHECK (entity IN ('run', 'job', 'attempt', 'lease', 'reservation', 'outbox', 'mission', 'trial')),
  from_state text NOT NULL,
  to_state text NOT NULL,
  PRIMARY KEY (entity, from_state, to_state),
  CONSTRAINT state_transitions_moves CHECK (from_state <> to_state)
);

INSERT INTO state_transitions (entity, from_state, to_state) VALUES
  ('run', 'QUEUED', 'RUNNING'),
  ('run', 'QUEUED', 'CANCELLED'),
  ('run', 'RUNNING', 'QUEUED'),
  ('run', 'RUNNING', 'COMPLETED'),
  ('run', 'RUNNING', 'FAILED'),
  ('run', 'RUNNING', 'CANCELLED'),
  ('job', 'QUEUED', 'RUNNING'),
  ('job', 'QUEUED', 'CANCELLED'),
  ('job', 'RUNNING', 'QUEUED'),
  ('job', 'RUNNING', 'COMPLETED'),
  ('job', 'RUNNING', 'FAILED'),
  ('job', 'RUNNING', 'CANCELLED'),
  ('attempt', 'PENDING', 'CLAIMED'),
  ('attempt', 'PENDING', 'CANCELLED'),
  ('attempt', 'CLAIMED', 'COMPLETED'),
  ('attempt', 'CLAIMED', 'FAILED'),
  ('attempt', 'CLAIMED', 'LEASE_EXPIRED'),
  ('attempt', 'CLAIMED', 'CANCELLED'),
  ('lease', 'HELD', 'RELEASED'),
  ('lease', 'HELD', 'EXPIRED'),
  ('reservation', 'RESERVED', 'SETTLED'),
  ('reservation', 'RESERVED', 'UNRECONCILED'),
  ('reservation', 'RESERVED', 'RELEASED'),
  ('reservation', 'UNRECONCILED', 'SETTLED'),
  ('outbox', 'PENDING', 'SENT'),
  ('outbox', 'PENDING', 'CANCELLED'),
  ('mission', 'CREATED', 'IN_PROGRESS'),
  ('mission', 'CREATED', 'WITHDRAWN'),
  ('mission', 'IN_PROGRESS', 'BLOCKED'),
  ('mission', 'IN_PROGRESS', 'WITHDRAWN'),
  ('mission', 'IN_PROGRESS', 'CONCLUDED'),
  ('mission', 'BLOCKED', 'WITHDRAWN'),
  ('trial', 'DRAFTED', 'INVALID'),
  ('trial', 'DRAFTED', 'REGISTERED'),
  ('trial', 'DRAFTED', 'DISCARDED');

CREATE TRIGGER state_transitions_immutable BEFORE INSERT OR UPDATE OR DELETE ON state_transitions
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- Attached to every table with a status column: oq_check_transition('<entity>').
CREATE FUNCTION oq_check_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM state_transitions
    WHERE entity = TG_ARGV[0] AND from_state = OLD.status AND to_state = NEW.status
  ) THEN
    RAISE EXCEPTION '% status % to % is not a listed transition', TG_ARGV[0], OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = TG_ARGV[0] || '_transition';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE principals (
  principal_id oq_identifier PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('HUMAN', 'SERVICE')),
  service_kind text CHECK (service_kind IN ('batch', 'runner', 'workflows', 'deploy')),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  environment oq_environment NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL,
  CONSTRAINT principals_service_kind_shape CHECK ((kind = 'SERVICE') = (service_kind IS NOT NULL)),
  CONSTRAINT principals_id_kind UNIQUE (principal_id, kind)
);
-- One service principal of each kind in each environment (OQ-05 section 9).
CREATE UNIQUE INDEX principals_one_service_per_environment ON principals (environment, service_kind)
  WHERE service_kind IS NOT NULL;

-- Roles belong to people. The composite key to (principal_id, kind) and the HUMAN check refuse a role on a
-- service principal: a service principal has no role and no trading authority.
CREATE TABLE principal_roles (
  principal_id oq_identifier NOT NULL,
  principal_kind text NOT NULL DEFAULT 'HUMAN' CONSTRAINT principal_roles_human_only CHECK (principal_kind = 'HUMAN'),
  role text NOT NULL CHECK (role IN ('Viewer', 'Researcher', 'Steward', 'Administrator')),
  granted_by oq_identifier REFERENCES principals (principal_id),
  granted_at timestamptz NOT NULL,
  PRIMARY KEY (principal_id, role),
  CONSTRAINT principal_roles_principal FOREIGN KEY (principal_id, principal_kind)
    REFERENCES principals (principal_id, kind)
);

-- A credential row holds the hash of a secret, never the secret. A service credential names the operations (route
-- identifiers) it may call; a person's credential names none.
CREATE TABLE credentials (
  credential_id oq_identifier PRIMARY KEY,
  principal_id oq_identifier NOT NULL,
  principal_kind text NOT NULL,
  secret_hash text NOT NULL CONSTRAINT credentials_hash_only CHECK (secret_hash ~ '^sha256:[0-9a-f]{64}$'),
  operations oq_route_id[],
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT credentials_principal FOREIGN KEY (principal_id, principal_kind)
    REFERENCES principals (principal_id, kind),
  CONSTRAINT credentials_hash_unique UNIQUE (secret_hash),
  CONSTRAINT credentials_operations_shape CHECK (
    (principal_kind = 'SERVICE') = (operations IS NOT NULL AND cardinality(operations) > 0)
  ),
  CONSTRAINT credentials_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at)
);

-- Audit events are written in the transaction of the change they record (OQ-02 section 8).
CREATE TABLE audit_events (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 64),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,63}$'),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  command_id oq_identifier,
  diagnostic_ref oq_identifier,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();
CREATE INDEX audit_events_subject ON audit_events (subject, audit_id);
