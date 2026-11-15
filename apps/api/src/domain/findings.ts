// Finding treatment and holdout consumption (OQ-02 sections 3.3 and 3.6, OQ-03 section 4).
//
// The critic's findings are recorded as they are (migration 0006, `findings`). The treatment of each finding for each
// lifecycle transition is a separate row that the registered cohort policy assigns, so a critic cannot set it, change
// it or close its own finding. Method notes and a model-stated severity never enter the mapping. A finding is BLOCKING
// for a transition when the policy row of its category says BLOCKING, or when an `escalate_when` condition of that row
// holds for the finding; otherwise it is ADVISORY.

import type { CohortPolicy } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';

export type Transition = 'DRAFT_TO_EVALUATING' | 'EVALUATING_TO_PAPER';
export const TRANSITIONS_OF_S1: readonly Transition[] = ['DRAFT_TO_EVALUATING', 'EVALUATING_TO_PAPER'];

interface FindingRow {
  finding_id: string;
  category: string;
  affects_executable_rule: boolean;
  required_evidence: boolean;
}

/** The treatment that a policy gives one finding for one transition. */
export function treatmentOf(
  policy: CohortPolicy,
  finding: { category: string; affects_executable_rule: boolean; required_evidence: boolean },
  transition: Transition,
): 'BLOCKING' | 'ADVISORY' {
  const rule = policy.finding_treatment.find(
    (row) => row.category === finding.category && row.transition === transition,
  );
  if (rule === undefined) throw new Error(`The policy has no treatment for ${finding.category} at ${transition}.`);
  const escalated = rule.escalate_when.some((condition) =>
    condition === 'affects_executable_rule' ? finding.affects_executable_rule : finding.required_evidence,
  );
  return rule.treatment === 'BLOCKING' || escalated ? 'BLOCKING' : 'ADVISORY';
}

/**
 * Assign the treatment of every finding of a candidate that has none yet, for both transitions of S1. Idempotent. In S1
 * no finding blocks DRAFT to EVALUATING (policy registration refuses a policy that says otherwise, and a database check
 * repeats it). Returns the number of treatment rows written.
 */
export async function assignFindingTreatments(
  tx: Queryable,
  env: Pick<ApiEnv, 'clock'>,
  missionId: string,
  strategyHash: string,
  policy: { id: string; revision: number; document: CohortPolicy },
): Promise<number> {
  const { rows } = await tx.query<FindingRow>(
    `SELECT finding_id, category, affects_executable_rule, required_evidence FROM findings
      WHERE mission_id = $1 AND strategy_hash = $2 ORDER BY finding_id`,
    [missionId, strategyHash],
  );
  let written = 0;
  for (const finding of rows) {
    for (const transition of TRANSITIONS_OF_S1) {
      const treatment = treatmentOf(policy.document, finding, transition);
      const result = await tx.query(
        `INSERT INTO finding_treatments (finding_id, transition, treatment, policy_id, policy_revision, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (finding_id, transition) DO NOTHING`,
        [finding.finding_id, transition, treatment, policy.id, policy.revision, env.clock()],
      );
      written += result.rowCount;
    }
  }
  return written;
}

/** The findings of a candidate that the registered policy treats as blocking for a transition and nobody resolved. */
export async function blockingFindings(
  tx: Queryable,
  missionId: string,
  strategyHash: string,
  transition: Transition,
): Promise<string[]> {
  const { rows } = await tx.query<{ finding_id: string }>(
    `SELECT f.finding_id FROM findings f JOIN finding_treatments t ON t.finding_id = f.finding_id
      WHERE f.mission_id = $1 AND f.strategy_hash = $2 AND t.transition = $3 AND t.treatment = 'BLOCKING'
        AND t.resolved_at IS NULL ORDER BY f.finding_id`,
    [missionId, strategyHash, transition],
  );
  return rows.map((row) => row.finding_id);
}

/**
 * Revealing the result of a holdout run is consumption (OQ-02 section 3.3, A05): it is recorded once per run, never
 * removed, so tuning on the holdout cannot be called a fresh out-of-sample claim. Returns whether this call wrote it.
 */
export async function recordHoldoutConsumption(
  tx: Queryable,
  env: Pick<ApiEnv, 'clock'>,
  runId: string,
  revealedBy: string,
): Promise<boolean> {
  const run = await tx.query<{ window_role: string | null }>('SELECT window_role FROM runs WHERE run_id = $1', [runId]);
  if (run.rows[0] === undefined) throw new Error(`The run ${runId} does not exist.`);
  if (run.rows[0].window_role !== 'HOLDOUT') throw new Error(`The run ${runId} is not a holdout run.`);
  const result = await tx.query(
    `INSERT INTO holdout_consumption (run_id, revealed_by, revealed_at) VALUES ($1, $2, $3)
     ON CONFLICT (run_id) DO NOTHING`,
    [runId, revealedBy, env.clock()],
  );
  if (result.rowCount === 1) {
    await writeAudit(tx, env.clock(), {
      eventType: 'holdout.consumed',
      actor: revealedBy,
      subject: runId,
      detail: {},
    });
  }
  return result.rowCount === 1;
}
