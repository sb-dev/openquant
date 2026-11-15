// The semantic rules that a schema cannot state, checked when a Steward registers a policy or a Researcher a mission.
// Each function returns the first rule that fails as a sentence, or undefined. A sentence names the rule and never
// repeats text of the request. Rules come from OQ-02 sections 3.1 to 4, OQ-03 section 1 and the contract descriptions.

import type { CohortPolicy, MissionBudget, MissionSpec, ResearchProfile } from '@openquant/api-contracts';
import { isCalendarDate } from '../domain/dates.ts';
import { addDecimal, compareDecimal, fitsMoney } from '../domain/decimal.ts';

/** The evidence category of each gate of the S1 suite (OQ-02 section 3.2). */
export const GATE_CATEGORY: Readonly<Record<string, string>> = {
  DEFINITION_VALIDATION: 'CORRECTNESS',
  DETERMINISTIC_REPLAY: 'CORRECTNESS',
  ACCOUNTING_RECONCILIATION: 'CORRECTNESS',
  SIGNAL_DATA_TIMING: 'CORRECTNESS',
  POINT_IN_TIME_DATA: 'HISTORICAL_VALIDITY',
  BASE_COST_MODEL: 'HISTORICAL_VALIDITY',
  EXCESS_OVER_BUY_AND_HOLD: 'HISTORICAL_VALIDITY',
  WALK_FORWARD: 'HISTORICAL_VALIDITY',
  MINIMUM_TRADE_COUNT: 'HISTORICAL_VALIDITY',
  COST_STRESS: 'ROBUSTNESS',
  PARAMETER_SENSITIVITY: 'ROBUSTNESS',
  EXECUTION_DELAY: 'ROBUSTNESS',
  ADVERSE_REGIMES: 'ROBUSTNESS',
  RESAMPLING: 'ROBUSTNESS',
  PROSPECTIVE_EVIDENCE: 'PROSPECTIVE',
  PORTFOLIO_FIT: 'PORTFOLIO_FIT',
  OPERATING_READINESS: 'OPERATING_READINESS',
};

export const FINDING_CATEGORIES = [
  'hypothesis_assumption',
  'data_quality_alignment',
  'causal_leakage',
  'execution_accounting_assumption',
  'search_overfitting',
  'policy_mismatch',
  'portfolio_fit',
  'operational_risk',
  'source_uncertainty',
  'missing_evidence',
  'method_advice',
] as const;

export function profileProblem(profile: ResearchProfile): string | undefined {
  if (!isCalendarDate(profile.history.start) || !isCalendarDate(profile.history.end)) {
    return 'The history range holds a date that is not on the calendar.';
  }
  if (profile.history.start > profile.history.end) return 'The history range ends before it starts.';
  if (profile.data.currency !== profile.market.currency) {
    return 'The data currency is not the currency of the market.';
  }
  return undefined;
}

export function policyProblem(policy: CohortPolicy, profile: ResearchProfile): string | undefined {
  if (policy.suite_id !== profile.cohort_suite)
    return 'The suite of the policy is not the suite that the profile names.';
  if (policy.conditions.execution_policy.currency !== profile.market.currency) {
    return 'The currency of the execution policy is not the currency of the market.';
  }
  const rules = policy.conditions.windows;
  if (rules.warmup_sessions >= rules.max_sessions) return 'The warm-up fills the whole session limit of a run.';
  const byRole = new Map(rules.windows.map((window) => [window.role, window.scored]));
  const development = byRole.get('DEVELOPMENT');
  const validation = byRole.get('VALIDATION');
  const holdout = byRole.get('HOLDOUT');
  if (rules.windows.length !== 3 || development === undefined || validation === undefined || holdout === undefined) {
    return 'The windows are not exactly one development, one validation and one holdout window.';
  }
  for (const range of [development, validation, holdout]) {
    if (!isCalendarDate(range.start) || !isCalendarDate(range.end)) {
      return 'A window holds a date that is not on the calendar.';
    }
    if (range.start > range.end) return 'A window ends before it starts.';
    if (range.start < profile.history.start || range.end > profile.history.end) {
      return 'A window lies outside the history range of the profile.';
    }
  }
  if (!(development.end < validation.start && validation.end < holdout.start)) {
    return 'The windows do not run in the order development, validation, holdout without overlap.';
  }
  for (const rule of policy.gates) {
    if (GATE_CATEGORY[rule.gate] !== rule.category) {
      return `The gate ${rule.gate} is listed under the wrong evidence category.`;
    }
  }
  const seen = new Set<string>();
  for (const row of policy.finding_treatment) {
    const key = `${row.category}/${row.transition}`;
    if (seen.has(key)) return `The finding treatment of ${key} is listed twice.`;
    seen.add(key);
    // In S1 no finding category blocks DRAFT to EVALUATING (OQ-02 section 4).
    if (row.transition === 'DRAFT_TO_EVALUATING' && (row.treatment !== 'ADVISORY' || row.escalate_when.length > 0)) {
      return `The finding category ${row.category} blocks DRAFT to EVALUATING, which S1 does not allow.`;
    }
  }
  for (const category of FINDING_CATEGORIES) {
    if (!seen.has(`${category}/EVALUATING_TO_PAPER`)) {
      return `The finding category ${category} has no treatment for EVALUATING to PAPER.`;
    }
  }
  const maxima = policy.budget_limits.maxima;
  for (const money of [
    maxima.model_spend,
    maxima.model_spend_per_attempt,
    maxima.proposer_allowance.model_spend,
    maxima.critic_allowance.model_spend,
  ]) {
    if (!fitsMoney(money.amount)) return 'A budget maximum is not an amount that the ledger can hold.';
  }
  return undefined;
}

/** The numeric maxima, in the order that the budget is read. */
const COUNT_FIELDS = [
  'candidates',
  'experiments',
  'revisions_per_proposer',
  'new_families',
  'provider_requests',
  'batch_compute_seconds',
  'agent_compute_seconds',
  'attempt_cap',
] as const;

export function missionBudgetProblem(mission: MissionSpec, policy: CohortPolicy): string | undefined {
  const budget: MissionBudget = mission.budget;
  const maxima = policy.budget_limits.maxima;
  const amounts = [
    budget.model_spend,
    budget.model_spend_per_attempt,
    budget.proposer_allowance.model_spend,
    budget.critic_allowance.model_spend,
  ];
  if (amounts.some((money) => money.currency !== maxima.model_spend.currency)) {
    return 'The model spend amounts do not all use the currency of the policy.';
  }
  if (amounts.some((money) => !fitsMoney(money.amount)))
    return 'A model spend amount is not one that the ledger can hold.';
  const proposers = mission.proposers.length;
  const ids = [...mission.proposers.map((entry) => entry.configuration_id), mission.critic.configuration_id];
  if (new Set(ids).size !== ids.length) return 'Two agent configurations share an identifier.';
  // The sums that the schema cannot compare (connected-common MissionBudget).
  const proposerTotal = Array.from({ length: proposers }, () => budget.proposer_allowance.model_spend.amount).reduce(
    (sum, amount) => addDecimal(sum, amount),
    '0',
  );
  if (
    compareDecimal(addDecimal(proposerTotal, budget.critic_allowance.model_spend.amount), budget.model_spend.amount) !==
    0
  ) {
    return 'The model spend is not the allowances of the proposers and the critic added up.';
  }
  for (const [allowance, name] of [
    [budget.proposer_allowance, 'proposer'],
    [budget.critic_allowance, 'critic'],
  ] as const) {
    const attemptsSpend = Array.from(
      { length: allowance.agent_attempts },
      () => budget.model_spend_per_attempt.amount,
    ).reduce((sum, amount) => addDecimal(sum, amount), '0');
    if (compareDecimal(attemptsSpend, allowance.model_spend.amount) !== 0) {
      return `The ${name} allowance is not its attempts times the reservation of one attempt.`;
    }
  }
  const agentAttempts = proposers * budget.proposer_allowance.agent_attempts + budget.critic_allowance.agent_attempts;
  if (budget.agent_compute_seconds < agentAttempts * policy.limits.agent_timeout_seconds) {
    return 'The agent compute seconds do not cover every agent attempt for the timeout of the policy.';
  }
  // A retrieval attempt reserves the provider requests of the budget over the attempt cap (dispatch.ts): each attempt
  // needs at least one request, or it could not ask the provider for anything.
  if (budget.provider_requests < budget.attempt_cap) {
    return 'The provider requests of the budget do not give each attempt of a job at least one request.';
  }
  for (const field of COUNT_FIELDS) {
    if (budget[field] > maxima[field]) return `The budget ${field} is above the maximum of the policy.`;
  }
  const limits: [string, string, string][] = [
    ['model_spend', budget.model_spend.amount, maxima.model_spend.amount],
    ['model_spend_per_attempt', budget.model_spend_per_attempt.amount, maxima.model_spend_per_attempt.amount],
    ['proposer allowance', budget.proposer_allowance.model_spend.amount, maxima.proposer_allowance.model_spend.amount],
    ['critic allowance', budget.critic_allowance.model_spend.amount, maxima.critic_allowance.model_spend.amount],
  ];
  for (const [name, value, maximum] of limits) {
    if (compareDecimal(value, maximum) > 0) return `The budget ${name} is above the maximum of the policy.`;
  }
  if (budget.proposer_allowance.agent_attempts > maxima.proposer_allowance.agent_attempts) {
    return 'The proposer allowance has more agent attempts than the policy allows.';
  }
  if (budget.critic_allowance.agent_attempts > maxima.critic_allowance.agent_attempts) {
    return 'The critic allowance has more agent attempts than the policy allows.';
  }
  return undefined;
}
