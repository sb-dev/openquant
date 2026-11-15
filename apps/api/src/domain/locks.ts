// Locks for records that do not exist yet. A row lock cannot serialise two writers that both create revision N of a
// record, so a command that creates a new revision of a profile, a policy or a budget takes a transaction-scoped
// advisory lock on the record's key first. The loser then reads the winner's revision and is refused with
// REVISION_CONFLICT instead of failing on a unique violation.

import type { Queryable } from '../db/database.ts';

/** Held until the end of the transaction. */
export async function lockKey(tx: Queryable, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`openquant:${key}`]);
}

/** The highest revision of a versioned record, or 0 when it does not exist. */
export async function latestRevision(
  tx: Queryable,
  table: 'research_profiles' | 'cohort_policies' | 'budget_caps',
  column: 'profile_id' | 'policy_id' | 'budget_id',
  id: string,
): Promise<number> {
  const { rows } = await tx.query<{ latest: number }>(
    `SELECT COALESCE(MAX(revision), 0)::int AS latest FROM ${table} WHERE ${column} = $1`,
    [id],
  );
  return rows[0]?.latest ?? 0;
}
