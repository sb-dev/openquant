---
name: openquant-financial-invariants
description: Implement or review OpenQuant financial calculations, accounting, strategy operators, risk, data timing, deterministic fixtures, and TypeScript/Rust contracts. Use for quantitative correctness, regression changes, and independent expected results.
---

# OpenQuant financial invariants

Read `AGENTS.md` and `docs/specs/02-trading-domain-and-evaluation-spec.md`, especially §§2–3 and 6–9. Read OQ-05 §7 and OQ-06 §5 for protocol and fixture ownership. Resolve paths from the repository root.

## Establish the contract

Locate the actual operator, ledger transition, metric, or protocol field. State its units, currency, scale, sign, time basis, missing-data rule, rounding policy, and supported input bounds. Do not infer financial semantics from a convenient implementation.

Use the shared Rust core for official calculations. Keep simulation, paper, shadow, and live adapters consistent where semantics apply. Do not claim simulated fills equal real execution. Reject unsupported units, operators, or data instead of approximating silently.

## Build independent evidence

Calculate a small expected result independently of the production implementation. Explain each amount and rounding step. Include opening state, market events, execution assumptions, fees, fills, final state, and provenance. Do not call the implementation to generate its own oracle.

Select relevant invariants rather than a large redundant test set. Examples include cash/position conservation after fills and costs; no double application of duplicate fills; reserved funds bounded by authority; no information used before availability; deterministic replay on fixed manifests; and consistent protocol round trips.

Exercise boundaries that can change the result: zero or negative values where supported, overflow, precision loss, partial fills, duplicates, out-of-order events, stale inputs, timezones/calendars, and instrument-specific charges. State when a case is unsupported.

Use `property-based-testing` to explore input classes and shrink failures. Use `rust-review` for safety, concurrency, panic, and boundary risks. Neither replaces independent financial fixtures.

## Review changed numbers

Compare before/after results on frozen inputs. Explain every changed expected number using the owning semantic rule. If the implementation is wrong, fix it. If the contract changes, update its owner and compatibility identity in the same reviewed change. Never regenerate golden results during tests or weaken a gate to clear a failure.

Preserve unknown broker outcomes and reconcile before resubmission. Verify account-writer fencing and mandate bounds for execution changes. Repository work must not submit broker orders or activate live authority.

## Deliver

Return the invariant, input/output units, independent expected calculation, tested edge cases, actual commands/results, and unresolved gaps. Map relevant A01–A18 requirements without claiming unimplemented acceptance.
