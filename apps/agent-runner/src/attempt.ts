// One claimed agent attempt, from the checks before the executor to the posted result (OQ-03 sections 3 to 6,
// OQ-05 section 4).
//
// The attempt is already claimed when it gets here. In order: execution enabled, the installed bundle, the pinned
// executor version, the request artefact (its digest, then the request checks of assembly in `@openquant/agents`:
// schema, canonical text, supplied methods, holdout exclusions that name V and H, operators of the frozen policy,
// evidence and hashes; then the dispatch checks that the envelope cannot make), the executor, the shared validator on
// its output (structure, references and exact rule changes; the blockers of a proposal stay notices, see below), the
// upload of the validated role output, and the result.
//
// A proposal with an operator outside the permitted set or a date inside a withheld window is still a completion. Skill
// code does not repeat the Rust core's operator validation (OQ-03 section 3): the draft is stored, the Rust core
// returns INVALID, and its diagnostics go to the next proposer attempt (OQ-02 section 4). The runner logs the blockers
// as notices; agent-attempt-result/1 has no field for them, so the API computes them again from the stored output.
//
// What is left for fencing and retry: a runner failure is not an execution outcome (OQ-03 section 5). When the
// runner cannot read the request, cannot upload, loses its lease, or hits an internal error, it posts nothing and the
// lease expiry makes the control plane fence a new attempt. A late completion is rejected by the API and recorded
// there; the runner does not retry a rejection.

import {
  checkDispatch,
  type DispatchViolation,
  parseCritiqueResult,
  parseFormulationResult,
  RESULT_SCHEMAS,
  ROLE_BODY_LIMIT,
  type StrategyCritiqueRequest,
  type StrategyFormulationRequest,
  skillEntry,
  verifyRequest,
} from '@openquant/agents';
import {
  type AgentAttemptResult,
  type AgentDispatch,
  type AgentOutcome,
  type AttemptClaimGrant,
  canonicalJson,
  validateContract,
} from '@openquant/api-contracts';
import { type ApiClient, type ApiFailure, isTransient } from './api-client.ts';
import { instructionsFor, verifyBundle } from './bundle.ts';
import type { RunnerConfig } from './config.ts';
import type { DeniedReason, ExecutionEnd, ExecutionFacts, ExecutionRequest } from './executor.ts';
import { buildResult, outcomeOf } from './result.ts';
import { diagnostic, sha256Bytes } from './text.ts';

export type Logger = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export interface AttemptDeps {
  readonly config: RunnerConfig;
  readonly api: ApiClient;
  readonly execute: (request: ExecutionRequest) => Promise<ExecutionEnd>;
  readonly now: () => number;
  readonly log: Logger;
  /** Waits before a retry of a transient API failure. Tests replace it. */
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export type AttemptEnd =
  | { readonly posted: true; readonly outcome: AgentOutcome['outcome']; readonly reason?: string }
  | {
      readonly posted: false;
      readonly why: 'lease_lost' | 'api_unavailable' | 'internal_error' | 'shutdown';
      readonly detail: string;
    };

/** How often a transient API failure is retried, and the wait before each retry. */
const RETRIES = [250, 1000, 4000];

const NO_FACTS: ExecutionFacts = {
  executorVersion: undefined,
  sessionId: undefined,
  model: undefined,
  provider: undefined,
  effort: undefined,
  costUsd: undefined,
  inputTokens: undefined,
  outputTokens: undefined,
  durationMs: undefined,
  started: false,
};

const MEDIA_TYPE = 'application/json';

/** The longest delay that a Node timer keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** The reason of the denied capability for each violation that the dispatch checks find. */
const DENIAL_OF: Readonly<Record<DispatchViolation['code'], DeniedReason>> = {
  SKILL_NOT_REGISTERED: 'CAPABILITY_UNSUPPORTED',
  ROLE_SKILL_MISMATCH: 'CAPABILITY_DENIED',
  REQUEST_CONTRACT_MISMATCH: 'CAPABILITY_DENIED',
  REQUEST_ARTEFACT_MISMATCH: 'CAPABILITY_DENIED',
  HOLDOUT_EXCLUSIONS_MISMATCH: 'CAPABILITY_DENIED',
  HOLDOUT_EXCLUSIONS_INVALID: 'CAPABILITY_DENIED',
  BUNDLE_HASH_MISMATCH: 'BUNDLE_MISMATCH',
  CAPABILITIES_MISMATCH: 'CAPABILITY_UNSUPPORTED',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNSUPPORTED',
  PROFILE_NOT_REGISTERED: 'CAPABILITY_UNSUPPORTED',
  OUTPUT_LIMIT_TOO_HIGH: 'CAPABILITY_DENIED',
  TOOLS_NOT_PERMITTED: 'CAPABILITY_DENIED',
  RESULT_ROUTE_MISMATCH: 'CAPABILITY_DENIED',
};

type RequestContractName = 'strategy-formulation.request' | 'strategy-critique.request';

export async function runAttempt(
  dispatch: AgentDispatch,
  grant: AttemptClaimGrant,
  deps: AttemptDeps,
  signal: AbortSignal,
): Promise<AttemptEnd> {
  const { config, api, log } = deps;
  const attemptId = dispatch.identity.attempt.attempt_id;
  const capability = grant.capability.token;
  const startedAtMs = deps.now();
  const secrets = [capability, config.dispatchToken, config.api.credential];
  const say = (text: string) => diagnostic(text, secrets);

  // Post one outcome. The result is checked with the shared validator first: the runner never sends an envelope
  // that the API would have to reject as malformed.
  const finish = async (outcome: AgentOutcome, facts: ExecutionFacts): Promise<AttemptEnd> => {
    const result: AgentAttemptResult = buildResult({
      dispatch,
      runner: config.identity,
      outcome,
      facts,
      startedAtMs,
      finishedAtMs: deps.now(),
    });
    const checked = validateContract('agent-attempt-result', result);
    if (!checked.ok) {
      log('result_invalid', { attempt: attemptId, detail: checked.error.message.slice(0, 200) });
      return { posted: false, why: 'internal_error', detail: 'the runner built an invalid attempt result' };
    }
    const posted = await withRetries(deps, () => api.postAgentResult(attemptId, result, capability));
    const reason = 'reason' in outcome ? outcome.reason : undefined;
    if (posted.ok) {
      log('result_posted', { attempt: attemptId, outcome: outcome.outcome, ...(reason ? { reason } : {}) });
      return { posted: true, outcome: outcome.outcome, ...(reason ? { reason } : {}) };
    }
    return lost(posted, 'the attempt result was not accepted');
  };

  const lost = (failure: ApiFailure, what: string): AttemptEnd => {
    log('api_refused', { attempt: attemptId, status: failure.status, code: failure.code });
    if (failure.code === 'LEASE_EXPIRED' || failure.code === 'STALE_OWNERSHIP') {
      // A late completion: the API rejects it and records the rejection, and nothing else changes.
      return { posted: false, why: 'lease_lost', detail: `${what}: ${failure.code}` };
    }
    return {
      posted: false,
      why: isTransient(failure) ? 'api_unavailable' : 'internal_error',
      detail: `${what}: ${failure.code}`,
    };
  };

  const deny = (reason: DeniedReason, text: string, facts: ExecutionFacts = NO_FACTS) =>
    finish({ outcome: 'denied_capability', reason, diagnostic: say(text) }, facts);

  try {
    // 1. Execution must be enabled.
    if (!config.enabled) return await deny('EXECUTION_DISABLED', 'execution is disabled in this runner');

    // 2. The installed bundle is the bundle of the dispatch.
    const bundle = verifyBundle(config.bundleDir);
    if (!bundle.ok) {
      return await deny(
        'BUNDLE_MISMATCH',
        `the installed bundle differs from its manifest: ${bundle.problems.slice(0, 3).join('; ')}`,
      );
    }
    if (dispatch.identity.bundle_hash !== bundle.hash) {
      return await deny(
        'BUNDLE_MISMATCH',
        `the dispatch names the bundle ${dispatch.identity.bundle_hash}, and the installed bundle is ${bundle.hash}`,
      );
    }

    // 3. The pinned executor and the cost currency.
    const { executor, bounds } = dispatch.execution;
    if (executor.version !== config.executor.version) {
      return await deny(
        'CAPABILITY_UNSUPPORTED',
        `the dispatch names the executor version ${executor.version}, and this runner is pinned to ${config.executor.version}`,
      );
    }
    if (bounds.cost_reservation.currency !== 'USD') {
      return await deny(
        'CAPABILITY_UNSUPPORTED',
        'the executor reports cost in USD; the cost reservation is in another currency',
      );
    }

    // 4. The request: its bytes, its digest, its schema and the checks that the envelope cannot make.
    const named = dispatch.inputs.request.artefact;
    const fetched = await withRetries(deps, () => api.fetchInput(attemptId, named.digest, capability, ROLE_BODY_LIMIT));
    if (!fetched.ok) {
      if (fetched.code === 'NOT_FOUND')
        return await deny('CAPABILITY_DENIED', 'the request artefact is not stored for this attempt');
      if (fetched.code === 'TOO_LARGE')
        return await deny('CAPABILITY_DENIED', 'the request artefact is larger than a role request may be');
      return lost(fetched, 'the request artefact could not be read');
    }
    const bytes = fetched.value;
    const actualDigest = sha256Bytes(bytes);
    if (bytes.byteLength !== named.size_bytes || actualDigest !== named.digest) {
      return await deny(
        'CAPABILITY_DENIED',
        'the stored request is not the request that the dispatch names (digest or size differs)',
      );
    }
    const contract = requestContractOf(dispatch);
    if (contract === undefined)
      return await deny('CAPABILITY_UNSUPPORTED', 'the dispatch names a request contract that no role module serves');
    // The request is verified the way assembly would have built it: this host does not trust that an earlier step
    // assembled the artefact that the API stored.
    const verified = await verifyRequest(contract, bytes);
    if (!verified.ok) {
      const [refusal] = verified.refusals;
      const more = verified.refusals.length > 1 ? ` (and ${verified.refusals.length - 1} more)` : '';
      return await deny(
        'CAPABILITY_DENIED',
        `the stored request is not a request that assembly builds: ${refusal?.code}: ${refusal?.detail}${more}`,
      );
    }
    const request: StrategyFormulationRequest | StrategyCritiqueRequest = verified.request;
    const violations = checkDispatch(dispatch, {
      request,
      artefact: { digest: actualDigest, media_type: MEDIA_TYPE, size_bytes: bytes.byteLength },
    });
    const first = violations[0];
    if (first) {
      const more = violations.length > 1 ? ` (and ${violations.length - 1} more)` : '';
      return await deny(
        DENIAL_OF[first.code],
        `the dispatch checks refused the attempt: ${first.code}: ${first.detail}${more}`,
      );
    }

    // 5. The executor, inside the lease. The claim and the input read may have used up part of the lease, so the
    // run ends at the earlier of the lease expiry and the configured timeout from its start, and an expired lease
    // starts nothing. A run ended by the lease posts nothing, like any other lost lease (OQ-03 section 5).
    const skill = skillEntry(dispatch.identity.skill.id);
    if (skill === undefined) return await deny('CAPABILITY_UNSUPPORTED', 'the skill is not registered');
    const leaseEndsAtMs = Date.parse(grant.lease_expires_at);
    const launchAtMs = deps.now();
    if (!(launchAtMs < leaseEndsAtMs)) {
      log('lease_expired', { attempt: attemptId, stage: 'before_execution' });
      return { posted: false, why: 'lease_lost', detail: 'the lease expired before the executor started' };
    }
    const deadlineMs = Math.min(leaseEndsAtMs, launchAtMs + bounds.timeout_seconds * 1000);
    const lease = new AbortController();
    const leaseTimer = setTimeout(
      () => lease.abort('lease_expired'),
      Math.min(leaseEndsAtMs - launchAtMs, MAX_TIMER_MS),
    );
    let end: ExecutionEnd;
    try {
      end = await deps.execute({
        sessionId: dispatch.identity.session_id,
        profile: executor.profile,
        timeoutMs: deadlineMs - launchAtMs,
        outputLimitBytes: bounds.output_limit_bytes,
        budgetUsd: bounds.cost_reservation.amount,
        systemPrompt: instructionsFor(skill.id, verified.instructions),
        request: bytes,
        resultSchema: RESULT_SCHEMAS[skill.result_contract.replace(/\/1$/, '') as keyof typeof RESULT_SCHEMAS],
        signal: AbortSignal.any([signal, lease.signal]),
      });
    } finally {
      clearTimeout(leaseTimer);
    }
    if (signal.aborted && signal.reason === 'shutdown') {
      return { posted: false, why: 'shutdown', detail: 'the runner is shutting down; the attempt is left for fencing' };
    }
    if (lease.signal.aborted) {
      log('lease_expired', { attempt: attemptId, stage: 'during_execution' });
      return { posted: false, why: 'lease_lost', detail: 'the lease expired while the executor ran; it was ended' };
    }

    // 6. The role output goes through the shared validator, then is stored, then is named in the result.
    const direct = outcomeOf(end);
    if (direct !== undefined) return await finish(direct, end.facts);
    if (end.kind !== 'output') return { posted: false, why: 'internal_error', detail: 'unreachable execution end' };
    const validated =
      skill.id === 'strategy-formulation'
        ? parseFormulationResult(request as StrategyFormulationRequest, end.text)
        : parseCritiqueResult(request as StrategyCritiqueRequest, end.text);
    if (!validated.ok) {
      return await finish(
        { outcome: 'malformed_result', reason: validated.reason, diagnostic: say(validated.diagnostic) },
        end.facts,
      );
    }
    if ('blockers' in validated && validated.blockers.length > 0) {
      // Non-fatal notices for the API and the next proposal; they never make the output malformed.
      log('result_notices', {
        attempt: attemptId,
        notices: validated.blockers.map((blocker) => blocker.code).join(','),
      });
    }
    let text: string;
    try {
      text = canonicalJson(validated.value);
    } catch (error) {
      return await finish(
        {
          outcome: 'malformed_result',
          reason: 'SCHEMA_INVALID',
          diagnostic: say(`the role output has no canonical form: ${(error as Error).message}`),
        },
        end.facts,
      );
    }
    const stored = Buffer.from(text, 'utf8');
    const storedDigest = sha256Bytes(stored);
    const uploaded = await withRetries(deps, () => api.putArtefact(attemptId, storedDigest, stored, capability));
    if (!uploaded.ok) return lost(uploaded, 'the role output could not be stored');
    return await finish(
      {
        outcome: 'completion',
        output: {
          contract: skill.result_contract,
          artefact: { digest: storedDigest, media_type: MEDIA_TYPE, size_bytes: stored.byteLength },
        },
      },
      end.facts,
    );
  } catch (error) {
    // A runner failure is not an outcome. Post nothing: the lease expires and recovery fences a new attempt.
    log('attempt_crashed', {
      attempt: attemptId,
      detail: say(error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
    return { posted: false, why: 'internal_error', detail: 'the runner failed while it ran the attempt' };
  }
}

function requestContractOf(dispatch: AgentDispatch): RequestContractName | undefined {
  const name = dispatch.inputs.request.contract.replace(/\/1$/, '');
  return name === 'strategy-formulation.request' || name === 'strategy-critique.request' ? name : undefined;
}

/** Run a call, and repeat it after a wait while it fails for a reason that a repeat can cure. */
async function withRetries<T>(
  deps: Pick<AttemptDeps, 'sleep'>,
  call: () => Promise<{ ok: true; value: T } | ApiFailure>,
): Promise<{ ok: true; value: T } | ApiFailure> {
  let answer = await call();
  for (const wait of RETRIES) {
    if (answer.ok || !isTransient(answer)) return answer;
    await deps.sleep(wait);
    answer = await call();
  }
  return answer;
}
