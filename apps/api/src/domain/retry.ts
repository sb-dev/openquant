// Which failures are retried (OQ-05 sections 4 and 7.1, OQ-03 section 5; decisions D5 and D6).
//
// Retried, up to the attempt cap and only when the budget covers a new reservation:
//   - the lease of an attempt expired: a worker death or a runner crash is not an outcome, recovery fences a new attempt;
//   - an agent attempt ended with a timeout or a malformed result;
//   - a retrieval failed with a transient class (rate limit, timeout, unavailable data, malformed response) and the host
//     marked it retryable.
// Never retried, the run or job is FAILED at once:
//   - an agent refusal, a denied capability, an authentication failure, a cancellation;
//   - a retrieval failure of class authentication, permission, unsupported capability, cancellation or egress refusal,
//     even if a host marks it retryable: an egress refusal is a configuration or policy failure (OQ-05 section 7.1);
//   - any other failure that the host does not mark retryable.

export type AgentFailureOutcome =
  | 'refusal'
  | 'malformed_result'
  | 'denied_capability'
  | 'authentication_failure'
  | 'cancellation'
  | 'timeout';

export type RetrievalErrorClass =
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UNAVAILABLE_DATA'
  | 'UNSUPPORTED_CAPABILITY'
  | 'MALFORMED_RESPONSE'
  | 'CANCELLED'
  | 'EGRESS_REFUSED';

export type FailureCause =
  | { readonly kind: 'LEASE_EXPIRED' }
  | { readonly kind: 'AGENT_OUTCOME'; readonly outcome: AgentFailureOutcome }
  | { readonly kind: 'RETRIEVAL'; readonly errorClass: RetrievalErrorClass; readonly retryable: boolean }
  | { readonly kind: 'WORKER_FAILURE'; readonly code: string; readonly retryable: boolean };

const NEVER_RETRIED_RETRIEVAL: ReadonlySet<RetrievalErrorClass> = new Set([
  'AUTHENTICATION',
  'PERMISSION',
  'UNSUPPORTED_CAPABILITY',
  'CANCELLED',
  'EGRESS_REFUSED',
]);

const RETRIED_AGENT: ReadonlySet<AgentFailureOutcome> = new Set(['timeout', 'malformed_result']);

export interface Classification {
  /** A retry is allowed if the attempt cap and the budget permit one. */
  readonly retryable: boolean;
  /** The code that the attempt and, when it ends the work, the run or job record. */
  readonly code: string;
  readonly agentOutcome?: AgentFailureOutcome;
}

export function classify(cause: FailureCause): Classification {
  switch (cause.kind) {
    case 'LEASE_EXPIRED':
      return { retryable: true, code: 'LEASE_EXPIRED' };
    case 'AGENT_OUTCOME':
      return {
        retryable: RETRIED_AGENT.has(cause.outcome),
        code: `AGENT_${cause.outcome.toUpperCase()}`,
        agentOutcome: cause.outcome,
      };
    case 'RETRIEVAL':
      return {
        retryable: cause.retryable && !NEVER_RETRIED_RETRIEVAL.has(cause.errorClass),
        code: `RETRIEVAL_${cause.errorClass}`,
      };
    case 'WORKER_FAILURE':
      return { retryable: cause.retryable, code: cause.code };
  }
}
