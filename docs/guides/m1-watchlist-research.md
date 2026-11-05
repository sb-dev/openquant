# M1 — Automated watchlist research

Status: implementation required. No commands below are advertised as available.

## Outcome

An operator selects sources, a watchlist, calendar and budgets. OpenQuant runs competing research, records evidence and continues without an open terminal. Follow S1–S5 in the [roadmap](../product/roadmap.md#m1-vertical-slices).

## Build and demonstrate

1. Deliver S1 through one complete one-stock mission: provider retrieval, immutable dataset, two proposer configurations, separate critique, registered evaluation, real Rust result, durable API read-back and a small Ink/JSON view. Add strict TS/Rust tooling, cross-runtime schemas and independently calculated financial fixtures with this path.
2. In S2 add Massive behind the same market contract. Select the source in a versioned research profile. Demonstrate switching without workflow changes and an explicit [provider comparison](provider-comparison.md).
3. In S3 retrieve SEC filings and Tavily sources through bounded application tools. Store provenance, exclude evidence that violates the cutoff, and show partial retrieval. Evaluate citation fidelity and resistance to instructions embedded in source text. A current page is not proof of its historical contents.
4. In S4 freeze watchlist membership and budget allocation for every cycle. Display every member's result or reason for missing coverage. Preserve old cycles when the watchlist changes.
5. In S5 add stored schedule slots and bounded catch-up, pause/resume and explicit cancellation. Verify recovery without clients, provider/model cost reservations, conservative unknown usage and fairness across stocks. Supply subsequent missions with permitted prior findings and retain lineage/holdout consumption.

## Acceptance handoff

Use [engineering §8](../specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance). Each slice records its implemented path, deterministic checks, live provider/executor probes, deployed identities, adverse cases and remaining limits. A recorded response cannot establish live service access.

M1 is complete only after all five outcomes and their operating evidence exist. A small UI is sufficient, but its commands still need authoritative read-back, explicit failure/pending states and the applicable A15 checks. No live orders are permitted. The [installed replay gate](public-cli-replay.md) remains required for public CLI release.
