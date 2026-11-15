// The GET routes of the mission, the run and the job (OQ-04 sections 4 and 5, OQ-05 sections 7 and 8). Any person with a
// role reads them. A view says what is unknown and repeats none of the official run values; runs.metrics and runs.result
// serve the committed documents unchanged by content hash (OQ-05 section 7), and the Viewer never recomputes them.
//
// Revealing the result of a holdout run is consumption (OQ-02 section 3.3, A05): the first read of the metrics or result
// of a HOLDOUT run, and the first read of a gate report that shows holdout observations, write one record per run.

import type { Queryable } from '../db/database.ts';
import { recordHoldoutConsumption } from '../domain/findings.ts';
import { storedBytes } from '../domain/refs.ts';
import type { ApiEnv } from '../env.ts';
import { ApiFailure } from '../errors.ts';
import {
  decisionsView,
  findingsView,
  gatesView,
  jobView,
  lineageView,
  missionPlan,
  missionView,
  runDocument,
  trialsView,
} from '../read-models.ts';
import { type Handler, json } from './context.ts';

const id = (params: Readonly<Record<string, string>>, name: string): string => params[name] ?? '';

export const showMission: Handler = async ({ db, params, route }) =>
  json(route.success_status, await missionView(db, id(params, 'mission_id')));
export const showPlan: Handler = async ({ env, db, params, route }) =>
  json(route.success_status, await missionPlan(db, env, id(params, 'mission_id')));
export const showLineage: Handler = async ({ db, params, route }) =>
  json(route.success_status, await lineageView(db, id(params, 'mission_id')));
export const showTrials: Handler = async ({ env, db, params, route }) =>
  json(route.success_status, await trialsView(db, env, id(params, 'mission_id')));
export const showFindings: Handler = async ({ db, params, route }) =>
  json(route.success_status, await findingsView(db, id(params, 'mission_id')));
export const showDecisions: Handler = async ({ db, params, route }) =>
  json(route.success_status, await decisionsView(db, id(params, 'mission_id')));
export const showJob: Handler = async ({ db, params, route }) =>
  json(route.success_status, await jobView(db, id(params, 'job_id')));

async function consume(
  db: { transaction: <T>(work: (tx: Queryable) => Promise<T>) => Promise<T> },
  env: Pick<ApiEnv, 'clock'>,
  runs: readonly string[],
  reader: string,
): Promise<void> {
  if (runs.length === 0) return;
  await db.transaction(async (tx) => {
    for (const run of runs) await recordHoldoutConsumption(tx, env, run, reader);
  });
}

export const showGates: Handler = async ({ env, db, caller, params, route }) => {
  const read = await gatesView(db, env, id(params, 'mission_id'));
  // The view carries the observed values of holdout runs: showing them is the reveal.
  await consume(db, env, read.revealedHoldoutRuns, caller.principal.id);
  return json(route.success_status, read.view);
};

function committed(which: 'metrics' | 'result'): Handler {
  return async ({ env, db, caller, params }) => {
    const run = await runDocument(db, id(params, 'run_id'), which);
    let bytes: Uint8Array;
    try {
      bytes = await storedBytes(env, run.digest);
    } catch {
      throw new ApiFailure('UNAVAILABLE', 'The committed document cannot be read from storage now.', {
        retrySafe: true,
      });
    }
    if (run.holdout) await consume(db, env, [id(params, 'run_id')], caller.principal.id);
    // The committed bytes, unchanged: the digest of the body is the digest of the document.
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-digest': run.digest },
    });
  };
}

export const runMetrics: Handler = committed('metrics');
export const runResult: Handler = committed('result');
