// The steps of the pilot above the first retrieval, through the real HTTP application: the validation of a draft, the
// critique, the Decision of the workflows principal, and the documents of an evaluation. A step builds its documents
// from the records of the mission and the release, and submits them as the host would. The test that calls a step
// states what it expects.

import {
  AGENT_RUNNER,
  bytesOf,
  type Claimed,
  claim,
  digestOfBytes,
  ENGINE_BATCH,
  type Flow,
  outboxOf,
  requestOf,
  type Started,
  type StartedWork,
  startAgent,
  startValidationOf,
  submit,
  upload,
  uploadDoc,
} from './flow.ts';
import { decide } from './pipeline.ts';
import { type Doc, fixture } from './world.ts';

type Ref = { digest: string; media_type: string; size_bytes: number };

export function validationResult(
  flow: Flow,
  claimed: Pick<Claimed, 'attemptId' | 'ownershipRevision'>,
  jobId: string,
  draftDigest: string,
  outcome: Doc = { status: 'VALID', max_lookback_sessions: 50, warmup_sessions: 60 },
  parentHash?: string,
): Doc {
  return {
    schema_version: 'validation-result/1',
    job_id: jobId,
    attempt: { attempt_id: claimed.attemptId, ownership_revision: claimed.ownershipRevision },
    executable: { ...ENGINE_BATCH },
    engine_digest: flow.release.engine.engine_digest,
    method: structuredClone(flow.release.method),
    draft_digest: draftDigest,
    ...(parentHash === undefined ? {} : { parent_hash: parentHash }),
    outcome,
    duration: { label: 'observed', milliseconds: 1840 },
  };
}

/** Validate a draft as the batch host does: start the job, claim it, submit a result. Returns the response. */
export async function driveValidation(
  flow: Flow & Started,
  input: { trialSlot: string; draftDigest: string; parentHash?: string; outcome?: Doc; edit?: (result: Doc) => void },
): Promise<{ work: StartedWork; claimed: Claimed; response: Response }> {
  const work = await startValidationOf(flow, input);
  const claimed = await claim(flow, work.attemptId);
  const result = validationResult(flow, claimed, work.jobId, input.draftDigest, input.outcome, input.parentHash);
  input.edit?.(result);
  return { work, claimed, response: await submit(flow, claimed, 'validation-result', result) };
}

export const CRITIQUE_FINDING: Doc = {
  category: 'method_advice',
  description: 'The strategy could state its holding period.',
  method_refs: [],
  evidence_refs: [],
  location: { area: 'rationale' },
  affected_elements: [],
};

export function agentResultDoc(
  claimed: Pick<Claimed, 'attemptId' | 'ownershipRevision'>,
  message: Doc,
  outcome: Doc,
  edit?: (result: Doc) => void,
): Doc {
  const result: Doc = {
    schema_version: 'agent-attempt-result/1',
    attempt: { attempt_id: claimed.attemptId, ownership_revision: claimed.ownershipRevision },
    provenance: {
      session_id: message.identity.session_id,
      input_hash: message.inputs.request.artefact.digest,
      bundle_hash: message.identity.bundle_hash,
      executor_version: { status: 'reported', value: '2.1.325' },
      provider: { status: 'unknown' },
      model: { status: 'reported', value: 'claude-opus-5-5' },
      effort: { status: 'unknown' },
      runner: { ...AGENT_RUNNER },
    },
    outcome,
    usage: {
      cost: { label: 'estimated', amount: '3.25', currency: 'USD' },
      duration: { label: 'observed', milliseconds: 240000 },
      input_tokens: { label: 'observed', count: 61204 },
      output_tokens: { label: 'observed', count: 7311 },
    },
    started_at: '2026-11-15T10:00:00Z',
    finished_at: '2026-11-15T10:04:00Z',
  };
  edit?.(result);
  return result;
}

/** A critic attempt that completes with these findings, as the runner reports it. */
export async function driveCritique(
  flow: Flow & Started,
  slot: string,
  findings: Doc[] = [CRITIQUE_FINDING],
): Promise<{ work: StartedWork; claimed: Claimed; output: Ref; response: Response }> {
  const work = await startAgent(flow, { slot, role: 'CRITIC' });
  const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
  const output = await upload(flow, claimed, bytesOf({ schema_version: 'strategy-critique.result/1', findings }));
  const { message } = await outboxOf(flow, work.attemptId);
  const result = agentResultDoc(claimed, message, {
    outcome: 'completion',
    output: { contract: 'strategy-critique.result/1', artefact: output },
  });
  return { work, claimed, output, response: await submit(flow, claimed, 'agent-result', result) };
}

/**
 * A proposer run that ends without a proposal: the runner reports a refusal, which is never retried, so the logical
 * run of the revision slot is FAILED and nothing is left in flight for it.
 */
export async function proposerEndsWithoutProposal(
  flow: Flow & Started,
  slot: string,
  configuration: string,
): Promise<StartedWork> {
  const work = await startAgent(flow, { slot, role: 'PROPOSER', configuration });
  const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
  const { message } = await outboxOf(flow, work.attemptId);
  const response = await submit(
    flow,
    claimed,
    'agent-result',
    agentResultDoc(claimed, message, { outcome: 'refusal', diagnostic: 'The model declined the task.' }),
  );
  if (response.status !== 204) throw new Error(`The refusal of ${slot} answered ${response.status}`);
  return work;
}

export async function runsOf(flow: Flow, slot: string) {
  const rows = await flow.world.sql<{ run_id: string; run_slot: string; attempt_id: string }>(
    `SELECT r.run_id, r.run_slot, a.attempt_id FROM runs r JOIN attempts a ON a.run_id = r.run_id AND a.status IN ('PENDING', 'CLAIMED')
      WHERE r.trial_slot = $1 ORDER BY r.run_slot`,
    [slot],
  );
  return rows.map((row) => ({ runId: row.run_id, runSlot: row.run_slot, attemptId: row.attempt_id }));
}

/**
 * The candidate of the seed slot approved to EVALUATING: its validation, its critique and the Decision of the workflows
 * principal. It writes the five development and validation runs, each PENDING.
 */
export async function toEvaluating(flow: Flow & Started, findings?: Doc[]) {
  const validation = await driveValidation(flow, { trialSlot: 'seed', draftDigest: flow.world.records.seedDigest });
  if (validation.response.status !== 204)
    throw new Error(`The seed validation answered ${validation.response.status}: ${await validation.response.text()}`);
  const critique = await driveCritique(flow, 'seed', findings);
  if (critique.response.status !== 204)
    throw new Error(`The critique answered ${critique.response.status}: ${await critique.response.text()}`);
  const [plan] = await flow.world.sql<{ plan_digest: string }>(
    'SELECT plan_digest FROM evaluation_plans WHERE mission_id = $1',
    [flow.missionId],
  );
  flow.world.records.planDigest = plan?.plan_digest as string;
  const decided = await decide(flow.world, 'seed', 'APPROVED', {
    status: 'COMPLETED',
    attempt_id: critique.work.attemptId,
    result: critique.output,
  });
  if (decided.state !== 'APPLIED') throw new Error(`The Decision was not applied: ${JSON.stringify(decided)}`);
  return { runs: await runsOf(flow, 'seed'), critique };
}

// --- evaluation documents ------------------------------------------------------------------------------------------

export interface EvaluationDocs {
  readonly input: Doc;
  readonly result: Doc;
  readonly metrics: Doc;
  readonly submission: Doc;
}

export interface EvaluationOptions {
  readonly status?: 'COMPLETED' | 'FAILED' | 'INSUFFICIENT' | 'NOT_PREPARED';
  readonly code?: string;
  readonly edit?: Partial<Record<keyof EvaluationDocs, (doc: Doc) => void>>;
}

/**
 * The documents that the evaluate job of a run uploads and submits, derived from the request that the API stored for the
 * attempt and from the release. The refs of the submission are filled by `submitEvaluation`, which uploads the rest.
 */
export async function evaluationDocs(
  flow: Flow,
  claimed: Pick<Claimed, 'attemptId' | 'ownershipRevision'>,
  runId: string,
  options: EvaluationOptions = {},
): Promise<{ docs: EvaluationDocs; request: { digest: string; document: Doc } }> {
  const request = await requestOf(flow, claimed.attemptId);
  const req = request.document;
  const manifestBytes = await flow.world.testApp.objects.get(req.input.manifest.digest as never);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes as Uint8Array)) as Doc;
  const status = options.status ?? 'COMPLETED';
  const input: Doc = {
    schema_version: 'evaluation-input/1',
    strategy_hash: req.strategy.artefact.digest,
    operator_set: req.engine.operator_set,
    seed: req.input.seed,
    dataset: manifest.dataset,
    instruments: [
      { instrument_id: manifest.instrument.instrument_id, bars: [], corporate_actions: [], unplanned_events: [] },
    ],
    calendar: { sessions: manifest.content.calendar.slice(0, 2) },
    windows: req.input.windows,
    initial_capital: req.input.initial_capital,
    policy: req.input.policy,
  };
  options.edit?.input?.(input);
  const inputBytes = bytesOf(input);
  const result: Doc = {
    ...fixture('evaluation-result.f0.json'),
    strategy_hash: req.strategy.artefact.digest,
    input_hash: digestOfBytes(inputBytes),
    engine_digest: flow.release.engine.engine_digest,
    outcome: status === 'COMPLETED' ? { status } : { status, code: options.code },
  };
  options.edit?.result?.(result);
  const resultBytes = bytesOf(result);
  const metrics: Doc = {
    ...fixture('evaluation-metrics.validation-base.json'),
    run_id: runId,
    source: {
      result_digest: digestOfBytes(resultBytes),
      input_hash: digestOfBytes(inputBytes),
      strategy_hash: req.strategy.artefact.digest,
      engine_digest: flow.release.engine.engine_digest,
    },
    method: structuredClone(flow.release.method),
    window: {
      role: req.conditions.window_role,
      cost_scenario: req.conditions.cost_scenario,
      scored: { start: req.input.windows.scored_start, end: req.input.windows.scored_end },
    },
  };
  options.edit?.metrics?.(metrics);
  const submission: Doc = {
    schema_version: 'evaluation-submission/1',
    run_id: runId,
    attempt: { attempt_id: claimed.attemptId, ownership_revision: claimed.ownershipRevision },
    request_digest: request.digest,
    mode: 'BACKTEST',
    environment: flow.world.testApp.env.environment,
    executable: { ...ENGINE_BATCH },
    engine_digest: flow.release.engine.engine_digest,
    method: structuredClone(flow.release.method),
    evaluation: { status },
    duration: { label: 'observed', milliseconds: 41000 },
  };
  return { docs: { input, result, metrics, submission }, request };
}

/** Upload the documents of an evaluation and submit it. The edit of the submission runs after its refs are set. */
export async function submitEvaluation(
  flow: Flow,
  claimed: Claimed,
  runId: string,
  options: EvaluationOptions = {},
): Promise<{ response: Response; docs: EvaluationDocs; refs: Record<string, Ref> }> {
  const { docs } = await evaluationDocs(flow, claimed, runId, options);
  const status = options.status ?? 'COMPLETED';
  const refs: Record<string, Ref> = {};
  if (status !== 'NOT_PREPARED') {
    refs.input = await uploadDoc(flow, claimed, docs.input);
    refs.result = await uploadDoc(flow, claimed, docs.result);
    if (status === 'COMPLETED') refs.metrics = await uploadDoc(flow, claimed, docs.metrics);
  }
  docs.submission.evaluation =
    status === 'COMPLETED'
      ? { status, input: refs.input, result: refs.result, metrics: refs.metrics }
      : status === 'NOT_PREPARED'
        ? {
            status,
            code: options.code ?? 'IDENTITY_MISMATCH',
            detail: 'The fetched manifest bytes do not match the manifest digest in the request.',
          }
        : { status, code: options.code, input: refs.input, result: refs.result };
  options.edit?.submission?.(docs.submission);
  return { response: await submit(flow, claimed, 'evaluation-submission', docs.submission), docs, refs };
}
