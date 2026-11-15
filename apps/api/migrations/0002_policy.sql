-- 0002_policy: content-addressed artefacts, the period cap, research profiles and cohort policies.
-- OQ-05 sections 5 and 7; OQ-02 sections 1 and 3.1. Every registered record is an immutable revision. Revision N
-- needs revision N - 1 (the generated previous_revision and its foreign key), so a revision cannot skip a number.

-- An artefact row records an object in R2 by the SHA-256 of its bytes. The Worker verifies the hash before it writes
-- (OQ-05 section 5). uploaded_by_attempt gets its foreign key in 0005, when attempts exist.
CREATE TABLE artefacts (
  digest oq_digest PRIMARY KEY,
  media_type text NOT NULL CHECK (char_length(media_type) <= 100 AND media_type ~ '^[a-z]+/[a-z0-9.+-]+$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 1073741824),
  stored_at timestamptz NOT NULL,
  uploaded_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  uploaded_by_attempt oq_identifier
);
CREATE TRIGGER artefacts_immutable BEFORE UPDATE OR DELETE ON artefacts
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- The period cap of a Steward (OQ-03 section 1): model spend and provider requests across missions for a calendar
-- period with inclusive bounds. A mission draws on it; a new mission does not reset it.
CREATE TABLE budget_caps (
  budget_id oq_identifier NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  previous_revision integer GENERATED ALWAYS AS (CASE WHEN revision > 1 THEN revision - 1 END) STORED,
  period_start date NOT NULL,
  period_end date NOT NULL,
  model_spend oq_money NOT NULL,
  currency oq_identifier NOT NULL,
  provider_requests bigint NOT NULL CHECK (provider_requests BETWEEN 0 AND 10000000),
  document_digest oq_digest REFERENCES artefacts (digest),
  registered_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  registered_at timestamptz NOT NULL,
  PRIMARY KEY (budget_id, revision),
  CONSTRAINT budget_caps_period_order CHECK (period_end >= period_start),
  CONSTRAINT budget_caps_previous FOREIGN KEY (budget_id, previous_revision) REFERENCES budget_caps (budget_id, revision)
);
CREATE TRIGGER budget_caps_immutable BEFORE UPDATE OR DELETE ON budget_caps
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- A research profile revision names the period cap that its missions draw on.
CREATE TABLE research_profiles (
  profile_id oq_identifier NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  previous_revision integer GENERATED ALWAYS AS (CASE WHEN revision > 1 THEN revision - 1 END) STORED,
  document_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  budget_id oq_identifier NOT NULL,
  budget_revision integer NOT NULL,
  registered_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  registered_at timestamptz NOT NULL,
  PRIMARY KEY (profile_id, revision),
  CONSTRAINT research_profiles_document_unique UNIQUE (document_digest),
  CONSTRAINT research_profiles_previous FOREIGN KEY (profile_id, previous_revision)
    REFERENCES research_profiles (profile_id, revision),
  CONSTRAINT research_profiles_budget FOREIGN KEY (budget_id, budget_revision)
    REFERENCES budget_caps (budget_id, revision)
);
CREATE TRIGGER research_profiles_immutable BEFORE UPDATE OR DELETE ON research_profiles
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();

-- A cohort policy revision names its suite. A Steward's approval is a Decision (0006); it is not a column here, so
-- one revision can be approved once, by a recorded Decision, and never by an edit of the policy.
CREATE TABLE cohort_policies (
  policy_id oq_identifier NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  previous_revision integer GENERATED ALWAYS AS (CASE WHEN revision > 1 THEN revision - 1 END) STORED,
  suite_id oq_identifier NOT NULL,
  document_digest oq_digest NOT NULL REFERENCES artefacts (digest),
  registered_by oq_identifier NOT NULL REFERENCES principals (principal_id),
  registered_at timestamptz NOT NULL,
  PRIMARY KEY (policy_id, revision),
  CONSTRAINT cohort_policies_document_unique UNIQUE (document_digest),
  CONSTRAINT cohort_policies_previous FOREIGN KEY (policy_id, previous_revision)
    REFERENCES cohort_policies (policy_id, revision)
);
CREATE TRIGGER cohort_policies_immutable BEFORE UPDATE OR DELETE ON cohort_policies
  FOR EACH ROW EXECUTE FUNCTION oq_forbid_change();
