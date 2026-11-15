// Building the host-captured attempt result (agent-attempt-result/1, OQ-03 section 4).
//
// The runner writes provenance, outcome and usage. The model writes none of them. A value that nothing reported is
// an explicit unknown, never an inference from the requested profile (OQ-03 section 3). A denial before the model
// run started costs nothing, and the runner knows that because it controls the start: its usage is a measured zero.
// Any run that started and ended without a usage report keeps the full reservation, as unknown usage does.

import type {
  AgentAttemptResult,
  AgentDispatch,
  AgentOutcome,
  AgentUsage,
  ExecutableIdentity,
  ReportedName,
} from '@openquant/api-contracts';
import type { ExecutionEnd, ExecutionFacts } from './executor.ts';
import { decimalString, utcTimestamp } from './text.ts';

const REPORTED_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/;

export function reportedName(value: string | undefined): ReportedName {
  return value !== undefined && REPORTED_NAME.test(value) ? { status: 'reported', value } : { status: 'unknown' };
}

const COST_CURRENCY = 'USD';

/** The usage of an attempt, with the label that says where each value came from. */
export function usageOf(facts: ExecutionFacts, attemptMs: number): AgentUsage {
  if (!facts.started) {
    return {
      cost: { label: 'observed', amount: '0', currency: COST_CURRENCY },
      duration: { label: 'observed', milliseconds: Math.max(0, Math.round(attemptMs)) },
      input_tokens: { label: 'observed', count: 0 },
      output_tokens: { label: 'observed', count: 0 },
    };
  }
  const amount = facts.costUsd === undefined ? undefined : decimalString(facts.costUsd);
  const unknown = (what: string) => ({ label: 'unknown' as const, reason: `the executor reported no ${what}` });
  return {
    // Claude Code reports a list-price estimate of the cost (OQ-03 section 1).
    cost: amount === undefined ? unknown('cost') : { label: 'estimated', amount, currency: COST_CURRENCY },
    duration: { label: 'observed', milliseconds: Math.max(0, Math.round(facts.durationMs ?? attemptMs)) },
    input_tokens:
      facts.inputTokens === undefined ? unknown('input token count') : { label: 'observed', count: facts.inputTokens },
    output_tokens:
      facts.outputTokens === undefined
        ? unknown('output token count')
        : { label: 'observed', count: facts.outputTokens },
  };
}

/** The outcome that an execution end maps to, or undefined for output that still has to be validated. */
export function outcomeOf(end: ExecutionEnd): AgentOutcome | undefined {
  switch (end.kind) {
    case 'output':
      return undefined;
    case 'refusal':
      return { outcome: 'refusal', diagnostic: end.diagnostic };
    case 'authentication':
      return { outcome: 'authentication_failure', reason: end.reason, diagnostic: end.diagnostic };
    case 'denied':
      return { outcome: 'denied_capability', reason: end.reason, diagnostic: end.diagnostic };
    case 'malformed':
      return { outcome: 'malformed_result', reason: end.reason, diagnostic: end.diagnostic };
    case 'timeout':
      return { outcome: 'timeout', diagnostic: end.diagnostic };
    case 'cancelled':
      return { outcome: 'cancellation', diagnostic: end.diagnostic };
  }
}

export interface ResultInput {
  readonly dispatch: AgentDispatch;
  readonly runner: ExecutableIdentity;
  readonly outcome: AgentOutcome;
  readonly facts: ExecutionFacts;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

/**
 * The attempt result. `input_hash` and `bundle_hash` repeat the dispatch: they name the request and bundle that the
 * attempt was bound to. A bundle or request mismatch found before the executor started is stated in the diagnostic,
 * with the hash that was found, so the API can bind the record to the attempt it dispatched.
 */
export function buildResult(input: ResultInput): AgentAttemptResult {
  const { dispatch, facts } = input;
  return {
    schema_version: 'agent-attempt-result/1',
    attempt: dispatch.identity.attempt,
    provenance: {
      session_id: dispatch.identity.session_id,
      input_hash: dispatch.inputs.request.artefact.digest,
      bundle_hash: dispatch.identity.bundle_hash,
      executor_version: reportedName(facts.executorVersion),
      provider: reportedName(facts.provider),
      model: reportedName(facts.model),
      effort: reportedName(facts.effort),
      runner: input.runner,
    },
    outcome: input.outcome,
    usage: usageOf(facts, input.finishedAtMs - input.startedAtMs),
    started_at: utcTimestamp(input.startedAtMs),
    finished_at: utcTimestamp(Math.max(input.finishedAtMs, input.startedAtMs)),
  };
}
