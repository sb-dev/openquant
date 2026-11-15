// Budgets (OQ-03 section 1, OQ-05 section 4, decisions D22 and D26).
//
// A pool is one limit that reservations draw on. `committed` counts what is reserved or spent and can never exceed the
// limit (a CHECK in the database repeats it), so two overlapping callers cannot overspend. Every attempt reserves its
// declared cap before it is dispatched, from the pool of its own configuration (model spend) or of the mission, in the
// transaction that writes the attempt. A reservation is settled by the usage that the attempt reports:
//
//   - settlement never returns more than the reservation: reported usage is never negative, and what the attempt
//     consumed (the smaller of usage and reservation) stays committed;
//   - usage above the reservation is an overrun, recorded on the pool. An overrun blocks further reservations of the
//     mission, and the mission becomes BLOCKED; in S1 only cancel_mission ends that;
//   - usage that nothing reported is unknown, never zero. The full reservation stays committed and the reservation is
//     UNRECONCILED until a later report settles it.
//
// Amounts are exact decimals (decimal.ts) and the arithmetic of the pools is SQL numeric(24, 8). Spend that has more
// than eight fractional digits is rounded up, never down.

import type { Queryable } from '../db/database.ts';
import { ApiFailure } from '../errors.ts';
import { addDecimal, ceilToScale, compareDecimal, fitsMoney, MONEY_SCALE, subtractDecimal } from './decimal.ts';
import { assertTransition } from './transitions.ts';

export type Dimension = 'MODEL_SPEND' | 'PROVIDER_REQUESTS' | 'BATCH_COMPUTE_SECONDS' | 'AGENT_COMPUTE_SECONDS';

/** One reservation line asked for: an amount from the pool of a dimension, of a configuration for model spend. */
export interface Need {
  readonly dimension: Dimension;
  /** Only for MODEL_SPEND: the allowance of one agent configuration. Absent: the pool of the mission. */
  readonly configurationId?: string;
  readonly amount: string;
}

/** An agent attempt also counts against the number of agent attempts that the configuration's allowance grants. */
export interface AgentAllowanceCheck {
  readonly configurationId: string;
  readonly role: 'PROPOSER' | 'CRITIC';
}

export interface PlannedLine {
  readonly poolId: number;
  readonly dimension: Dimension;
  readonly configurationId: string | null;
  readonly amount: string;
}

export type ReservationPlan =
  | { readonly ok: true; readonly lines: readonly PlannedLine[] }
  | { readonly ok: false; readonly reason: string };

/** What an attempt reports about one dimension. A dimension it does not mention is unknown. */
export type UsageValue =
  | { readonly label: 'observed' | 'estimated'; readonly amount: string }
  | { readonly label: 'unknown' };
export type UsageReport = Partial<Record<Dimension, UsageValue>>;

export interface SettleOutcome {
  readonly status: 'SETTLED' | 'UNRECONCILED' | 'UNCHANGED';
  /** The pools that went over: usage above the reservation. */
  readonly overruns: readonly {
    readonly dimension: Dimension;
    readonly configurationId: string | null;
    readonly amount: string;
  }[];
}

/** The amount as the ledger holds it (rounded up to eight fractional digits), or the refusal of an amount it cannot hold. */
function roundedUsage(amount: string): string {
  try {
    const rounded = ceilToScale(amount, MONEY_SCALE);
    if (fitsMoney(rounded)) return rounded;
  } catch {
    // Not a plain decimal: refused below.
  }
  throw new ApiFailure('SCHEMA_VIOLATION', 'A reported usage amount is outside the range of the ledger.');
}

interface PoolRow {
  pool_id: number;
  dimension: Dimension;
  configuration_id: string | null;
  limit_amount: string;
  committed: string;
  overrun: string;
}

function describe(dimension: Dimension, configurationId: string | null | undefined): string {
  return configurationId === undefined || configurationId === null
    ? `${dimension} of the mission`
    : `${dimension} of the allowance of ${configurationId}`;
}

export interface MissionPoolSpec {
  readonly proposerConfigurations: readonly string[];
  readonly criticConfiguration: string;
  readonly proposerSpend: string;
  readonly criticSpend: string;
  readonly providerRequests: string;
  readonly batchComputeSeconds: string;
  readonly agentComputeSeconds: string;
}

/** The pools of a new mission: one model-spend allowance per configuration, and the mission's own counters. */
export async function createMissionPools(tx: Queryable, missionId: string, spec: MissionPoolSpec): Promise<void> {
  const insert = `INSERT INTO budget_pools (scope, mission_id, configuration_id, dimension, limit_amount)
                  VALUES ('MISSION', $1, $2, $3, $4::numeric)`;
  for (const configurationId of spec.proposerConfigurations) {
    await tx.query(insert, [missionId, configurationId, 'MODEL_SPEND', spec.proposerSpend]);
  }
  await tx.query(insert, [missionId, spec.criticConfiguration, 'MODEL_SPEND', spec.criticSpend]);
  await tx.query(insert, [missionId, null, 'PROVIDER_REQUESTS', spec.providerRequests]);
  await tx.query(insert, [missionId, null, 'BATCH_COMPUTE_SECONDS', spec.batchComputeSeconds]);
  await tx.query(insert, [missionId, null, 'AGENT_COMPUTE_SECONDS', spec.agentComputeSeconds]);
}

/** True when any pool of the mission recorded usage above a reservation. */
export async function hasOverrun(tx: Queryable, missionId: string): Promise<boolean> {
  const { rows } = await tx.query(`SELECT 1 FROM budget_pools WHERE mission_id = $1 AND overrun > 0 LIMIT 1`, [
    missionId,
  ]);
  return rows.length > 0;
}

/**
 * Decide whether a set of reservation lines fits, with the pools locked in id order so that two callers cannot both
 * take the last of a pool. It writes nothing. The caller writes the attempt and calls commitReservation in the same
 * transaction, while the locks hold.
 */
export async function planReservation(
  tx: Queryable,
  missionId: string,
  needs: readonly Need[],
  allowance?: AgentAllowanceCheck,
): Promise<ReservationPlan> {
  if (await hasOverrun(tx, missionId)) {
    return { ok: false, reason: 'A budget overrun of this mission blocks further reservations.' };
  }
  const resolved: { need: Need; poolId: number }[] = [];
  for (const need of needs) {
    const { rows } = await tx.query<{ pool_id: number }>(
      `SELECT pool_id::int AS pool_id FROM budget_pools
        WHERE scope = 'MISSION' AND mission_id = $1 AND dimension = $2 AND configuration_id IS NOT DISTINCT FROM $3`,
      [missionId, need.dimension, need.configurationId ?? null],
    );
    const row = rows[0];
    if (row === undefined) {
      return { ok: false, reason: `The mission has no pool for ${describe(need.dimension, need.configurationId)}.` };
    }
    resolved.push({ need, poolId: row.pool_id });
  }
  const ids = [...new Set(resolved.map((entry) => entry.poolId))].sort((a, b) => a - b);
  const { rows: pools } = await tx.query<PoolRow>(
    `SELECT pool_id::int AS pool_id, dimension, configuration_id, limit_amount::text AS limit_amount,
            committed::text AS committed, overrun::text AS overrun
       FROM budget_pools WHERE pool_id = ANY($1::int[]) ORDER BY pool_id FOR UPDATE`,
    [ids],
  );
  const byId = new Map(pools.map((pool) => [pool.pool_id, pool]));
  // The same pool can appear twice in one plan; its lines are added up before the comparison.
  const asked = new Map<number, string>();
  for (const { need, poolId } of resolved) {
    const total = asked.get(poolId);
    asked.set(poolId, total === undefined ? need.amount : addDecimal(total, need.amount));
  }
  for (const [poolId, amount] of asked) {
    const pool = byId.get(poolId) as PoolRow;
    const available = subtractDecimal(pool.limit_amount, pool.committed);
    if (compareDecimal(amount, available) > 0) {
      return {
        ok: false,
        reason: `${describe(pool.dimension, pool.configuration_id)} cannot cover ${amount}: ${available} is left.`,
      };
    }
  }
  if (allowance !== undefined) {
    const used = await tx.query<{ attempts: string; allowed: number }>(
      `SELECT (SELECT count(*) FROM attempts a JOIN jobs j ON j.job_id = a.job_id
                WHERE j.mission_id = $1 AND j.configuration_id = $2) AS attempts,
              CASE WHEN $3 = 'CRITIC' THEN critic_attempts ELSE proposer_attempts END AS allowed
         FROM mission_budgets WHERE mission_id = $1`,
      [missionId, allowance.configurationId, allowance.role],
    );
    const row = used.rows[0];
    if (row !== undefined && Number(row.attempts) >= row.allowed) {
      return {
        ok: false,
        reason: `The allowance of ${allowance.configurationId} grants ${row.allowed} agent attempts and all were started.`,
      };
    }
  }
  return {
    ok: true,
    lines: resolved.map(({ need, poolId }) => ({
      poolId,
      dimension: need.dimension,
      configurationId: need.configurationId ?? null,
      amount: need.amount,
    })),
  };
}

/** Write the reservation of an attempt that planReservation accepted: the reservation, its lines and the pools. */
export async function commitReservation(
  tx: Queryable,
  attemptId: string,
  lines: readonly PlannedLine[],
  now: Date,
): Promise<void> {
  await tx.query('INSERT INTO reservations (attempt_id, reserved_at) VALUES ($1, $2)', [attemptId, now]);
  for (const line of lines) {
    await tx.query('UPDATE budget_pools SET committed = committed + $2::numeric WHERE pool_id = $1', [
      line.poolId,
      line.amount,
    ]);
    await tx.query('INSERT INTO reservation_lines (attempt_id, pool_id, reserved) VALUES ($1, $2, $3::numeric)', [
      attemptId,
      line.poolId,
      line.amount,
    ]);
    await ledger(tx, attemptId, line.poolId, 'RESERVE', line.amount, null, now);
  }
}

type LedgerKind = 'RESERVE' | 'SETTLE' | 'UNRECONCILE' | 'RELEASE' | 'OVERRUN' | 'RECONCILE';

async function ledger(
  tx: Queryable,
  attemptId: string,
  poolId: number,
  kind: LedgerKind,
  amount: string,
  label: string | null,
  now: Date,
): Promise<void> {
  await tx.query(
    `INSERT INTO usage_ledger (attempt_id, pool_id, entry_kind, amount, usage_label, recorded_at)
     VALUES ($1, $2, $3, $4::numeric, $5, $6)`,
    [attemptId, poolId, kind, amount, label, now],
  );
}

interface LineRow {
  pool_id: number;
  reserved: string;
  used: string | null;
  usage_label: string | null;
  dimension: Dimension;
  configuration_id: string | null;
}

async function lockedLines(tx: Queryable, attemptId: string): Promise<LineRow[]> {
  const { rows } = await tx.query<LineRow>(
    `SELECT rl.pool_id::int AS pool_id, rl.reserved::text AS reserved, rl.used::text AS used, rl.usage_label,
            bp.dimension, bp.configuration_id
       FROM reservation_lines rl JOIN budget_pools bp ON bp.pool_id = rl.pool_id
      WHERE rl.attempt_id = $1 ORDER BY rl.pool_id FOR UPDATE OF bp`,
    [attemptId],
  );
  return rows;
}

async function reservationStatus(tx: Queryable, attemptId: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ status: string }>(
    'SELECT status FROM reservations WHERE attempt_id = $1 FOR UPDATE',
    [attemptId],
  );
  return rows[0]?.status;
}

/**
 * Settle the reservation of an attempt that has ended, from what it reported. Reconciles an UNRECONCILED reservation
 * when it is called again with a report. A reservation that is already SETTLED or RELEASED is left as it is.
 */
export async function settleReservation(
  tx: Queryable,
  attemptId: string,
  usage: UsageReport,
  now: Date,
): Promise<SettleOutcome> {
  const status = await reservationStatus(tx, attemptId);
  if (status === undefined) throw new Error(`The attempt ${attemptId} has no reservation.`);
  if (status === 'SETTLED' || status === 'RELEASED') return { status: 'UNCHANGED', overruns: [] };
  const reconciling = status === 'UNRECONCILED';
  const overruns: { dimension: Dimension; configurationId: string | null; amount: string }[] = [];
  let unknown = false;
  for (const line of await lockedLines(tx, attemptId)) {
    if (line.used !== null) continue;
    const reported = usage[line.dimension];
    if (reported === undefined || reported.label === 'unknown') {
      unknown = true;
      if (line.usage_label !== 'unknown') {
        // The full reservation counts as spent until a report arrives (OQ-03 section 1).
        await tx.query(`UPDATE reservation_lines SET usage_label = 'unknown' WHERE attempt_id = $1 AND pool_id = $2`, [
          attemptId,
          line.pool_id,
        ]);
        await ledger(tx, attemptId, line.pool_id, 'UNRECONCILE', line.reserved, 'unknown', now);
      }
      continue;
    }
    // A report that the ledger cannot hold is refused, not clamped: the pools would then hide spend. An amount with
    // more than eight fractional digits is held, rounded up.
    const used = roundedUsage(reported.amount);
    const consumed = compareDecimal(used, line.reserved) > 0 ? line.reserved : used;
    const returned = subtractDecimal(line.reserved, consumed);
    const over = subtractDecimal(used, consumed);
    await tx.query(
      `UPDATE budget_pools SET committed = committed - $2::numeric, overrun = overrun + $3::numeric WHERE pool_id = $1`,
      [line.pool_id, returned, over],
    );
    await tx.query(
      `UPDATE reservation_lines SET used = $3::numeric, usage_label = $4 WHERE attempt_id = $1 AND pool_id = $2`,
      [attemptId, line.pool_id, used, reported.label],
    );
    await ledger(tx, attemptId, line.pool_id, reconciling ? 'RECONCILE' : 'SETTLE', consumed, reported.label, now);
    if (compareDecimal(returned, '0') > 0) {
      await ledger(tx, attemptId, line.pool_id, 'RELEASE', returned, reported.label, now);
    }
    if (compareDecimal(over, '0') > 0) {
      await ledger(tx, attemptId, line.pool_id, 'OVERRUN', over, reported.label, now);
      overruns.push({ dimension: line.dimension, configurationId: line.configuration_id, amount: over });
    }
  }
  if (unknown) {
    if (!reconciling) {
      assertTransition('reservation', 'RESERVED', 'UNRECONCILED');
      await tx.query(`UPDATE reservations SET status = 'UNRECONCILED' WHERE attempt_id = $1`, [attemptId]);
    }
    return { status: 'UNRECONCILED', overruns };
  }
  assertTransition('reservation', status, 'SETTLED');
  await tx.query(`UPDATE reservations SET status = 'SETTLED', settled_at = $2 WHERE attempt_id = $1`, [attemptId, now]);
  return { status: 'SETTLED', overruns };
}

/** Release a reservation in full: nothing was consumed, as for an attempt that was cancelled before its claim. */
export async function releaseReservation(tx: Queryable, attemptId: string, now: Date): Promise<boolean> {
  const status = await reservationStatus(tx, attemptId);
  if (status === undefined) throw new Error(`The attempt ${attemptId} has no reservation.`);
  if (status !== 'RESERVED') return false;
  assertTransition('reservation', 'RESERVED', 'RELEASED');
  for (const line of await lockedLines(tx, attemptId)) {
    await tx.query('UPDATE budget_pools SET committed = committed - $2::numeric WHERE pool_id = $1', [
      line.pool_id,
      line.reserved,
    ]);
    await ledger(tx, attemptId, line.pool_id, 'RELEASE', line.reserved, null, now);
  }
  await tx.query(`UPDATE reservations SET status = 'RELEASED', released_at = $2 WHERE attempt_id = $1`, [
    attemptId,
    now,
  ]);
  return true;
}
