// An evaluation submission (OQ-05 sections 4 and 7, OQ-02 sections 3.6 and 8, decisions D5, D6 and D14). The worker has
// uploaded its input, result and metrics. The API commits one official result for the run, and only from the current
// owner of the live attempt, after every binding holds:
//
//   - the submission names this run, this attempt and ownership revision, this request, the engine and method that the
//     request requires and the executable that claimed the attempt;
//   - the evaluation-result/1 is scanned, never parsed whole (scanEvaluationResult, up to 8 MiB), and its schema
//     version, strategy hash, input hash, engine digest and outcome status and code equal the request and the submission;
//   - the input that the evaluate job built repeats the windows, cutoff, capital, execution policy and seed of the
//     request, the strategy of the request and the dataset and instrument of the mission's manifest (D14);
//   - the metrics derive from that result, that input and that method, for the window and cost case of the run.
//
// A REPLAY run (replay.ts) binds the same submission, result and identities. Its input is the frozen input that its
// request names, and its metrics follow the replay convention (REPLAY_METRICS); it has no mission, manifest or policy.
//
// The outcome then maps to run status (outcomes.ts). A redelivery of the same submission returns the stored outcome:
// the run has one official result (results.run_id is its primary key).

import type {
  BacktestRequest,
  EvaluationInput,
  EvaluationMetrics,
  EvaluationRequest,
  EvaluationSubmission,
} from '@openquant/api-contracts';
import { canonicalJson, digest, RESULT_SCAN_LIMIT, scanEvaluationResult } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import { ApiFailure } from '../errors.ts';
import { completeAttempt, failAttempt, type Guarded, type WorkContext } from './attempts.ts';
import { openAttention } from './attention.ts';
import { loadPolicy } from './documents.ts';
import { codeBelongsToStatus, mapOutcome } from './outcomes.ts';
import {
  claimedExecutable,
  contractFailure,
  dispatchOf,
  loadCited,
  requestRefOf,
  requireStoredRef,
  sameExecutable,
  storedBytes,
} from './refs.ts';
import { REPLAY_METRICS } from './replay.ts';
import { durationUsage, openAnyResult, repeatOutcome } from './results.ts';
import { storeDocument } from './store.ts';
import { requireRelease } from './validation.ts';

function mismatch(message: string): ApiFailure {
  return new ApiFailure('IDENTITY_MISMATCH', message);
}

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

export type EvaluationAccepted = 'COMPLETED' | 'FAILED' | 'REPEATED';

/** The bindings of the submission to its request. Throws IDENTITY_MISMATCH; nothing is written. */
function bindSubmission(
  submission: EvaluationSubmission,
  request: EvaluationRequest,
  requestDigest: string,
  environment: string,
  executable: { name: string; version: string; digest: string },
  attempt: { attempt_id: string; ownership_revision: number },
): void {
  if (submission.request_digest !== requestDigest)
    throw mismatch('The submission answers another request than the one of this attempt.');
  if (submission.mode !== request.mode) throw mismatch('The mode of the submission is not the mode of the request.');
  if (submission.environment !== request.environment || submission.environment !== environment) {
    throw mismatch('The environment of the submission is not the environment of the request.');
  }
  if (
    request.attempt.attempt_id !== attempt.attempt_id ||
    request.attempt.ownership_revision !== attempt.ownership_revision
  ) {
    throw mismatch('The request names another attempt or ownership revision than the one that submits.');
  }
  if (submission.engine_digest !== request.engine.engine_digest) {
    throw mismatch('The engine digest of the submission is not the one that the request requires.');
  }
  if (!same(submission.method, request.method)) {
    throw mismatch('The method identity of the submission is not the one that the request requires.');
  }
  if (!sameExecutable(submission.executable, executable)) {
    throw mismatch('The submission comes from another executable than the one that claimed this attempt.');
  }
}

function bindInput(input: EvaluationInput, request: BacktestRequest): void {
  const source = request.input;
  if (source.source !== 'PROVIDER_MANIFEST') throw mismatch('The request does not name a provider manifest.');
  if (input.strategy_hash !== request.strategy.artefact.digest)
    throw mismatch('The input is for another strategy than the one of the request.');
  if (input.operator_set !== request.engine.operator_set)
    throw mismatch('The input names another operator set than the request requires.');
  if (!same(input.windows, source.windows))
    throw mismatch('The windows or the information cutoff of the input are not those of the request.');
  if (!same(input.initial_capital, source.initial_capital))
    throw mismatch('The initial capital of the input is not the one of the request.');
  if (!same(input.policy, source.policy))
    throw mismatch('The execution policy of the input is not the one of the request.');
  if (input.seed !== source.seed) throw mismatch('The seed of the input is not the one of the request.');
  if (input.dataset.source !== 'PROVIDER') throw mismatch('The input does not name a provider dataset.');
}

function bindMetrics(
  metrics: EvaluationMetrics,
  expected: {
    runId: string;
    resultDigest: string;
    inputDigest: string;
    strategyHash: string;
    engineDigest: string;
    method: unknown;
    window: { role: string; costScenario: string; start: string; end: string };
    metricScale: number;
  },
): void {
  if (metrics.run_id !== expected.runId) throw mismatch('The metrics are for another run.');
  const { source } = metrics;
  if (
    source.result_digest !== expected.resultDigest ||
    source.input_hash !== expected.inputDigest ||
    source.strategy_hash !== expected.strategyHash ||
    source.engine_digest !== expected.engineDigest
  ) {
    throw mismatch('The metrics do not derive from the result, input, strategy and engine of this submission.');
  }
  if (!same(metrics.method, expected.method))
    throw mismatch('The metrics carry another method identity than the request requires.');
  const { window } = metrics;
  if (
    window.role !== expected.window.role ||
    window.cost_scenario !== expected.window.costScenario ||
    window.scored.start !== expected.window.start ||
    window.scored.end !== expected.window.end
  ) {
    throw mismatch('The window of the metrics is not the window and cost case of the run.');
  }
  if (metrics.metric_scale !== expected.metricScale)
    throw mismatch('The metric scale is not the one of the cohort policy.');
}

export async function acceptEvaluationSubmission(
  tx: Queryable,
  ctx: WorkContext,
  principalId: string,
  submission: EvaluationSubmission,
): Promise<Guarded<EvaluationAccepted>> {
  const gate = await openAnyResult(tx, ctx, submission.attempt.attempt_id, submission.attempt.ownership_revision);
  if (gate.kind === 'rejected') return { ok: false, failure: gate.failure };
  const { env } = ctx;
  const submissionDigest = await digest(submission);
  if (gate.kind === 'repeat') {
    const repeat = repeatOutcome(gate.located, submissionDigest);
    return repeat.ok ? { ok: true, value: 'REPEATED' } : { ok: false, failure: repeat.failure };
  }
  const { mission, work, attempt } = gate.located;
  if (work.kind !== 'run') throw mismatch('This attempt does not belong to an evaluation run.');
  if (submission.run_id !== work.id) throw mismatch('The submission is for another run than the one of this attempt.');
  const dispatch = await dispatchOf(tx, attempt.attempt_id);
  const requestRef = requestRefOf(dispatch.message);
  const request = await loadCited(tx, env, 'evaluation-request', requestRef, 'request');
  const executable = await claimedExecutable(tx, attempt.attempt_id);
  bindSubmission(submission, request, requestRef.digest, env.environment, executable, attempt);
  const release = await requireRelease(tx, env.environment);
  if (release.engine.engine_digest !== submission.engine_digest || !same(release.method, submission.method)) {
    throw mismatch('The submission carries an engine or method identity that is not the one of the recorded release.');
  }

  const evaluation = submission.evaluation;
  const status = evaluation.status;
  const code = 'code' in evaluation ? evaluation.code : undefined;
  if ((status === 'FAILED' || status === 'INSUFFICIENT') && !codeBelongsToStatus(status, code as string)) {
    throw mismatch(
      `The code ${code} does not belong to an outcome ${status}: the engine derives the status from the code.`,
    );
  }
  const mapping = mapOutcome(status, code);
  const usage = { BATCH_COMPUTE_SECONDS: durationUsage(submission.duration) };
  const inputRef = 'input' in evaluation ? evaluation.input : undefined;
  const resultRef = 'result' in evaluation ? evaluation.result : undefined;
  const metricsRef = 'metrics' in evaluation ? evaluation.metrics : undefined;

  // Every cited artefact is an uploaded one with the size that the submission states.
  if (inputRef !== undefined) await requireStoredRef(tx, inputRef, 'input');
  if (resultRef !== undefined) await requireStoredRef(tx, resultRef, 'result');
  if (metricsRef !== undefined) await requireStoredRef(tx, metricsRef, 'metrics');

  if (resultRef !== undefined && resultRef.size_bytes > RESULT_SCAN_LIMIT) {
    // The API commits no result above the scan limit; the run fails as a platform failure with an attention item
    // (OQ-05 section 4). This is committed: the caller is told LIMIT_EXCEEDED after the transaction.
    const stored = await storeDocument(tx, env, 'evaluation-submission', submission, principalId);
    const failed = await failAttempt(tx, ctx, {
      attemptId: attempt.attempt_id,
      ownershipRevision: attempt.ownership_revision,
      cause: { kind: 'WORKER_FAILURE', code: 'RESULT_TOO_LARGE', retryable: false },
      usage,
      resultDigest: stored.ref.digest,
      // The run ended for good: its attention item says why, and the platform, not the candidate, is at fault.
      detail: `The result is larger than the scan limit of ${RESULT_SCAN_LIMIT} bytes: no result is committed.`,
    });
    if (!failed.ok) return failed;
    return {
      ok: false,
      failure: new ApiFailure(
        'LIMIT_EXCEEDED',
        `The result is larger than the limit of ${RESULT_SCAN_LIMIT} bytes: the run failed.`,
        {
          stateChanged: 'UNKNOWN',
        },
      ),
    };
  }

  if (resultRef !== undefined) {
    const scanned = scanEvaluationResult(await storedBytes(env, resultRef.digest));
    if (!scanned.ok)
      throw scanned.error.kind === 'too-large'
        ? new ApiFailure('LIMIT_EXCEEDED', 'The result is larger than the scan limit.')
        : contractFailure(scanned.error);
    const head = scanned.value;
    if (head.strategy_hash !== request.strategy.artefact.digest)
      throw mismatch('The result is for another strategy than the one of the request.');
    if (inputRef !== undefined && head.input_hash !== inputRef.digest)
      throw mismatch('The result was computed from another input than the one the submission cites.');
    if (head.engine_digest !== submission.engine_digest)
      throw mismatch('The result was computed by another engine than the one the submission names.');
    if (head.outcome.status !== status)
      throw mismatch('The outcome status of the result is not the one the submission states.');
    if (head.outcome.code !== code)
      throw mismatch('The outcome code of the result is not the one the submission states.');
  }

  let metrics: EvaluationMetrics | undefined;
  if (request.mode === 'REPLAY') {
    // A replay evaluates the frozen input that its request names, and nothing else. Its metrics follow the replay
    // convention of the evaluate job (replay.ts, REPLAY_METRICS): no window role, cost case or policy exists for it.
    if (inputRef !== undefined && !same(inputRef, request.input.input))
      throw mismatch('The input of a replay is not the frozen input that its request names.');
    if (metricsRef !== undefined && resultRef !== undefined && inputRef !== undefined) {
      metrics = await loadCited(tx, env, 'evaluation-metrics', metricsRef, 'metrics');
      const input = await loadCited(tx, env, 'evaluation-input', inputRef, 'input');
      bindMetrics(metrics, {
        runId: work.id,
        resultDigest: resultRef.digest,
        inputDigest: inputRef.digest,
        strategyHash: request.strategy.artefact.digest,
        engineDigest: submission.engine_digest,
        method: request.method,
        window: {
          role: REPLAY_METRICS.windowRole,
          costScenario: REPLAY_METRICS.costScenario,
          start: input.windows.scored_start,
          end: input.windows.scored_end,
        },
        metricScale: REPLAY_METRICS.metricScale,
      });
    }
  } else {
    if (mission === undefined) throw mismatch('A backtest run belongs to a mission.');
    if (inputRef !== undefined) {
      const input = await loadCited(tx, env, 'evaluation-input', inputRef, 'input');
      bindInput(input, request);
      if (request.input.source !== 'PROVIDER_MANIFEST') throw mismatch('The request names no manifest.');
      const manifest = await loadCited(tx, env, 'dataset-manifest', request.input.manifest, 'manifest');
      if (
        !same(input.dataset, manifest.dataset) ||
        input.instruments[0]?.instrument_id !== manifest.instrument.instrument_id
      ) {
        throw mismatch('The input is not built from the dataset and instrument of the mission manifest.');
      }
    }
    if (metricsRef !== undefined && resultRef !== undefined && inputRef !== undefined) {
      metrics = await loadCited(tx, env, 'evaluation-metrics', metricsRef, 'metrics');
      if (request.input.source !== 'PROVIDER_MANIFEST') throw mismatch('The request names no windows.');
      const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
      if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
      bindMetrics(metrics, {
        runId: work.id,
        resultDigest: resultRef.digest,
        inputDigest: inputRef.digest,
        strategyHash: request.strategy.artefact.digest,
        engineDigest: submission.engine_digest,
        method: request.method,
        window: {
          role: work.windowRole as string,
          costScenario: work.costScenario as string,
          start: request.input.windows.scored_start,
          end: request.input.windows.scored_end,
        },
        metricScale: policy.document.metrics.metric_scale,
      });
    }
  }

  // Every binding holds: commit the one official result.
  const stored = await storeDocument(tx, env, 'evaluation-submission', submission, principalId);
  const done = await completeAttempt(tx, ctx, {
    attemptId: attempt.attempt_id,
    ownershipRevision: attempt.ownership_revision,
    workStatus: mapping.runStatus,
    ...(mapping.runStatus === 'FAILED' ? { failureCode: code ?? 'FAILED' } : {}),
    usage,
    resultDigest: stored.ref.digest,
  });
  if (!done.ok) return done;
  await tx.query(
    `INSERT INTO results (run_id, attempt_id, run_status, outcome, outcome_code, submission_digest, input_digest,
       result_digest, engine_digest, method_digest, executable_digest, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      work.id,
      attempt.attempt_id,
      mapping.runStatus,
      status,
      code ?? null,
      stored.ref.digest,
      inputRef?.digest ?? null,
      resultRef?.digest ?? null,
      submission.engine_digest,
      submission.method.digest,
      submission.executable.digest,
      env.clock(),
    ],
  );
  if (metricsRef !== undefined && metrics !== undefined) {
    await tx.query(
      `INSERT INTO metrics (run_id, metrics_digest, method_digest, metric_scale, recorded_at) VALUES ($1, $2, $3, $4, $5)`,
      [work.id, metricsRef.digest, submission.method.digest, metrics.metric_scale, env.clock()],
    );
  }
  if (mapping.attention) {
    await openAttention(
      tx,
      env,
      mission?.mission_id ?? null,
      `run ${work.id}`,
      `The run ${work.id} failed with ${code ?? 'no code'}: the defect is not the candidate's. Dependent gates are INSUFFICIENT.`,
    );
  }
  return { ok: true, value: mapping.runStatus };
}
