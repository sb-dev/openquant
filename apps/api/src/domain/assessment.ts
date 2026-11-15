// A gate report (OQ-02 sections 3.2 and 3.6, OQ-05 section 4, decisions D4, D18 and D24). The Rust assess job read the
// official results of one candidate and the registered cohort policy and wrote one outcome for every gate. The API
// only checks that the report is the report of that policy and those inputs, applies finding treatment and combines
// the results into eligibility for EVALUATING to PAPER. No EVALUATING to PAPER Decision is written in S1. Once every
// candidate in EVALUATING has its report and nothing is open, the mission concludes with its one outcome.

import type { CohortPolicy, GateReport } from '@openquant/api-contracts';
import { canonicalJson, digest } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import type { Queryable } from '../db/database.ts';
import { ApiFailure } from '../errors.ts';
import { completeAttempt, type Guarded, type WorkContext } from './attempts.ts';
import { loadPolicy } from './documents.ts';
import { assignFindingTreatments, blockingFindings } from './findings.ts';
import { transitionMission } from './missions.ts';
import { claimedExecutable, dispatchOf, sameExecutable } from './refs.ts';
import { durationUsage, openResult, repeatOutcome } from './results.ts';
import { findMission, type MissionRow } from './rows.ts';
import { storeDocument } from './store.ts';
import { requireRelease } from './validation.ts';

function mismatch(message: string): ApiFailure {
  return new ApiFailure('IDENTITY_MISMATCH', message);
}

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

interface AssessInputs {
  strategy_hash: string;
  plan: { digest: string };
  trial_slot: string;
  cohort_policy: { digest: string };
  validation: { digest: string };
  runs: { run_id: string; window_role: string; cost_scenario: string; submission?: { digest: string } }[];
  manifests: { digest: string }[];
}

/** The gates of the report are the gates of the policy, once each, with the outcome kind that the policy allows. */
export function checkGatesAgainstPolicy(report: GateReport, policy: CohortPolicy): void {
  const reported = new Map<string, GateReport['gates'][number]>();
  for (const gate of report.gates) {
    if (reported.has(gate.gate)) throw mismatch(`The report lists the gate ${gate.gate} twice.`);
    reported.set(gate.gate, gate);
  }
  if (reported.size !== policy.gates.length)
    throw mismatch('The report does not list every gate of the cohort policy, each once.');
  for (const required of policy.gates) {
    const gate = reported.get(required.gate);
    if (gate === undefined) throw mismatch(`The report has no outcome for the gate ${required.gate}.`);
    if (gate.category !== required.category)
      throw mismatch(`The category of ${required.gate} is not the one of the policy.`);
    if (required.requirement === 'REQUIRED') {
      if (gate.result === 'NOT_APPLICABLE')
        throw mismatch(`The gate ${required.gate} is required: it cannot be NOT_APPLICABLE.`);
      const limitation = 'limitation' in required ? required.limitation : undefined;
      if (gate.limitation !== limitation) {
        throw mismatch(`The approved limitation of ${required.gate} is not repeated exactly as the policy states it.`);
      }
      continue;
    }
    const expected = required.requirement === 'RECORDED_INSUFFICIENT' ? 'INSUFFICIENT' : 'NOT_APPLICABLE';
    if (gate.result !== expected || !('reason_code' in gate) || gate.reason_code !== 'POLICY_RECORDED') {
      throw mismatch(`The gate ${required.gate} is ${expected} by the policy, with the reason code POLICY_RECORDED.`);
    }
    if (gate.reason !== required.reason)
      throw mismatch(`The reason of ${required.gate} is not the reason that the policy records.`);
  }
}

export type GateReportAccepted = 'ACCEPTED' | 'REPEATED';

export async function acceptGateReport(
  tx: Queryable,
  ctx: WorkContext,
  principalId: string,
  report: GateReport,
): Promise<Guarded<GateReportAccepted>> {
  const gate = await openResult(tx, ctx, report.attempt.attempt_id, report.attempt.ownership_revision);
  if (gate.kind === 'rejected') return { ok: false, failure: gate.failure };
  const { env } = ctx;
  const reportDigest = await digest(report);
  if (gate.kind === 'repeat') {
    const repeat = repeatOutcome(gate.located, reportDigest);
    return repeat.ok ? { ok: true, value: 'REPEATED' } : { ok: false, failure: repeat.failure };
  }
  const { mission, work, attempt } = gate.located;
  if (work.kind !== 'job' || work.dispatchKind !== 'assess')
    throw mismatch('This attempt does not belong to an assess job.');
  if (report.job_id !== work.id) throw mismatch('The report is for another job than the one of this attempt.');
  const dispatch = await dispatchOf(tx, attempt.attempt_id);
  const inputs = (dispatch.message as { inputs: AssessInputs }).inputs;
  if (report.strategy_hash !== inputs.strategy_hash)
    throw mismatch('The report is for another candidate than the one that the job assesses.');
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  if (
    report.cohort_policy.id !== policy.id ||
    report.cohort_policy.revision !== policy.revision ||
    report.cohort_policy.digest !== policy.digest ||
    inputs.cohort_policy.digest !== policy.digest
  ) {
    throw mismatch('The report was written under another cohort policy than the one of the mission.');
  }
  const release = await requireRelease(tx, env.environment);
  if (!same(report.method, release.method))
    throw mismatch('The report carries another method identity than the recorded release.');
  const executable = await claimedExecutable(tx, attempt.attempt_id);
  if (!sameExecutable(report.executable, executable))
    throw mismatch('The report comes from another executable than the one that claimed this attempt.');

  // Every artefact that the assessment read is one that the job was given, or one that the job's runs committed.
  const runIds = inputs.runs.map((run) => run.run_id);
  const committed = await tx.query<{ run_id: string; result_digest: string | null; metrics_digest: string | null }>(
    `SELECT r.run_id, r.result_digest, m.metrics_digest FROM results r LEFT JOIN metrics m ON m.run_id = r.run_id
      WHERE r.run_id = ANY($1::text[])`,
    [runIds],
  );
  const allowed: Record<string, (input: { run_id?: string | undefined; digest: string }) => boolean> = {
    EVALUATION_PLAN: (input) => input.digest === inputs.plan.digest,
    VALIDATION_RESULT: (input) => input.digest === inputs.validation.digest,
    DATASET_MANIFEST: (input) => inputs.manifests.some((manifest) => manifest.digest === input.digest),
    EVALUATION_SUBMISSION: (input) =>
      inputs.runs.some((run) => run.run_id === input.run_id && run.submission?.digest === input.digest),
    EVALUATION_RESULT: (input) =>
      committed.rows.some((row) => row.run_id === input.run_id && row.result_digest === input.digest),
    EVALUATION_METRICS: (input) =>
      committed.rows.some((row) => row.run_id === input.run_id && row.metrics_digest === input.digest),
  };
  for (const input of report.inputs) {
    if (!allowed[input.kind]?.(input))
      throw mismatch(`The assessment cites an artefact (${input.kind}) that this job was not given.`);
  }
  for (const gateOutcome of report.gates) {
    for (const observation of 'observations' in gateOutcome ? (gateOutcome.observations ?? []) : []) {
      const run = inputs.runs.find((candidate) => candidate.run_id === observation.run_id);
      if (
        run === undefined ||
        run.window_role !== observation.window ||
        run.cost_scenario !== observation.cost_scenario
      ) {
        throw mismatch('An observation names a run, window or cost case that is not one of the runs of this job.');
      }
    }
  }
  // The evidence behind a decided gate is among the artefacts that the report says it read.
  const read = new Set(report.inputs.map((input) => input.digest));
  for (const outcome of report.gates) {
    for (const evidence of 'evidence' in outcome ? (outcome.evidence ?? []) : []) {
      if (!read.has(evidence))
        throw mismatch(`The evidence of ${outcome.gate} is not among the inputs that the report read.`);
    }
  }
  checkGatesAgainstPolicy(report, policy.document);

  const stored = await storeDocument(tx, env, 'gate-report', report, principalId);
  const done = await completeAttempt(tx, ctx, {
    attemptId: attempt.attempt_id,
    ownershipRevision: attempt.ownership_revision,
    workStatus: 'COMPLETED',
    usage: { BATCH_COMPUTE_SECONDS: durationUsage(report.duration) },
    resultDigest: stored.ref.digest,
  });
  if (!done.ok) return done;
  const now = env.clock();
  await tx.query(
    `INSERT INTO gate_reports (report_digest, mission_id, job_id, attempt_id, strategy_hash, plan_digest, policy_id,
       policy_revision, method_digest, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      stored.ref.digest,
      mission.mission_id,
      work.id,
      attempt.attempt_id,
      report.strategy_hash,
      inputs.plan.digest,
      policy.id,
      policy.revision,
      report.method.digest,
      now,
    ],
  );
  for (const outcome of report.gates) {
    await tx.query(
      `INSERT INTO gate_results (report_digest, gate_id, category, result, reason_code) VALUES ($1, $2, $3, $4, $5)`,
      [
        stored.ref.digest,
        outcome.gate,
        outcome.category,
        outcome.result,
        'reason_code' in outcome ? outcome.reason_code : null,
      ],
    );
  }
  await assignFindingTreatments(tx, env, mission.mission_id, report.strategy_hash, policy);
  const blocking = await blockingFindings(tx, mission.mission_id, report.strategy_hash, 'EVALUATING_TO_PAPER');
  const reasons: string[] = [];
  for (const outcome of report.gates) {
    if (outcome.result !== 'PASS' && outcome.result !== 'NOT_APPLICABLE')
      reasons.push(`${outcome.gate} is ${outcome.result}`);
  }
  for (const findingId of blocking) reasons.push(`the finding ${findingId} blocks EVALUATING to PAPER`);
  await tx.query(
    `INSERT INTO eligibility (mission_id, strategy_hash, report_digest, state, reasons, recorded_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      mission.mission_id,
      report.strategy_hash,
      stored.ref.digest,
      reasons.length === 0 ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
      JSON.stringify(reasons),
      now,
    ],
  );
  await writeAudit(tx, now, {
    eventType: 'eligibility.recorded',
    actor: principalId,
    subject: mission.mission_id,
    detail: { strategy_hash: report.strategy_hash, eligible: reasons.length === 0, reasons: reasons.length },
  });
  await concludeIfComplete(tx, ctx, mission.mission_id);
  return { ok: true, value: 'ACCEPTED' };
}

/**
 * The mission ends when every candidate in EVALUATING has its gate report and nothing of the mission is open: the
 * outcome is ELIGIBLE_FOUND when one candidate is eligible, otherwise NO_ELIGIBLE_CANDIDATE (a valid research result,
 * with the reason of every slot). A mission that is not IN_PROGRESS is left as it is.
 */
export async function concludeIfComplete(
  tx: Queryable,
  ctx: WorkContext,
  missionId: string,
): Promise<MissionRow | undefined> {
  const mission = (await findMission(tx, missionId)) as MissionRow;
  if (mission.status !== 'IN_PROGRESS') return undefined;
  const open = await tx.query(
    `SELECT 1 FROM runs WHERE mission_id = $1 AND status IN ('QUEUED', 'RUNNING')
     UNION ALL SELECT 1 FROM jobs WHERE mission_id = $1 AND status IN ('QUEUED', 'RUNNING')`,
    [missionId],
  );
  if (open.rows.length > 0) return undefined;
  const pending = await tx.query(
    `SELECT 1 FROM strategy_versions v WHERE v.mission_id = $1 AND v.lifecycle = 'EVALUATING'
        AND NOT EXISTS (SELECT 1 FROM eligibility e WHERE e.mission_id = v.mission_id AND e.strategy_hash = v.strategy_hash)`,
    [missionId],
  );
  if (pending.rows.length > 0) return undefined;
  const slots = await tx.query<{
    trial_slot: string;
    terminal_reason: string | null;
    strategy_hash: string | null;
    state: string | null;
  }>(
    `SELECT s.trial_slot, s.terminal_reason, t.strategy_hash, e.state
       FROM trial_slots s
       LEFT JOIN trials t ON t.mission_id = s.mission_id AND t.trial_slot = s.trial_slot AND t.status = 'REGISTERED'
       LEFT JOIN eligibility e ON e.mission_id = s.mission_id AND e.strategy_hash = t.strategy_hash
      WHERE s.mission_id = $1 ORDER BY s.trial_slot`,
    [missionId],
  );
  if (!slots.rows.some((slot) => slot.state !== null)) return undefined;
  const slotReasons = slots.rows.map((slot) => ({
    trial_slot: slot.trial_slot,
    reason: slot.state ?? slot.terminal_reason ?? 'NOT_EVALUATED',
  }));
  const eligible = slots.rows.some((slot) => slot.state === 'ELIGIBLE');
  const outcome = eligible ? 'ELIGIBLE_FOUND' : 'NO_ELIGIBLE_CANDIDATE';
  const reason = eligible
    ? 'At least one candidate is eligible for EVALUATING to PAPER.'
    : `No candidate is eligible (${slotReasons.map((entry) => `${entry.trial_slot}: ${entry.reason}`).join('; ')}).`;
  const concluded = await transitionMission(tx, ctx.env, mission, 'CONCLUDED', {
    outcome,
    outcomeReason: reason.slice(0, 2000),
  });
  await tx.query(
    `INSERT INTO mission_outcomes (mission_id, outcome, slot_reasons, recorded_at) VALUES ($1, $2, $3::jsonb, $4)`,
    [missionId, outcome, JSON.stringify(slotReasons), ctx.env.clock()],
  );
  await writeAudit(tx, ctx.env.clock(), {
    eventType: 'mission.concluded',
    actor: ctx.actorId,
    subject: missionId,
    detail: { outcome, revision: concluded.revision },
  });
  return concluded;
}
