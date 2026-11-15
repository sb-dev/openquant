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

// A calendar date written year first: YYYY-MM-DD, YYYY/MM/DD or the compact YYYYMMDD, with one separator throughout.
// No digit may stand directly before or after it, but any other character may, so the date inside an ISO timestamp
// (2024-06-03T20:00:00Z, 20240603T200000Z), a file name (file_2024-06-03.csv) or a suffixed token (2024-06-03Z) is
// found. Only a real calendar date counts, which keeps an unrelated eight-digit number out of the compact form.
// Not screened: dates with a month name (June 3, 2024), day-first or month-first numeric dates (03/06/2024), two-digit
// years, ordinal and week dates (2024-155, 2024-W23).
const YEAR_FIRST_DATE = /(?<!\d)(\d{4})([-/]?)(\d{2})\2(\d{2})(?!\d)/g;

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The dates in `text` that fall inside any excluded range (the bounds are inclusive), each written as YYYY-MM-DD and
 * listed once. See `YEAR_FIRST_DATE` for the forms that are found and those that are not.
 */
export function datesInExclusions(text: string, exclusions: readonly HoldoutExclusion[]): string[] {
  const found: string[] = [];
  for (const [, year = '', , month = '', day = ''] of text.matchAll(YEAR_FIRST_DATE)) {
    if (!isCalendarDate(Number(year), Number(month), Number(day))) continue;
    const date = `${year}-${month}-${day}`;
    if (exclusions.some((item) => date >= item.range.start && date <= item.range.end) && !found.includes(date)) {
      found.push(date);
    }
  }
  return found;
}
