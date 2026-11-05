---
name: ml4t-define-universe
description: Define versioned watchlists and point-in-time research universes while preserving identity, membership history and delistings.
---

# Define the research universe

Read OQ-02 §1.1 and §3 in `docs/specs/`. Distinguish an operator-selected watchlist from a historical investable universe. A fixed current watchlist is valid for its stated task but does not establish an unbiased historical market sample.

## Define membership

1. Use stable instrument IDs. Keep ticker, exchange, share class and company-ID mappings with effective dates; symbols may change or be reused.
2. Freeze the watchlist version when a cycle starts. Edits change future cycles and never erase older members or outcomes.
3. If claiming a historical universe, use membership and eligibility information available at each decision time. Retain delisted, acquired and failed securities.
4. Predeclare liquidity/history/price filters and rebalance timing. Sort observations and apply availability cutoffs before computing trailing metrics. Do not use future membership or current financial snapshots.
5. Record coverage exclusions and unknown historical search/selection. Missing data must not silently remove difficult or unsuccessful instruments.

## Handle exits honestly

Use documented corporate-action treatment and actual proceeds where supported. Do not assign fixed bankruptcy, acquisition or going-private returns by category. Missing terminal values produce an explicit gap or a declared conservative bound with sensitivity evidence, not fabricated cash flows.

## Verify

Exercise additions/removals, ticker changes/reuse, multiple share classes, delisting, incomplete history and future membership contamination. Show that past cycle hashes and results survive watchlist edits. Keep prospective watchlist evidence separate from claims about survivorship-free historical selection.

Adapted from ML4T skills at revision `691857537a0c8befc11dc2f2ad7a458b7c7e801c`. Original Apache-2.0 licence and attribution remain in `.claude/third-party/ml4t/skills`. OpenQuant adaptation: 2026-11-05.
