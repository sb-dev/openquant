// How a numerical outcome of the Rust core, or a submission that ended before the core prepared a run, maps to run
// status and to the gates that depend on the run (OQ-02 section 3.6, decisions D5 and D6). The mapping is a table that
// the API applies; it does not decide what a candidate is worth.
//
//   COMPLETED                                              run COMPLETED; the gates assess its metrics
//   FAILED  INVALID_LEVEL or an operator code              run FAILED; correctness FAIL; the defect is the candidate's
//   FAILED  FUTURE_DATA, EVENT_OUT_OF_ORDER, or an input,
//           schema, identity, policy or checkpoint code    run FAILED; dependent gates INSUFFICIENT; attention item
//   FAILED  ARITHMETIC_OVERFLOW                            run FAILED; outside the engine domain; gates INSUFFICIENT
//   INSUFFICIENT  any code                                 run COMPLETED; dependent gates INSUFFICIENT; no metrics
//   NOT_PREPARED  a failure code                           run FAILED, mapped by its code as the FAILED rows; no metrics

export type EvaluationStatus = 'COMPLETED' | 'FAILED' | 'INSUFFICIENT' | 'NOT_PREPARED';

/** What the dependent gates read from the run: the reason a gate cannot be decided, or that it can. */
export type GateEffect = 'ASSESS' | 'CORRECTNESS_FAIL' | 'INSUFFICIENT' | 'OUTSIDE_ENGINE_DOMAIN';

export interface OutcomeMapping {
  readonly runStatus: 'COMPLETED' | 'FAILED';
  readonly gates: GateEffect;
  /** A platform failure opens an attention item: the defect is not the candidate's. */
  readonly attention: boolean;
}

/** FAILED codes whose defect belongs to the candidate. */
export const CANDIDATE_CODES: ReadonlySet<string> = new Set([
  'INVALID_LEVEL',
  'UNSUPPORTED_OPERATOR',
  'OPERATOR_TYPE_MISMATCH',
  'OPERATOR_UNIT_MISMATCH',
  'INVALID_PARAMETER',
]);

/** FAILED codes whose defect belongs to the platform: the data, the input, the identity or the policy. */
export const PLATFORM_CODES: ReadonlySet<string> = new Set([
  'FUTURE_DATA',
  'EVENT_OUT_OF_ORDER',
  'UNSUPPORTED_SCHEMA_VERSION',
  'SCHEMA_VIOLATION',
  'INVALID_DECIMAL',
  'IDENTITY_MISMATCH',
  'CHECKPOINT_MISMATCH',
  'UNSUPPORTED_POLICY',
  'INVALID_INPUT',
]);

/** The codes that the core reports as INSUFFICIENT: it lacks evidence, it did not fail (quant-core model.rs). */
export const INSUFFICIENT_CODES: ReadonlySet<string> = new Set([
  'MISSING_REQUIRED_BAR',
  'UNSUPPORTED_CORPORATE_ACTION',
  'FRACTIONAL_ENTITLEMENT',
  'UNSUPPORTED_VALUATION',
]);

const OVERFLOW = 'ARITHMETIC_OVERFLOW';

/** Whether the code belongs to the status: the engine derives the status from the code, so the pair is fixed. */
export function codeBelongsToStatus(status: 'FAILED' | 'INSUFFICIENT', code: string): boolean {
  if (status === 'INSUFFICIENT') return INSUFFICIENT_CODES.has(code);
  return CANDIDATE_CODES.has(code) || PLATFORM_CODES.has(code) || code === OVERFLOW;
}

export function mapOutcome(status: EvaluationStatus, code?: string): OutcomeMapping {
  switch (status) {
    case 'COMPLETED':
      return { runStatus: 'COMPLETED', gates: 'ASSESS', attention: false };
    case 'INSUFFICIENT':
      return { runStatus: 'COMPLETED', gates: 'INSUFFICIENT', attention: false };
    case 'FAILED':
    case 'NOT_PREPARED': {
      if (code !== undefined && CANDIDATE_CODES.has(code))
        return { runStatus: 'FAILED', gates: 'CORRECTNESS_FAIL', attention: false };
      if (code === OVERFLOW) return { runStatus: 'FAILED', gates: 'OUTSIDE_ENGINE_DOMAIN', attention: false };
      // A platform code, and any code that could not have been prepared: the platform, not the candidate, owns it.
      return { runStatus: 'FAILED', gates: 'INSUFFICIENT', attention: true };
    }
  }
}
