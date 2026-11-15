// The runner: claim before anything starts, then run the attempt in the background (OQ-03 section 5, OQ-05 section 4).
//
// ResearchWorkflow submits an existing attempt to the dispatch route. The runner obtains a durable claim through the
// control API before it answers and before it starts any process, so a refused claim spawns nothing. It then answers
// at once and runs the attempt on its own. The workflow observes the stored status through bounded polling. A dispatch
// that times out is checked under the same attempt id: a second claim of the same attempt is refused by the API, and a
// second dispatch of an attempt that this process already runs is refused here, before any call.

import type { AgentDispatch, ApiErrorCode, AttemptClaimRequest } from '@openquant/api-contracts';
import type { ApiClient, ApiFailure } from './api-client.ts';
import { type AttemptDeps, type AttemptEnd, type Logger, runAttempt } from './attempt.ts';
import type { RunnerConfig } from './config.ts';
import { type ExecutionEnd, type ExecutionRequest, execute } from './executor.ts';

export type DispatchAnswer =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'refused';
      readonly code: ApiErrorCode;
      readonly message: string;
      readonly stateChanged: 'NONE' | 'UNKNOWN';
    };

export interface RunnerDeps {
  readonly config: RunnerConfig;
  readonly api: ApiClient;
  /** The executor. Defaults to the pinned CLI of the configuration. Tests pass the same function with scripts. */
  readonly execute?: (request: ExecutionRequest) => Promise<ExecutionEnd>;
  readonly now?: () => number;
  readonly log?: Logger;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface Active {
  readonly controller: AbortController;
  promise: Promise<AttemptEnd> | undefined;
}

export class Runner {
  readonly #config: RunnerConfig;
  readonly #api: ApiClient;
  readonly #deps: AttemptDeps;
  readonly #active = new Map<string, Active>();
  readonly #ended: AttemptEnd[] = [];

  constructor(deps: RunnerDeps) {
    this.#config = deps.config;
    this.#api = deps.api;
    const run = deps.execute ?? ((request: ExecutionRequest) => execute(deps.config.executor, request));
    this.#deps = {
      config: deps.config,
      api: deps.api,
      execute: run,
      now: deps.now ?? (() => Date.now()),
      log: deps.log ?? (() => undefined),
      sleep: deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
  }

  /** Attempts that run now. */
  get running(): number {
    return this.#active.size;
  }

  /** The ends of the attempts that finished, in order. Tests and the shutdown report read it. */
  get ended(): readonly AttemptEnd[] {
    return this.#ended;
  }

  /**
   * Accept one dispatch: check what can be refused before a claim, claim, then start the attempt. Returns once the
   * claim is durable, not when the attempt ends.
   */
  async dispatch(dispatch: AgentDispatch, dispatchDigest: string): Promise<DispatchAnswer> {
    const attemptId = dispatch.identity.attempt.attempt_id;
    if (dispatch.environment !== this.#config.environment) {
      return {
        kind: 'refused',
        code: 'IDENTITY_MISMATCH',
        message: `the dispatch is for ${dispatch.environment}, and this runner serves ${this.#config.environment}`,
        stateChanged: 'NONE',
      };
    }
    if (this.#active.has(attemptId)) {
      return {
        kind: 'refused',
        code: 'ATTEMPT_NOT_CLAIMABLE',
        message: 'this runner already runs the attempt',
        stateChanged: 'NONE',
      };
    }
    if (this.#active.size >= this.#config.maxConcurrent) {
      return {
        kind: 'refused',
        code: 'RATE_LIMITED',
        message: `this runner runs ${this.#config.maxConcurrent} attempts at most at the same time`,
        stateChanged: 'NONE',
      };
    }
    // Reserve the place before the claim await, so a repeated dispatch cannot pass the checks above meanwhile.
    const slot: Active = { controller: new AbortController(), promise: undefined };
    this.#active.set(attemptId, slot);

    const request: AttemptClaimRequest = {
      schema_version: 'attempt-claim/1',
      form: 'claim',
      attempt: dispatch.identity.attempt,
      dispatch_digest: dispatchDigest,
      executable: this.#config.identity,
      worker_id: this.#config.workerId,
    };
    const claimed = await this.#api.claim(request);
    if (!claimed.ok) {
      this.#active.delete(attemptId);
      this.#deps.log('claim_refused', { attempt: attemptId, status: claimed.status, code: claimed.code });
      return refusalOf(claimed);
    }
    this.#deps.log('claimed', { attempt: attemptId, worker: this.#config.workerId });
    // Nothing is started before this line. The attempt runs on its own from here.
    slot.promise = runAttempt(dispatch, claimed.value, this.#deps, slot.controller.signal)
      .catch(
        (): AttemptEnd => ({
          posted: false,
          why: 'internal_error',
          detail: 'the attempt ended with an unexpected error',
        }),
      )
      .then((end) => {
        this.#active.delete(attemptId);
        this.#ended.push(end);
        return end;
      });
    return { kind: 'accepted' };
  }

  /**
   * Cancel one attempt: the process tree is ended and the outcome `cancellation` is recorded. The route manifest has
   * no route that asks a runner to cancel yet, so this is the hook for it (OQ-03 section 5).
   */
  cancel(attemptId: string): boolean {
    const slot = this.#active.get(attemptId);
    if (slot === undefined) return false;
    slot.controller.abort('cancel');
    return true;
  }

  /** Resolves when no attempt runs. */
  async idle(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.all([...this.#active.values()].map((slot) => slot.promise ?? Promise.resolve()));
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Stop for a restart: end every process tree and post nothing. A cancellation is final and is not retried, so a
   * shutdown must not look like one. The leases expire and recovery fences new attempts (OQ-03 section 5).
   */
  async shutdown(): Promise<void> {
    for (const slot of this.#active.values()) slot.controller.abort('shutdown');
    await this.idle();
  }
}

// What the dispatch caller sees when the claim is refused (the errors of the `runner.dispatch` route). The claim is a
// call of the runner to the API, so an error of the claim route about the runner's own credential or body is the
// runner's fault, not the caller's: it is reported as an unavailable or internal dependency.
function refusalOf(failure: ApiFailure): DispatchAnswer {
  switch (failure.code) {
    case 'STALE_OWNERSHIP':
    case 'ATTEMPT_NOT_CLAIMABLE':
    case 'IDENTITY_MISMATCH':
    case 'EXECUTION_DISABLED':
    case 'RATE_LIMITED':
      return refused(failure.code, `the claim was refused: ${failure.code}`, 'NONE');
    case 'NOT_FOUND':
      return refused('IDENTITY_MISMATCH', 'the control API does not know the attempt', 'NONE');
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
      return refused('UNAVAILABLE', 'the runner is not authorised to claim; check its service credential', 'NONE');
    case 'SCHEMA_VIOLATION':
    case 'UNSUPPORTED_SCHEMA_VERSION':
    case 'INVALID_DECIMAL':
    case 'LIMIT_EXCEEDED':
      return refused('INTERNAL', 'the control API rejected the claim of the runner', 'NONE');
    default:
      // No answer, a bad answer or an unavailable API: the claim may or may not exist. The same attempt id decides.
      return refused(
        'UNAVAILABLE',
        'the claim could not be confirmed; check the attempt under the same id before dispatching again',
        'UNKNOWN',
      );
  }
}

function refused(code: ApiErrorCode, message: string, stateChanged: 'NONE' | 'UNKNOWN'): DispatchAnswer {
  return { kind: 'refused', code, message, stateChanged };
}
