// Holdout discipline of an agent request (OQ-02 section 3.3, OQ-03 section 4).
//
// In S1 every agent request, proposer and critic, carries holdout exclusions that name the validation window V and
// the holdout window H. Revision context holds development-window results and findings only. agent-dispatch/1 does
// not enforce this, so request assembly and the dispatch check do. The host still selects development-window records
// only: the date screen below is a safety net, not a classifier. Worker-safe: no Node module.

import type { CohortPolicy, HoldoutExclusion } from './types.ts';

/** The windows that every S1 agent request must exclude. */
export const REQUIRED_EXCLUSIONS = ['VALIDATION', 'HOLDOUT'] as const;

/**
 * Why a list of exclusions does not do its job: V and H must each be named exactly once and no window twice. With
 * the cohort policy at hand, each exclusion must also repeat its window's label and lie inside its scored dates.
 */
export function exclusionIssues(exclusions: readonly HoldoutExclusion[], policy?: CohortPolicy): string[] {
  const issues: string[] = [];
  for (const window of REQUIRED_EXCLUSIONS) {
    const count = exclusions.filter((item) => item.window === window).length;
    if (count === 0) issues.push(`the holdout exclusions do not name the ${window} window`);
    if (count > 1) issues.push(`the holdout exclusions name the ${window} window ${count} times`);
  }
  const development = exclusions.filter((item) => item.window === 'DEVELOPMENT').length;
  if (development > 1) issues.push(`the holdout exclusions name the DEVELOPMENT window ${development} times`);
  for (const exclusion of exclusions) {
    if (exclusion.range.start > exclusion.range.end) {
      issues.push(`the ${exclusion.window} exclusion starts after it ends`);
    }
    const rule = policy?.conditions.windows.windows.find((item) => item.role === exclusion.window);
    if (policy === undefined) continue;
    if (rule === undefined) {
      issues.push(`the cohort policy has no ${exclusion.window} window`);
      continue;
    }
    if (exclusion.label !== rule.label)
      issues.push(`the ${exclusion.window} exclusion repeats another label than the policy`);
    if (exclusion.range.start < rule.scored.start || exclusion.range.end > rule.scored.end) {
      issues.push(`the ${exclusion.window} exclusion lies outside the scored dates of the policy window`);
    }
  }
  return issues;
}

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

/** The ISO dates in `text` that fall inside any excluded range (the bounds are inclusive). */
export function datesInExclusions(text: string, exclusions: readonly HoldoutExclusion[]): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(ISO_DATE)) {
    const date = match[0];
    if (exclusions.some((item) => date >= item.range.start && date <= item.range.end) && !found.includes(date)) {
      found.push(date);
    }
  }
  return found;
}
