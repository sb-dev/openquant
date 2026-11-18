// Plain-text views of the API's read routes and command outcomes (OQ-04 sections 4, 5, 12). Each formatter returns
// lines that the renderer wraps to the output width. A value is shown as the API states it, with its unit: nothing is
// recomputed. A value that nothing reported (null) is shown as unknown or as not yet recorded, never as zero. S1
// records no EVALUATING -> PAPER Decision, and that Decision alone is shown as "none recorded" (OQ-04 section 5).

import type {
  DecisionsView,
  EvaluationMetrics,
  EvaluationResult,
  FindingsView,
  GateOutcome,
  GatesView,
  LineageView,
  MissionView,
  ResolvedWindow,
  TrialsView,
  ViewLineageRun,
} from '@openquant/api-contracts';

/** The one Decision that S1 never records (OQ-04 section 5). */
export const NONE_RECORDED_LINE = 'EVALUATING -> PAPER Decision: none recorded (S1 records none)';

/** A reported value, or `absent` (never zero) when nothing reported it. */
export function known(value: string | number | null | undefined, absent = 'unknown'): string {
  return value === null || value === undefined ? absent : String(value);
}

const record = (ref: { id: string; revision: number }) => `${ref.id} r${ref.revision}`;
const transition = (kind: string) => kind.replace(/_TO_/, ' -> ');

export function missionLines(view: MissionView): string[] {
  const lines = [`Mission ${view.mission_id} (revision ${view.revision})`, `  status: ${view.status}`];
  if (view.status === 'CONCLUDED') {
    const note = view.outcome === 'NO_ELIGIBLE_CANDIDATE' ? ' (a valid research result, not a failure)' : '';
    lines.push(`  outcome: ${known(view.outcome)}${note}`, `  reason: ${known(view.outcome_reason, 'not recorded')}`);
  }
  if (view.blocked_reason !== null) lines.push(`  blocked: ${view.blocked_reason}`);
  if (view.withdrawn !== null) {
    lines.push(
      `  withdrawn by ${view.withdrawn.by} at ${known(view.withdrawn.at)}: ${known(view.withdrawn.reason, 'no reason recorded')}`,
    );
  }
  lines.push(
    `  objective: ${view.objective}`,
    `  instrument: ${view.scope.symbol} (${view.scope.instrument_id}, ${view.scope.provider}) from ${view.scope.effective_from}`,
    `  profile: ${record(view.profile)}; cohort policy: ${record(view.cohort_policy)}`,
    `  seed draft: ${view.seed_draft_digest}`,
    `  evaluation plan: ${known(view.plan_digest, 'not recorded yet')}`,
    `  created by ${view.created_by} at ${view.created_at}`,
    `  started: ${view.started_at === null ? 'not started' : `by ${known(view.started_by)} at ${view.started_at}`}`,
    `  concluded at: ${known(view.concluded_at, 'not concluded')}`,
  );
  lines.push(`Candidates (${view.candidates.length})`);
  if (view.candidates.length === 0) lines.push('  no trial slot yet');
  for (const candidate of view.candidates) {
    lines.push(
      `  ${candidate.trial_slot} (${candidate.kind}${candidate.configuration_id === null ? '' : `, ${candidate.configuration_id}`})`,
      `    strategy: ${known(candidate.strategy_hash, 'no registered version')}`,
      `    lifecycle: ${known(candidate.lifecycle, 'not registered')}; DRAFT -> EVALUATING Decision: ${known(candidate.decision, 'pending')}`,
      `    eligibility: ${known(candidate.eligibility, 'not assessed')}`,
    );
    if (candidate.terminal_reason !== null) lines.push(`    ended: ${candidate.terminal_reason}`);
  }
  lines.push(`Jobs (${view.jobs.length})`);
  for (const job of view.jobs) {
    const scope = [job.trial_slot, job.agent_role, job.configuration_id].filter((part) => part !== null).join(', ');
    lines.push(
      `  ${job.job_id} ${job.kind}${scope === '' ? '' : ` (${scope})`}: ${job.status}, ${job.attempts} attempt(s)`,
    );
    if (job.waiting_reason !== null) lines.push(`    waiting: ${job.waiting_reason}`);
    if (job.failure_code !== null) lines.push(`    failure: ${job.failure_code}`);
  }
  lines.push(
    `Runs: ${view.runs.length === 0 ? 'none written yet' : view.runs.map((run) => `${run.status} ${run.runs}`).join(', ')}`,
  );
  lines.push(`Attention (${view.attention_items.length})`);
  for (const item of view.attention_items) {
    lines.push(`  ${item.status} ${item.item_id} ${item.subject} (opened ${item.opened_at})`, `    ${item.reason}`);
  }
  return lines;
}

export function budgetLines(view: MissionView): string[] {
  const lines = [`Budget of mission ${view.mission_id}`];
  const limits = view.budget.limits;
  if (limits === null) {
    lines.push('  limits: unknown (the mission records none)');
  } else {
    const money = (amount: string) => `${amount} ${limits.currency}`;
    lines.push(
      `  candidates: ${limits.candidates}; experiments: ${limits.experiments}; attempt cap: ${limits.attempt_cap}`,
      `  proposers: ${limits.proposer_count}; revisions per proposer: ${limits.revisions_per_proposer}; new families: ${limits.new_families}`,
      `  model spend: ${money(limits.model_spend)}; per attempt: ${money(limits.model_spend_per_attempt)}`,
      `  proposer spend: ${money(limits.proposer_spend)} over ${limits.proposer_attempts} attempt(s)`,
      `  critic spend: ${money(limits.critic_spend)} over ${limits.critic_attempts} attempt(s)`,
      `  provider requests: ${limits.provider_requests}`,
      `  batch compute: ${limits.batch_compute_seconds} s; agent compute: ${limits.agent_compute_seconds} s`,
    );
  }
  lines.push('Pools (limit / committed / overrun; committed counts reservations and spend)');
  if (view.budget.pools.length === 0) lines.push('  no pool yet');
  for (const pool of view.budget.pools) {
    const owner = pool.configuration_id === null ? '' : ` ${pool.configuration_id}`;
    lines.push(`  ${pool.dimension}${owner}: ${pool.limit} / ${pool.committed} / ${pool.overrun}`);
  }
  lines.push(
    `Reservations: ${view.reservations.length === 0 ? 'none yet' : view.reservations.map((item) => `${item.status} ${item.reservations}`).join(', ')}`,
  );
  return lines;
}

export function lineageLines(view: LineageView): string[] {
  const lines = [`Lineage of mission ${view.mission_id} (${view.versions.length} version(s))`];
  for (const version of view.versions) {
    lines.push(
      `  ${version.strategy_id} v${version.version} ${version.strategy_hash}`,
      `    lifecycle: ${version.lifecycle}; trial slot: ${known(version.trial_slot, 'none')}; registered ${version.registered_at}`,
      `    parent: ${known(version.parent_hash, 'none (first version)')}`,
      `    change scope: ${known(version.change_scope, 'not recorded')}; validation: ${known(version.validation_digest, 'not recorded')}`,
    );
    for (const run of version.runs) {
      lines.push(`    run ${run.run_id} ${run.window_role} ${run.cost_scenario}: ${run.status} (${run.run_slot})`);
    }
    lines.push(`    findings: ${version.findings.length === 0 ? 'none' : version.findings.join(', ')}`);
    lines.push(
      `    Decisions: ${version.decisions.length === 0 ? 'none yet' : version.decisions.map((decision) => `${decision.decision_id} ${decision.outcome}`).join(', ')}`,
    );
  }
  return lines;
}

export function trialsLines(view: TrialsView): string[] {
  const lines = [
    `Trials of mission ${view.mission_id}`,
    `  evaluation plan: ${known(view.plan_digest, 'not recorded yet')}`,
    `Trial slots (${view.trial_slots.length})`,
  ];
  for (const slot of view.trial_slots) {
    lines.push(
      `  ${slot.trial_slot} ${slot.kind}; configuration: ${known(slot.configuration_id, 'none')}; parent: ${known(slot.parent_slot, 'none')}`,
      `    ${slot.terminal_reason === null ? 'open' : `ended ${known(slot.terminal_at)}: ${slot.terminal_reason}`}`,
    );
  }
  lines.push(`Run slots (${view.run_slots.length})`);
  for (const slot of view.run_slots) {
    const replay = slot.replay_of === null ? '' : `; repeats ${slot.replay_of}`;
    lines.push(
      `  ${slot.run_slot} (${slot.trial_slot}) ${slot.window_role} ${slot.cost_scenario}; written by ${slot.written_by}${replay}`,
    );
    const run = slot.run;
    if (run === null) {
      lines.push('    run: not written yet');
      continue;
    }
    lines.push(
      `    run ${run.run_id}: ${run.status}; mode ${run.mode}; env ${run.environment}; ${run.attempts} attempt(s)`,
      `    completed: ${known(run.completed_at, 'not completed')}; holdout consumed: ${run.holdout_consumed ? 'yes' : 'no'}`,
    );
    if (run.waiting_reason !== null) lines.push(`    waiting: ${run.waiting_reason}`);
    if (run.failure_code !== null) lines.push(`    failure: ${run.failure_code}`);
  }
  lines.push(`Proposals (${view.trials.length})`);
  for (const trial of view.trials) {
    lines.push(
      `  ${trial.trial_id} ${trial.trial_slot} #${trial.proposal_ordinal}: ${trial.status}; strategy: ${known(trial.strategy_hash, 'not registered')}`,
    );
    if (trial.reason !== null) lines.push(`    reason: ${trial.reason}`);
  }
  return lines;
}

export function findingsLines(view: FindingsView): string[] {
  const lines = [`Findings of mission ${view.mission_id} (${view.findings.length})`];
  for (const finding of view.findings) {
    lines.push(
      `  ${finding.finding_id} ${finding.category} (${finding.finding_source}), critique ${finding.attempt_id} #${finding.ordinal}`,
      `    strategy: ${finding.strategy_hash}`,
      `    applies to: ${finding.applicability.length === 0 ? 'no executable rule or required evidence' : finding.applicability.join(', ')}`,
    );
    for (const treatment of finding.treatments) {
      const state =
        treatment.resolved_at === null
          ? 'open'
          : `resolved by ${known(treatment.resolved_by)} at ${treatment.resolved_at}`;
      lines.push(
        `    ${transition(treatment.transition)}: ${treatment.treatment} under ${record(treatment.policy)}, ${state}`,
      );
    }
  }
  return lines;
}

function gateLines(gate: GateOutcome): string[] {
  const head = `      ${gate.gate} (${gate.category}): ${gate.result}`;
  const lines = 'reason_code' in gate ? [`${head} - ${gate.reason_code}: ${gate.reason}`] : [head];
  if (gate.limitation !== undefined) lines.push(`        limitation: ${gate.limitation}`);
  for (const observation of gate.observations ?? []) {
    lines.push(
      `        ${observation.run_id} ${observation.window} ${observation.cost_scenario} ${observation.metric}: ${observation.observed} ${observation.comparison} ${observation.threshold}, holds: ${observation.holds ? 'yes' : 'no'}`,
    );
  }
  return lines;
}

export function gatesLines(view: GatesView): string[] {
  const lines = [
    `Gate reports of mission ${view.mission_id} (${view.reports.length})`,
    '  A passed gate grants no capital. The first read of holdout observations is recorded as their consumption.',
  ];
  for (const report of view.reports) {
    lines.push(
      `  strategy ${report.strategy_hash}`,
      `    policy ${record(report.cohort_policy)}; report ${report.report_digest}; recorded ${report.recorded_at}`,
      `    eligibility: ${report.eligibility === null ? 'not decided' : report.eligibility.state}`,
    );
    for (const reason of report.eligibility?.reasons ?? []) lines.push(`      ${reason}`);
    lines.push('    gates:');
    for (const gate of report.report.gates) lines.push(...gateLines(gate));
  }
  return lines;
}

export function decisionsLines(view: DecisionsView): string[] {
  const lines = [`Decisions of mission ${view.mission_id} (${view.decisions.length})`];
  if (view.decisions.length === 0) lines.push('  No Decision of this mission is stored yet.');
  for (const decision of view.decisions) {
    const slot = decision.trial_slot === null ? '' : ` slot ${decision.trial_slot}`;
    lines.push(
      `  ${decision.decision_id} ${transition(decision.kind)}${slot}: ${decision.outcome}`,
      `    by ${decision.actor_id} (${decision.actor_kind}) at ${decision.decided_at}; policy ${record(decision.cohort_policy)}`,
    );
    if (decision.strategy_hash !== null) lines.push(`    strategy: ${decision.strategy_hash}`);
    if (decision.critique_status !== null) {
      lines.push(`    critique: ${decision.critique_status} ${known(decision.critique_digest, '(no result)')}`);
    }
    if (decision.policy_approval_decision !== null) {
      lines.push(
        `    under approval ${decision.policy_approval_decision}; mission started by ${known(decision.mission_started_by)}`,
      );
    }
    if (decision.reason !== null) lines.push(`    reason: ${decision.reason}`);
  }
  if (!view.decisions.some((decision) => decision.kind === 'EVALUATING_TO_PAPER')) lines.push(NONE_RECORDED_LINE);
  return lines;
}

/** One run of a candidate with the official documents the API serves for it; null while none is committed. */
export interface RunValues {
  readonly run_id: string;
  readonly run_slot: string;
  readonly status: ViewLineageRun['status'];
  readonly window_role: ViewLineageRun['window_role'];
  readonly cost_scenario: ViewLineageRun['cost_scenario'];
  /** The run slot this one repeats (deterministic repeat), from the evaluation plan; null when it repeats none. */
  readonly replay_of: string | null;
  /** The label of the run's window from the evaluation plan; null when no plan is recorded. */
  readonly window_label: string | null;
  readonly metrics: EvaluationMetrics | null;
  readonly result: EvaluationResult | null;
}

export interface CandidateValues {
  readonly trial_slot: string | null;
  readonly strategy_id: string;
  readonly version: number;
  readonly strategy_hash: string;
  readonly lifecycle: string;
  readonly runs: readonly RunValues[];
}

/** The official values of a mission's candidates (OQ-04 section 5): what `mission results` reads and shows. */
export interface MissionResults {
  readonly mission_id: string;
  /** The windows of the evaluation plan, with their labels; null when no plan is recorded. */
  readonly windows: readonly ResolvedWindow[] | null;
  readonly candidates: readonly CandidateValues[];
}

const ROLE_ORDER = ['DEVELOPMENT', 'VALIDATION', 'HOLDOUT'] as const;
const LETTER: Record<string, string> = { DEVELOPMENT: 'D', VALIDATION: 'V', HOLDOUT: 'H' };
const UNKNOWN = 'unknown';

type Row = readonly [label: string, cell: (run: RunValues) => string];

const ratio = (metric: { value: string } | undefined) => metric?.value ?? UNKNOWN;
const money = (metric: { value: string; currency: string } | undefined) =>
  metric === undefined ? UNKNOWN : `${metric.value} ${metric.currency}`;
const count = (metric: { value: number } | undefined) => (metric === undefined ? UNKNOWN : String(metric.value));
const buyAndHold = (
  run: RunValues,
  read: (computed: {
    net_return: { value: string };
    max_drawdown: { value: string };
    excess_return: { value: string };
  }) => string,
) => {
  const benchmark = run.metrics?.benchmarks.buy_and_hold;
  if (benchmark === undefined) return UNKNOWN;
  return benchmark.status === 'COMPUTED' ? read(benchmark) : benchmark.status;
};
const final = (run: RunValues, read: (result: EvaluationResult) => string) =>
  run.result === null ? UNKNOWN : read(run.result);

/** Every row shows a value as the run's committed document states it; nothing is derived from another value. */
const ROWS: readonly Row[] = [
  ['run', (run) => run.run_id],
  ['status', (run) => run.status],
  ['net return', (run) => ratio(run.metrics?.strategy.net_return)],
  ['max drawdown', (run) => ratio(run.metrics?.strategy.max_drawdown)],
  ['worst session', (run) => ratio(run.metrics?.strategy.worst_session_return)],
  ['turnover', (run) => ratio(run.metrics?.strategy.turnover)],
  ['exposure', (run) => ratio(run.metrics?.strategy.exposure)],
  ['trades closed', (run) => count(run.metrics?.strategy.trade_count)],
  ['scored sessions', (run) => count(run.metrics?.strategy.scored_session_count)],
  ['fees', (run) => money(run.metrics?.strategy.execution_cost.fees)],
  ['gap slippage', (run) => money(run.metrics?.strategy.execution_cost.gap_slippage)],
  ['total cost', (run) => money(run.metrics?.strategy.execution_cost.total)],
  ['B&H net return', (run) => buyAndHold(run, (b) => b.net_return.value)],
  ['B&H max drawdown', (run) => buyAndHold(run, (b) => b.max_drawdown.value)],
  ['B&H excess return', (run) => buyAndHold(run, (b) => b.excess_return.value)],
  ['cash net return', (run) => ratio(run.metrics?.benchmarks.cash.net_return)],
  ['cash excess return', (run) => ratio(run.metrics?.benchmarks.cash.excess_return)],
];

/** The simulated per-candidate ledger as the result carries it: its final state and its record counts. */
const LEDGER_ROWS: readonly Row[] = [
  ['result outcome', (run) => final(run, (result) => result.outcome.status)],
  ['cash available', (run) => final(run, (result) => result.final.cash_available)],
  ['cash reserved', (run) => final(run, (result) => result.final.cash_reserved)],
  ['receivables', (run) => final(run, (result) => result.final.receivables)],
  ['positions value', (run) => final(run, (result) => result.final.positions_value)],
  ['equity', (run) => final(run, (result) => result.final.equity)],
  ['open positions', (run) => final(run, (result) => String(result.final.open_positions.length))],
  ['ledger entries', (run) => final(run, (result) => String(result.journal.cash_ledger.length))],
];

function table(title: string, runs: readonly RunValues[], rows: readonly Row[]): string[] {
  const head = (run: RunValues) =>
    `${LETTER[run.window_role] ?? run.window_role}${run.replay_of === null ? '' : ' repeat'}`;
  const all: (readonly [string, readonly string[]])[] = [
    [title, runs.map(head)],
    ...rows.map(([label, cell]) => [label, runs.map(cell)] as const),
  ];
  const labelWidth = Math.max(...all.map(([label]) => label.length)) + 2;
  const widths = runs.map((_, i) => Math.max(...all.map(([, cells]) => (cells[i] ?? '').length)) + 2);
  return all.map(([label, cells]) =>
    `    ${label.padEnd(labelWidth)}${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('')}`.replace(/ +$/, ''),
  );
}

function ordered(runs: readonly RunValues[]): RunValues[] {
  const rank = (run: RunValues) => ROLE_ORDER.indexOf(run.window_role) * 2 + (run.replay_of === null ? 0 : 1);
  return [...runs].sort((a, b) => rank(a) - rank(b) || a.run_slot.localeCompare(b.run_slot));
}

export function resultsLines(view: MissionResults): string[] {
  const lines = [
    `Official run values of mission ${view.mission_id} (${view.candidates.length} candidate(s))`,
    '  As the API serves them (evaluation-metrics/1, evaluation-result/1); nothing is recomputed. unknown: no',
    '  official value is committed. RATIO values are fractions of initial capital (0.05 is 5 percent); MONEY is',
    '  in the policy currency. The first read of a holdout run is recorded as its consumption.',
    'Windows (D development, V validation, H holdout; scored sessions and label)',
  ];
  if (view.windows === null) lines.push('  labels unknown: the evaluation plan is not recorded yet');
  for (const window of view.windows ?? []) {
    lines.push(
      `  ${LETTER[window.role] ?? window.role} ${window.resolved.scored_start} to ${window.resolved.scored_end}: ${window.label}`,
    );
  }
  for (const candidate of view.candidates) {
    lines.push(
      `Candidate ${known(candidate.trial_slot, 'without trial slot')}: ${candidate.strategy_id} v${candidate.version}, ${candidate.lifecycle}`,
      `  strategy: ${candidate.strategy_hash}`,
    );
    if (candidate.runs.length === 0) {
      lines.push('  no run written yet');
      continue;
    }
    for (const scenario of ['BASE', 'COST_STRESS'] as const) {
      const runs = ordered(candidate.runs.filter((run) => run.cost_scenario === scenario));
      if (runs.length > 0) lines.push(...table(scenario, runs, ROWS));
    }
    lines.push('  Simulated per-candidate ledger (final state of each result)');
    for (const scenario of ['BASE', 'COST_STRESS'] as const) {
      const runs = ordered(candidate.runs.filter((run) => run.cost_scenario === scenario));
      if (runs.length > 0) lines.push(...table(scenario, runs, LEDGER_ROWS));
    }
    const labels = new Map<string, string[]>();
    const uncertainty = new Map<string, string[]>();
    for (const run of ordered(candidate.runs)) {
      const label = run.window_label ?? 'unknown (no evaluation plan recorded)';
      const letter = LETTER[run.window_role] ?? run.window_role;
      const letters = labels.get(label) ?? [];
      if (!letters.includes(letter)) labels.set(label, [...letters, letter]);
      const statement =
        run.metrics === null
          ? 'unknown (no official metrics)'
          : `${run.metrics.uncertainty.status} - ${run.metrics.uncertainty.limitation}`;
      uncertainty.set(statement, [...(uncertainty.get(statement) ?? []), run.run_id]);
      const benchmark = run.metrics?.benchmarks.buy_and_hold;
      if (benchmark?.status === 'INSUFFICIENT')
        lines.push(`  buy-and-hold of ${run.run_id}: INSUFFICIENT - ${benchmark.reason}`);
      const outcome = run.result?.outcome;
      if (outcome !== undefined && outcome.status !== 'COMPLETED') {
        lines.push(
          `  result of ${run.run_id}: ${outcome.status}${outcome.code === undefined ? '' : ` ${outcome.code}`}; its final state is not a valuation${outcome.detail === undefined ? '' : ` (${outcome.detail})`}`,
        );
      }
    }
    for (const [label, letters] of labels) lines.push(`  window label of ${letters.join(', ')}: ${label}`);
    for (const [statement, runs] of uncertainty) lines.push(`  uncertainty: ${statement} (${runs.join(', ')})`);
  }
  return lines;
}
