// The connected REPLAY of a frozen synthetic input, such as an S0 case (OQ-05 section 4, "Replay runs"; OQ-06 section 8,
// "pass the S0 definitions ... through the same Rust validation and evaluation path"). A replay checks the connected path
// against the offline harness. It is verification, not research:
//
//   - it belongs to no mission: it is not a trial, has no slot, window, plan or Strategy Version, takes no Decision and
//     is never read by an assessment, so it is never competition evidence (OQ-02 sections 3.4 and 3.6, A07);
//   - only an Administrator starts one (OQ-05 section 9: infrastructure, no trading authority). No service principal
//     can, and no other role;
//   - it reserves before it dispatches (OQ-05 section 4): start_replay writes the replay record, its own budget pool of
//     batch compute seconds (the attempt cap times the evaluate timeout, fixed here and not chosen by the caller), the
//     REPLAY run, its first attempt with its reservation, and its outbox entry, in one transaction. A retry reserves from
//     the same pool, so a replay never draws on a mission or period budget and cannot run past its own.
//
// S1 has no route for it: a route needs a new command/1 kind (OQ-05 section 7). The connected test and an operator with
// database access call startReplay with an Administrator actor.

import { type ContractName, canonicalJson, parseContract, workerBodyLimit } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import type { Queryable } from '../db/database.ts';
import { ApiFailure } from '../errors.ts';
import { openAttempt, type WorkContext } from './attempts.ts';
import { currentRelease } from './documents.ts';
import { contractFailure } from './refs.ts';
import { type Actor, hasRole } from './rows.ts';
import { storeBytes } from './store.ts';
import { findWork, type Work } from './work.ts';

/** The attempts of one replay run, as for a mission's runs. */
export const REPLAY_ATTEMPT_CAP = 3;
/** What one attempt reserves and its lease is built from: the evaluate timeout that apps/engine measured (P3). */
export const REPLAY_EVALUATE_SECONDS = 120;
/** The largest artefact that a replay attempt may upload: the cohort policy's artefact limit of the pilot. */
export const REPLAY_ARTEFACT_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * The metrics of a completed replay. A REPLAY request names no window role, cost case or cohort policy, so the evaluate
 * job states its metrics for the development window, the base case and the pilot's metric scale, over the scored window
 * of the frozen input (apps/engine/src/batch/jobs/evaluate.rs, REPLAY_WINDOW, REPLAY_SCENARIO, REPLAY_METRIC_SCALE).
 * The API binds the metrics to the same convention. They describe a replay, not a trial.
 */
export const REPLAY_METRICS = { windowRole: 'DEVELOPMENT', costScenario: 'BASE', metricScale: 6 } as const;

export interface ReplayCase {
  /** The shared fixture set and case the frozen input comes from (evaluation-request/1 ReplayConditions). */
  readonly fixtureSet: string;
  readonly caseId: string;
  /** The strategy-artefact/1 and evaluation-input/1 documents, as bytes. They are stored in canonical form. */
  readonly strategy: Uint8Array;
  readonly input: Uint8Array;
}

export interface StartedReplay {
  readonly replayId: string;
  readonly runId: string;
  readonly attemptId: string;
}

async function storeParsed(
  tx: Queryable,
  ctx: WorkContext,
  contract: ContractName,
  bytes: Uint8Array,
): Promise<{ digest: string; value: Record<string, unknown> }> {
  if (bytes.length > workerBodyLimit(contract)) {
    throw new ApiFailure('LIMIT_EXCEEDED', `The ${contract} document is larger than its limit.`);
  }
  // The schema only: a document that the schema accepts and the core refuses (an unsupported operator, an input of
  // another strategy) is the core's to report, as an explicit failure of the run (OQ-02 section 3.6).
  const parsed = parseContract(contract, bytes);
  if (!parsed.ok) throw contractFailure(parsed.error);
  const ref = await storeBytes(tx, ctx.env, new TextEncoder().encode(canonicalJson(parsed.value)), ctx.actorId);
  return { digest: ref.digest, value: parsed.value as unknown as Record<string, unknown> };
}

/** start_replay: an Administrator's replay of one frozen input, reserved and dispatched like any run. */
export async function startReplay(
  tx: Queryable,
  ctx: WorkContext,
  actor: Actor,
  replay: ReplayCase,
): Promise<StartedReplay> {
  const { env } = ctx;
  if (!hasRole(actor, 'Administrator')) {
    throw new ApiFailure('FORBIDDEN', 'Only an Administrator starts a replay.');
  }
  if (!env.researchExecution) {
    throw new ApiFailure('EXECUTION_DISABLED', 'Research execution is disabled in this environment.');
  }
  if ((await currentRelease(tx, env.environment)) === undefined) {
    throw new ApiFailure(
      'EXECUTION_DISABLED',
      `No release identity is recorded for ${env.environment}: a replay request needs the required engine and method.`,
    );
  }
  const strategy = await storeParsed(tx, ctx, 'strategy-artefact', replay.strategy);
  const input = await storeParsed(tx, ctx, 'evaluation-input', replay.input);
  const now = env.clock();
  const replayId = env.ids.next('rpl');
  const runId = env.ids.next('run');
  await tx.query(
    `INSERT INTO replays (replay_id, run_id, fixture_set, case_id, strategy_id, strategy_version, strategy_digest,
       input_digest, evaluate_seconds, requested_by, requested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      replayId,
      runId,
      replay.fixtureSet,
      replay.caseId,
      strategy.value.strategy_id,
      strategy.value.version,
      strategy.digest,
      input.digest,
      REPLAY_EVALUATE_SECONDS,
      actor.principalId,
      now,
    ],
  );
  await tx.query(
    `INSERT INTO budget_pools (scope, replay_id, dimension, limit_amount)
     VALUES ('REPLAY', $1, 'BATCH_COMPUTE_SECONDS', $2::numeric)`,
    [replayId, String(REPLAY_ATTEMPT_CAP * REPLAY_EVALUATE_SECONDS)],
  );
  await tx.query(
    `INSERT INTO runs (run_id, mode, replay_id, attempt_cap, created_at) VALUES ($1, 'REPLAY', $2, $3, $4)`,
    [runId, replayId, REPLAY_ATTEMPT_CAP, now],
  );
  const work = (await findWork(tx, 'run', runId, true)) as Work;
  const opened = await openAttempt(tx, { ...ctx, actorId: actor.principalId }, work);
  if (!opened.ok) throw new Error(`The first attempt of replay ${replayId} was not reserved: ${opened.reason}`);
  await writeAudit(tx, now, {
    eventType: 'replay.started',
    actor: actor.principalId,
    subject: replayId,
    detail: { run: runId, fixture_set: replay.fixtureSet, case_id: replay.caseId, attempt: opened.attemptId },
  });
  return { replayId, runId, attemptId: opened.attemptId };
}
