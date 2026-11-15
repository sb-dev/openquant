-- 0008_commands: what the guarded commands of P2 part B need beyond the tables of 0001 to 0007.
-- OQ-02 sections 1 and 4; OQ-05 section 4. Nothing here is deployed yet, so the new seed column is NOT NULL: it would
-- fail on a table that already holds rows, which S1 has not produced.

-- A seed draft carries the strategy ID of its strategy-artefact/1. Version 1 of a strategy is registered once
-- (strategy_versions has UNIQUE (strategy_id, version)), so two stored drafts of one strategy ID would collide when the
-- mission's first validation job registers version 1. The unique constraint refuses the second draft at register_seed.
ALTER TABLE seed_drafts ADD COLUMN strategy_id oq_identifier NOT NULL;
ALTER TABLE seed_drafts ADD CONSTRAINT seed_drafts_strategy_unique UNIQUE (strategy_id);

-- A withdrawn mission keeps the reason that its Researcher gave in cancel_mission, beside who withdrew it and when.
-- Only a withdrawn mission has one; cancel_mission always writes it.
ALTER TABLE missions ADD COLUMN withdrawn_reason text CHECK (char_length(withdrawn_reason) BETWEEN 1 AND 1000);
ALTER TABLE missions ADD CONSTRAINT missions_withdrawn_reason_only_when_withdrawn CHECK (
  withdrawn_reason IS NULL OR status = 'WITHDRAWN'
);
