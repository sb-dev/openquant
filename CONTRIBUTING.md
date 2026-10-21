# Contributing

OpenQuant accepts code, strategies, tests, benchmarks, documentation, teaching material, integrations, and reproducibility reports.

## Choose the change level

| Level | Requirement |
| --- | --- |
| Local improvement | Preserve behaviour; explain the correction. |
| Implementation | Cite the existing owning spec and its acceptance evidence. |
| Canonical change | Update the owning spec, compatibility decision, and affected tests before acceptance. |

Read the [spec index](docs/specs/README.md). Keep changes small enough to review. Introduce dependencies only for a demonstrated need. New code must respect the architecture boundaries.

Strategy contributions need a hypothesis, immutable artefact, data requirements, assumptions, evaluation configuration, known failure modes, licence, and attribution. A strategy need not be profitable to be useful.

Benchmark contributions need a purpose, reproducible inputs, independent expected invariants, and licence information. Integration contributions need capabilities, failure semantics, compatibility, configuration, and tests. Broker/live integration changes also need the domain and operational gates.

## Verify

```bash
pnpm verify
```

The bootstrap can also use `node scripts/verify.ts` with no dependency install. See [scripts](scripts/README.md) for the exact scope.

Regenerate spec metadata and the repository file map when needed. In a Git checkout, stage intended added and removed paths before generating the map. Do not stage secrets or local output.

New executable packages must add their required checks. C1 must include real Rust fixture evaluation and a clean installed demo. A mock or screenshot cannot satisfy those gates.

## Commit and review

Inspect repository guidance and recent commit history before committing. Use:

```text
<type>: <imperative summary>
```

Allowed types are `feature`, `fix`, `docs`, and `chore`. Explain what changed and why. Cite the owning specification section where relevant.

AI-authored commits end with exactly one co-author trailer naming the verified model and its provider noreply address. Do not guess identity or add session links.

PRs describe the problem, resulting behaviour, owning requirement, checks actually run, and remaining limits. Do not label a skipped, failed, or unavailable check as passed.

The maintainer decides releases and canonical changes. Material architecture or methodology decisions use a concise research log. A solo maintainer does not constitute independent human review. Governance and publication rules are in [spec 07](docs/specs/07-open-source-project-organisation-spec.md).
