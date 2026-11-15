// An agent attempt result (OQ-03 sections 3 to 5, OQ-05 section 4, decisions D6 and D22). The runner records what it
// observed: provenance, one of the seven outcomes and usage with explicit unknowns. The API checks that the provenance
// is that of the dispatch, reads the role output again before it writes anything, settles the reservation from the
// reported usage (an estimated cost stays an estimate, a missing report keeps the full reservation) and gives the
// logical run its status. A completion is COMPLETED. A timeout and a malformed result are retried within the attempt
// cap; a refusal, a denied capability, an authentication failure and a cancellation are not (retry.ts).
//
// A critic's findings are recorded as the critic returned them, labelled model_judgement: the registered policy, not the
// model, assigns their treatment (OQ-02 section 3.6). A report for an attempt that cancel_mission cancelled while it
// was claimed confirms that the runner stopped: the reservation is settled from its usage (OQ-05 section 4).

import type { AgentAttemptResult } from '@openquant/api-contracts';
import { digest } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import type { Queryable } from '../db/database.ts';
import { ApiFailure } from '../errors.ts';
import {
  completeAttempt,
  confirmTermination,
  failAttempt,
  type Guarded,
  locate,
  type WorkContext,
} from './attempts.ts';
import type { UsageReport } from './budget.ts';
import { readCritique, readFormulation } from './critique.ts';
import { loadPolicy } from './documents.ts';
import { claimedExecutable, dispatchOf, requireStoredRef, sameExecutable, storedBytes } from './refs.ts';
import { costUsage, durationUsage, openResult, repeatOutcome } from './results.ts';
import type { AgentFailureOutcome } from './retry.ts';
import { loadMissionBudget } from './rows.ts';
import { storeDocument } from './store.ts';

function mismatch(message: string): ApiFailure {
  return new ApiFailure('IDENTITY_MISMATCH', message);
}

interface AgentDispatchMessage {
  identity: { session_id: string; bundle_hash: string; role: string };
  inputs: { request: { artefact: { digest: string } } };
}

export type AgentAccepted = 'COMPLETED' | 'RETRIED' | 'FAILED' | 'WAITING' | 'REPEATED' | 'TERMINATION_CONFIRMED';

function usageOf(result: AgentAttemptResult, currency: string): UsageReport {
  return {
    MODEL_SPEND: costUsage(result.usage.cost, currency),
    AGENT_COMPUTE_SECONDS: durationUsage(result.usage.duration),
  };
}

export async function acceptAgentResult(
  tx: Queryable,
  ctx: WorkContext,
  principalId: string,
  result: AgentAttemptResult,
): Promise<Guarded<AgentAccepted>> {
  const { env } = ctx;
  const attemptId = result.attempt.attempt_id;
  const found = await locate(tx, attemptId);
  if (found !== undefined && found.attempt.status === 'CANCELLED' && found.attempt.claimed_at !== null) {
    // cancel_mission cancelled this claimed attempt and kept its reservation until the runner's termination is known.
    if (found.attempt.ownership_revision !== result.attempt.ownership_revision) {
      return {
        ok: false,
        failure: new ApiFailure('STALE_OWNERSHIP', 'The ownership revision is not the one of this attempt.'),
      };
    }
    const budget = await loadMissionBudget(tx, found.mission.mission_id);
    const confirmed = await confirmTermination(tx, ctx, attemptId, usageOf(result, budget.currency));
    await writeAudit(tx, env.clock(), {
      eventType: 'attempt.cancelled_report',
      actor: principalId,
      subject: attemptId,
      detail: { outcome: result.outcome.outcome, reservation: confirmed.status },
    });
    return { ok: true, value: 'TERMINATION_CONFIRMED' };
  }

  const gate = await openResult(tx, ctx, attemptId, result.attempt.ownership_revision);
  if (gate.kind === 'rejected') return { ok: false, failure: gate.failure };
  const submissionDigest = await digest(result);
  if (gate.kind === 'repeat') {
    const repeat = repeatOutcome(gate.located, submissionDigest);
    return repeat.ok ? { ok: true, value: 'REPEATED' } : { ok: false, failure: repeat.failure };
  }
  const { mission, work, attempt } = gate.located;
  if (work.kind !== 'job' || work.dispatchKind !== 'agent' || work.agentRole === null) {
    throw mismatch('This attempt does not belong to an agent run.');
  }
  const dispatch = await dispatchOf(tx, attemptId);
  const message = dispatch.message as unknown as AgentDispatchMessage;
  const { provenance, outcome } = result;
  if (
    provenance.input_hash !== message.inputs.request.artefact.digest ||
    provenance.bundle_hash !== message.identity.bundle_hash ||
    provenance.session_id !== message.identity.session_id
  ) {
    throw mismatch('The provenance names another request, bundle or session than the dispatch of this attempt.');
  }
  const executable = await claimedExecutable(tx, attemptId);
  if (!sameExecutable(provenance.runner, executable)) {
    throw mismatch('The result comes from another runner than the one that claimed this attempt.');
  }
  const budget = await loadMissionBudget(tx, mission.mission_id);
  const usage = usageOf(result, budget.currency);

  if (outcome.outcome !== 'completion') {
    const stored = await storeDocument(tx, env, 'agent-attempt-result', result, principalId);
    const failed = await failAttempt(tx, ctx, {
      attemptId,
      ownershipRevision: attempt.ownership_revision,
      cause: { kind: 'AGENT_OUTCOME', outcome: outcome.outcome as AgentFailureOutcome },
      usage,
      resultDigest: stored.ref.digest,
    });
    if (!failed.ok) return failed;
    await tx.query(
      `INSERT INTO agent_results (attempt_id, job_id, role, outcome, reason, result_digest, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        attemptId,
        work.id,
        work.agentRole,
        outcome.outcome,
        'reason' in outcome ? outcome.reason : null,
        stored.ref.digest,
        env.clock(),
      ],
    );
    return { ok: true, value: failed.value.outcome };
  }

  // A completion: the role output must be the output of this role, recorded, within its limit and readable.
  const role = work.agentRole;
  const expectedContract = role === 'CRITIC' ? 'strategy-critique.result/1' : 'strategy-formulation.result/1';
  const output = outcome.output;
  if (output.contract !== expectedContract)
    throw mismatch(`A ${role} attempt returns ${expectedContract}, not ${output.contract}.`);
  await requireStoredRef(tx, output.artefact, 'role output');
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  const limit = role === 'CRITIC' ? policy.document.limits.agent_output_limit_bytes : 512 * 1024;
  if (output.artefact.size_bytes > Math.min(limit, 512 * 1024)) {
    throw new ApiFailure('LIMIT_EXCEEDED', 'The role output is larger than the output limit of the cohort policy.');
  }
  const bytes = await storedBytes(env, output.artefact.digest);
  const critique = role === 'CRITIC' ? readCritique(bytes) : undefined;
  const reading = critique ?? readFormulation(bytes);
  if (!reading.ok) {
    throw new ApiFailure(
      'SCHEMA_VIOLATION',
      `The role output does not satisfy ${expectedContract}: ${reading.reason}.`,
    );
  }
  let strategyHash: string | null = null;
  if (role === 'CRITIC') {
    const registered = await tx.query<{ strategy_hash: string }>(
      `SELECT strategy_hash FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND status = 'REGISTERED'`,
      [mission.mission_id, work.trialSlot],
    );
    strategyHash = registered.rows[0]?.strategy_hash ?? null;
    if (strategyHash === null)
      throw mismatch('The critique is for a trial slot that has no registered Strategy Version.');
  }

  const stored = await storeDocument(tx, env, 'agent-attempt-result', result, principalId);
  const done = await completeAttempt(tx, ctx, {
    attemptId,
    ownershipRevision: attempt.ownership_revision,
    workStatus: 'COMPLETED',
    usage,
    resultDigest: stored.ref.digest,
  });
  if (!done.ok) return done;
  await tx.query(
    `INSERT INTO agent_results (attempt_id, job_id, role, outcome, result_digest, output_contract, output_digest, recorded_at)
     VALUES ($1, $2, $3, 'completion', $4, $5, $6, $7)`,
    [attemptId, work.id, role, stored.ref.digest, output.contract, output.artefact.digest, env.clock()],
  );
  if (critique?.ok === true && strategyHash !== null) {
    for (const [position, finding] of critique.findings.entries()) {
      await tx.query(
        `INSERT INTO findings (finding_id, mission_id, strategy_hash, attempt_id, critique_digest, ordinal, category,
           finding_source, affects_executable_rule, required_evidence, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'model_judgement', $8, false, $9)`,
        [
          env.ids.next('find'),
          mission.mission_id,
          strategyHash,
          attemptId,
          output.artefact.digest,
          position + 1,
          finding.category,
          finding.affectedElements.length > 0,
          env.clock(),
        ],
      );
    }
  }
  return { ok: true, value: 'COMPLETED' };
}
