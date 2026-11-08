# M1 — Automated watchlist research

Status: implementation required. No commands below are advertised as available.

## Outcome

An operator selects sources, a watchlist, calendar and budgets. OpenQuant retains per-stock research and evaluates complete watchlist strategies with shared strategy cash and slots. It records evidence and continues without an open terminal. Follow S1–S5 in the [roadmap](../product/roadmap.md#m1-vertical-slices).

## Build and demonstrate

1. Deliver S1 through one complete one-stock mission: provider retrieval, immutable dataset, two proposer configurations, separate critique, registered evaluation, real Rust result, durable API read-back and a small Ink/JSON view. Include the [daily swing seed](../specs/02-trading-domain-and-evaluation-spec.md#26-daily-swing-seed-family) and a controlled revision. Show source interpretation changes and parent differences. Add strict TS/Rust tooling, cross-runtime schemas and independent indicator, timing, sizing and position-state fixtures with this path.
2. In S2 add Massive behind the same market contract. Select the source in a versioned research profile. Demonstrate switching without workflow changes and an explicit [provider comparison](provider-comparison.md).
3. In S3 retrieve SEC filings and Tavily sources through bounded application tools. Store provenance, exclude evidence that violates the cutoff, and show partial retrieval. Evaluate citation fidelity and resistance to instructions embedded in source text. A current page is not proof of its historical contents.
4. In S4 freeze watchlist membership and allocate budgets to both stock and joint work. Display every member's outcome. Use a bounded strategy-level mission over the same snapshot, then evaluate one policy with ranking, five slots and shared strategy cash through Rust. Run the [four-candidate comparison](../specs/02-trading-domain-and-evaluation-spec.md#37-controlled-seed-comparison) on common dates and inputs. Inspect joint results, contributions and skipped entries. Required missing data blocks joint evidence; other stock findings remain saved. Preserve old cycles when membership changes.
5. In S5 add stored schedule slots and bounded catch-up, pause/resume and explicit cancellation. Verify recovery without clients, shared provider/model/compute reservations and conservative unknown usage. Resume joint state including pending entries and scheduled stops. Supply later missions with permitted prior findings for bounded revisions; retain failed variants, lineage and holdout consumption.

## Acceptance handoff

Use [engineering §8](../specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance). Each slice records its implemented path, deterministic checks, live provider/executor probes, deployed identities, adverse cases and remaining limits. A recorded response cannot establish live service access.

The joint replay must demonstrate slot competition, input-order independence, common valuation dates, causal cash reuse, exact rounded-fill accounting and restart equivalence. Expected financial results come from independent calculations. This gate checks the complete policy inside one strategy; cross-strategy capital allocation remains M3.

M1 is complete only after all five outcomes and their operating evidence exist. A small UI is sufficient, but its commands still need authoritative read-back, explicit failure/pending states and the applicable A15 checks. No live orders are permitted. The [installed replay gate](public-cli-replay.md) remains required for public CLI release.
