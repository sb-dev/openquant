// Compares the TypeScript outcomes with the Rust contracts report (local-runs/contracts/report.json).
//
// The report is written by the Rust `contracts-report` binary of openquant-contracts:
// {"schema":"contracts-report/1","manifest_sha256":"<hex of the manifest bytes>","entries":[{"path",
// "contract","expect","verdict":"accepted"|"rejected","code" (when rejected),"digest" (when accepted)}]}

import type { EntryResult } from './manifest.ts';

export const REPORT_SCHEMA = 'contracts-report/1';
export const PRODUCE_REPORT =
  'Produce it with the Rust contracts report (cargo run --locked -p openquant-contracts --bin contracts-report), which writes local-runs/contracts/report.json, then rerun pnpm verify:contracts.';

function describe(entry: { readonly verdict?: unknown; readonly code?: unknown; readonly digest?: unknown }): string {
  return entry.verdict === 'accepted' ? `accepted ${String(entry.digest)}` : `rejected ${String(entry.code)}`;
}

/** Every difference between the Rust report and the TypeScript outcomes. Empty means parity. */
export function compareReport(report: unknown, manifestSha256: string, results: readonly EntryResult[]): string[] {
  if (typeof report !== 'object' || report === null || Array.isArray(report))
    return ['the report is not a JSON object'];
  const { schema, manifest_sha256: reportSha, entries } = report as Record<string, unknown>;
  if (schema !== REPORT_SCHEMA) return [`the report schema is ${JSON.stringify(schema)}, expected ${REPORT_SCHEMA}`];
  if (reportSha !== manifestSha256) {
    return [
      `the report was made from another manifest (manifest_sha256 ${JSON.stringify(reportSha)}, current ${manifestSha256}). ${PRODUCE_REPORT}`,
    ];
  }
  if (!Array.isArray(entries)) return ['the report has no entries array'];
  const problems: string[] = [];
  const rust = new Map<string, Record<string, unknown>>();
  for (const entry of entries as unknown[]) {
    const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const path = row.path;
    if (typeof path !== 'string') {
      problems.push(`a report entry has no path: ${JSON.stringify(entry)}`);
      continue;
    }
    if (rust.has(path)) problems.push(`${path}: listed twice in the report`);
    rust.set(path, row);
    const { verdict, code, digest } = row;
    const wellFormed =
      (verdict === 'accepted' && typeof digest === 'string' && code === undefined) ||
      (verdict === 'rejected' && typeof code === 'string' && digest === undefined);
    if (!wellFormed) problems.push(`${path}: malformed report entry ${JSON.stringify(row)}`);
  }
  for (const result of results) {
    const row = rust.get(result.path);
    if (row === undefined) {
      problems.push(`${result.path}: missing from the report`);
      continue;
    }
    rust.delete(result.path);
    if (row.contract !== result.contract || row.expect !== result.expect) {
      problems.push(`${result.path}: the report lists ${String(row.contract)}/${String(row.expect)}`);
    }
    const same = row.verdict === result.verdict && row.code === result.code && row.digest === result.digest;
    if (!same) problems.push(`${result.path}: Rust ${describe(row)}, TypeScript ${describe(result)}`);
  }
  for (const path of rust.keys()) problems.push(`${path}: in the report but not in the manifest`);
  return problems;
}
