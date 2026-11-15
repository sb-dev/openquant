// Attention items (OQ-02 section 3.6): a failure that an operator must see and that is not a verdict on a candidate. The
// specifications name the concept and give no status values; OPEN, ACKNOWLEDGED and RESOLVED are an assumption (README).

import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';

/** Open an item for a failure of the platform, or of the work that a mission depends on. Returns the item identifier. */
export async function openAttention(
  tx: Queryable,
  env: Pick<ApiEnv, 'ids' | 'clock'>,
  missionId: string | null,
  subject: string,
  reason: string,
): Promise<string> {
  const itemId = env.ids.next('item');
  await tx.query(
    `INSERT INTO attention_items (item_id, mission_id, subject, reason, opened_at) VALUES ($1, $2, $3, $4, $5)`,
    [itemId, missionId, subject.slice(0, 200), reason.slice(0, 1000), env.clock()],
  );
  return itemId;
}

/** Whether an item with this subject is still OPEN or ACKNOWLEDGED. */
export async function attentionOpen(tx: Queryable, subject: string): Promise<boolean> {
  const { rows } = await tx.query(`SELECT 1 FROM attention_items WHERE subject = $1 AND status <> 'RESOLVED' LIMIT 1`, [
    subject,
  ]);
  return rows.length > 0;
}

/** Resolve every item with this subject that is not resolved yet: what it reported has ended. */
export async function resolveAttention(tx: Queryable, env: Pick<ApiEnv, 'clock'>, subject: string): Promise<void> {
  await tx.query(
    `UPDATE attention_items SET status = 'RESOLVED', resolved_at = $2 WHERE subject = $1 AND status <> 'RESOLVED'`,
    [subject, env.clock()],
  );
}
