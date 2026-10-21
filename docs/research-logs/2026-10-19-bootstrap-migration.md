# Bootstrap source migration

Date: 19 October 2026.

## Baseline

The accepted source order is the user's Fly.io direction, Source Repository Design v1.1, then OpenQuant Design v2 for product semantics. Earlier UX, tech-stack, organisation, AICaaS, and Ink guidance apply where consistent.

Kakeibo's layout review at `75443233c474a2a4072348078c22d72d15573645` is reported by the supplied repository design. This bootstrap did not repeat the earlier whole-repository audit. The current Kakeibo owner was read as GitHub user `sb-dev` to populate CODEOWNERS.

## Migration map

| Canonical owner | Migrated requirements |
| --- | --- |
| [01 Product](../specs/01-product-design-spec.md) | Design v2 §§1, 3, 14–18; original operating cadence. |
| [02 Domain](../specs/02-trading-domain-and-evaluation-spec.md) | Design v2 §§4–5, 8–13, 16; exact A01–A18 text. |
| [03 Model execution](../specs/03-model-backed-execution-spec.md) | Design v2 §§6–7; Repository Design v1.1 §8; Pactwright delegation boundaries. |
| [04 UX/UI](../specs/04-ink-ux-ui-spec.md) | Ink UX/UI v1.1; Design v2 §14; Repository Design v1.1 §9. |
| [05 Architecture](../specs/05-system-architecture-and-data-spec.md) | Repository Design v1.1 §§4, 6–9; Design v2 §§12–14; retained data/auth/telemetry concerns from Tech Stack v1. |
| [06 Engineering](../specs/06-engineering-delivery-and-operations-spec.md) | Repository Design v1.1 §§10–16; Design v2 §17; installed-artefact verification from the Ink guide. |
| [07 Organisation](../specs/07-open-source-project-organisation-spec.md) | Organisation v1 public surfaces, curriculum, evidence, governance; corrections from Design v2 §15 and Repository Design v1.1 §§13–14. |

## Resolved conflicts

- Retain Fly.io for agent, batch, persistent paper/shadow, and isolated live execution. Do not use the superseded Cloudflare Containers baseline.
- Use five primary workspaces and two AI roles. Keep risk access persistent.
- Keep one strategy artefact, one shared Rust core, two workflow classes, one batch queue, and four shared source packages.
- Use typed strategy operators, separate run/gate/decision outcomes, activation read-back, and explicit unknown broker outcomes.
- Distinguish replay, prospective paper, shadow, and live evidence.
- Remove naming alternatives and any implication that open-source risk-control code is private.
- Use Apache-2.0 for newly authored project material, as proposed by the repository design. Preserve third-party terms and attribution.

## Bootstrap boundary

This is the repository bootstrap, not C1 implementation. It creates directory ownership guides and working repository automation. Executable application packages, dependency workspaces, Cargo, runtime schemas, deployment profiles, and release workflows arrive with verified capabilities.

The root Node/pnpm tooling supports bootstrap verification only. No empty service manifest, no-op application command, or fake passing engine test is included. The next implementation contract is [C1](../guides/c1-reproducible-core.md).

## Provenance

Nine reference documents are stored byte-for-byte under [imported](imported/README.md), with original names and SHA-256 hashes in [manifest.json](imported/manifest.json). The Ink guide has a space-free archive filename. This changes its path, not its bytes.

The imported files are historical sources. Their old layouts, examples, commands, and status claims do not override the canonical specs. External provider capabilities and CLI flags require verification at implementation.
