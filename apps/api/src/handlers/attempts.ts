// The attempt routes (OQ-05 sections 4, 5 and 7): the claim, the inputs and artefacts of an attempt, and the five result
// submissions. The route layer has already authenticated and authorised the caller (an attempt capability for the
// attempt in the path, which has not lost its lease), refused a body above its limit and parsed it as its contract.
// Every result route runs one transaction through a domain function that answers with the typed refusal as data, so a
// rejected late submission is recorded in the audit log in the same transaction and nothing else changes.

import type { AgentAttemptResult, AttemptClaimRequest } from '@openquant/api-contracts';
import { digestBytes, type Sha256Digest } from '@openquant/api-contracts';
import { acceptAgentResult, settleLateAgentReport } from '../domain/agents.ts';
import { acceptGateReport } from '../domain/assessment.ts';
import type { Guarded, WorkContext } from '../domain/attempts.ts';
import { allBuilders } from '../domain/builders.ts';
import { grantClaim } from '../domain/claim.ts';
import { loadPolicy } from '../domain/documents.ts';
import { acceptEvaluationSubmission } from '../domain/evaluation.ts';
import { dispatchOf, referencesIn, storedBytes } from '../domain/refs.ts';
import { REPLAY_ARTEFACT_LIMIT_BYTES } from '../domain/replay.ts';
import { auditRefusal } from '../domain/results.ts';
import { acceptRetrievalResult } from '../domain/retrieval.ts';
import { findMission } from '../domain/rows.ts';
import { acceptValidationResult } from '../domain/validation.ts';
import { workOfAttempt } from '../domain/work.ts';
import { ApiFailure } from '../errors.ts';
import { advanceAfterResult } from '../orchestrator.ts';
import { type Handler, json, type LateHandler } from './context.ts';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function workContext(env: Parameters<Handler>[0]['env'], actorId: string): WorkContext {
  return { env, actorId, builders: allBuilders };
}

function pathMismatch(pointer: string): ApiFailure {
  return new ApiFailure('SCHEMA_VIOLATION', 'The attempt of the body is not the attempt of the path.', {
    violations: [{ pointer, message: 'It must equal the attempt_id of the path.' }],
  });
}

// --- claim ---------------------------------------------------------------------------------------------------------

export const claimRoute: Handler = async ({ env, db, caller, params, body }) => {
  if (caller.kind !== 'service' || caller.principal.serviceKind === null || body.kind !== 'contract') {
    throw new ApiFailure('FORBIDDEN', 'Only a service principal claims an attempt.');
  }
  const request = body.value as AttemptClaimRequest;
  if (request.attempt.attempt_id !== params.attempt_id) throw pathMismatch('/attempt/attempt_id');
  const claimer = { principalId: caller.principal.id, serviceKind: caller.principal.serviceKind };
  const granted = await db.transaction((tx) => grantClaim(tx, workContext(env, claimer.principalId), claimer, request));
  if (!granted.ok) throw granted.failure;
  return json(200, granted.value);
};

// --- inputs and artefacts ------------------------------------------------------------------------------------------

/** An attempt that no longer holds its lease reads and writes nothing: the capability expires with the lease. */
function requireLiveCapability(caller: Parameters<Handler>[0]['caller']): void {
  if (caller.kind !== 'attempt') throw new ApiFailure('FORBIDDEN', 'An attempt capability is required.');
  if (caller.attempt.state !== 'live') {
    throw new ApiFailure('LEASE_EXPIRED', 'The lease of this attempt has ended: it reads and writes nothing.');
  }
}

/**
 * The artefacts that an attempt may read: the ones its dispatch message names, and the ones that the documents of that
 * message name in turn (the strategy, manifest and cohort policy of an evaluation request, the results and metrics of the submissions
 * that an assessment reads). Nothing else: a worker reads no artefact of another mission.
 */
export async function readableDigests(
  tx: Parameters<typeof dispatchOf>[0],
  env: Parameters<typeof storedBytes>[0],
  attemptId: string,
): Promise<Set<string>> {
  const { message } = await dispatchOf(tx, attemptId);
  const readable = new Set(referencesIn(message).map((ref) => ref.digest));
  const inputs = message.inputs as {
    kind?: string;
    request?: { digest: string };
    runs?: { submission?: { digest: string } }[];
    strategy_hash?: string;
  };
  const documents: string[] = [];
  if (inputs.kind === 'evaluate' && inputs.request !== undefined) documents.push(inputs.request.digest);
  if (inputs.kind === 'assess') {
    for (const run of inputs.runs ?? []) if (run.submission !== undefined) documents.push(run.submission.digest);
    // The assess job rebuilds each completed run from the candidate's strategy artefact, which its dispatch names by
    // hash only (apps/engine/src/batch/jobs/assess.rs). The connected test found it unreadable.
    if (inputs.strategy_hash !== undefined) readable.add(inputs.strategy_hash);
  }
  for (const digest of documents) {
    const parsed = JSON.parse(new TextDecoder().decode(await storedBytes(env, digest)));
    for (const ref of referencesIn(parsed)) readable.add(ref.digest);
    // The evaluate job of a backtest reads the cohort policy that its request names by record reference, for the
    // metric scale and the uncertainty limitation of its metrics (apps/engine/src/batch/jobs/evaluate.rs, metrics_facts).
    // The connected test found it unreadable.
    const policy = inputs.kind === 'evaluate' ? parsed?.conditions?.cohort_policy?.digest : undefined;
    if (typeof policy === 'string') readable.add(policy);
  }
  return readable;
}

export const inputRoute: Handler = async ({ env, db, caller, params }) => {
  requireLiveCapability(caller);
  const digest = params.digest ?? '';
  const attemptId = params.attempt_id ?? '';
  const readable = SHA256.test(digest) && (await readableDigests(db, env, attemptId)).has(digest);
  if (!readable) throw new ApiFailure('NOT_FOUND', 'This attempt has no such input.');
  const meta = await db.query<{ media_type: string }>('SELECT media_type FROM artefacts WHERE digest = $1', [digest]);
  const bytes = await storedBytes(env, digest);
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': meta.rows[0]?.media_type ?? 'application/octet-stream', 'x-content-digest': digest },
  });
};

function mediaTypeOf(header: string | null): string {
  const match = /^([a-z]+\/[a-z0-9.+-]+)\s*(;|$)/i.exec(header ?? '');
  return match?.[1] === undefined ? 'application/octet-stream' : match[1].toLowerCase();
}

export const artefactRoute: Handler = async ({ env, db, caller, params, body, request }) => {
  requireLiveCapability(caller);
  if (body.kind !== 'bytes' || caller.kind !== 'attempt') throw new Error('The artefact route has no bytes body.');
  const declared = params.digest ?? '';
  if (!SHA256.test(declared))
    throw new ApiFailure('DIGEST_MISMATCH', 'The digest in the path is not sha256: and 64 lower-case hex digits.');
  const actual = await digestBytes(body.bytes);
  if (actual !== declared)
    throw new ApiFailure('DIGEST_MISMATCH', 'The uploaded bytes do not hash to the digest of the path.');
  const unlocked = await workOfAttempt(db, caller.attempt.attemptId);
  if (unlocked === undefined) throw new ApiFailure('NOT_FOUND', 'The attempt does not exist.');
  // A replay run has no cohort policy: its artefacts are bounded by the replay limit (replay.ts).
  let limit = REPLAY_ARTEFACT_LIMIT_BYTES;
  if (unlocked.missionId !== null) {
    const mission = await findMission(db, unlocked.missionId);
    const policy =
      mission === undefined ? undefined : await loadPolicy(db, env, mission.policy_id, mission.policy_revision);
    if (policy === undefined) throw new Error(`The policy of work ${unlocked.id} is missing.`);
    limit = policy.document.limits.artefact_limit_bytes;
  }
  if (body.bytes.length > limit) {
    throw new ApiFailure(
      'LIMIT_EXCEEDED',
      `An artefact may hold at most ${limit} bytes under the ${unlocked.missionId === null ? 'replay limit' : 'cohort policy'}.`,
    );
  }
  // The Worker verified the hash above and verifies it again before it writes the content-addressed key (OQ-05 section 5).
  await env.objects.put(declared as Sha256Digest, body.bytes);
  await db.query(
    `INSERT INTO artefacts (digest, media_type, size_bytes, stored_at, uploaded_by, uploaded_by_attempt)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (digest) DO NOTHING`,
    [
      declared,
      mediaTypeOf(request.headers.get('content-type')),
      body.bytes.length,
      env.clock(),
      caller.principal.id,
      caller.attempt.attemptId,
    ],
  );
  return new Response(null, { status: 204 });
};

// --- results -------------------------------------------------------------------------------------------------------

type Accept<D> = (
  tx: Parameters<Parameters<Parameters<Handler>[0]['db']['transaction']>[0]>[0],
  ctx: WorkContext,
  principalId: string,
  document: D,
) => Promise<Guarded<unknown>>;

/**
 * A result route: one transaction through the domain function. A refusal that the function returns is a late
 * submission (already recorded in that transaction) or the oversize result that failed its run; a refusal that it
 * throws is a binding that does not hold, rolled back whole and recorded afterwards in the audit log.
 */
function resultRoute<D extends { attempt: { attempt_id: string } }>(accept: Accept<D>): Handler {
  return async ({ env, db, caller, params, body, route, diagnosticRef }) => {
    if (caller.kind !== 'attempt' || body.kind !== 'contract')
      throw new ApiFailure('FORBIDDEN', 'An attempt capability is required.');
    const document = body.value as unknown as D;
    if (document.attempt.attempt_id !== params.attempt_id) throw pathMismatch('/attempt/attempt_id');
    const principalId = caller.principal.id;
    let outcome: Guarded<unknown>;
    try {
      outcome = await db.transaction((tx) => accept(tx, workContext(env, principalId), principalId, document));
    } catch (error) {
      if (error instanceof ApiFailure)
        await auditRefusal(db, env, principalId, params.attempt_id ?? '', route.id, error, diagnosticRef);
      throw error;
    }
    if (!outcome.ok) throw outcome.failure;
    // The orchestrator takes the next step of the mission now that the result is committed (orchestrator.ts). It never
    // fails this request; the scheduled tick catches up with what it could not do.
    if (env.orchestrate === true) await advanceAfterResult(env, db, params.attempt_id ?? '');
    return new Response(null, { status: route.success_status });
  };
}

export const retrievalResultRoute: Handler = resultRoute(acceptRetrievalResult);
export const validationResultRoute: Handler = resultRoute(acceptValidationResult);
export const evaluationSubmissionRoute: Handler = resultRoute(acceptEvaluationSubmission);
export const gateReportRoute: Handler = resultRoute(acceptGateReport);
export const agentResultRoute: Handler = resultRoute(acceptAgentResult);

/**
 * A report from an agent attempt whose lease ended: the route layer answers LEASE_EXPIRED or STALE_OWNERSHIP, and the
 * usage that the report carries settles an UNRECONCILED reservation of that attempt (the run and the result do not
 * change). Batch results have no such path: for batch work UNRECONCILED stays final in S1.
 */
export const lateAgentResult: LateHandler = async (tx, { env, caller, params, body }) => {
  if (caller.kind !== 'attempt' || body.kind !== 'contract') return;
  const result = body.value as unknown as AgentAttemptResult;
  if (result.attempt.attempt_id !== params.attempt_id) return;
  await settleLateAgentReport(tx, workContext(env, caller.principal.id), result);
};
