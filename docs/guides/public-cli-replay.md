# Public CLI release — Reproducible replay

Status: implementation required. This is the public CLI release gate. M1 private research can be delivered first. Reuse S0's shared Rust core, toolchain and numerical fixtures; S0 completion does not satisfy this gate.

## Outcome

A clean installed `openquant demo` evaluates a bundled strategy with the shared Rust core and shows its result in Ink or JSON. It needs no cloud, model, market-data, or broker credentials. Its mode is `REPLAY`.

## Build

1. Reuse S0's Cargo workspace and pinned Rust toolchain. Add or extend the pnpm/Turborepo workspace for implemented CLI packages. Pin tested toolchains and commit generated lockfiles. Add the required strict type checks, formatting, lint and tests to `pnpm verify`.
2. Reuse the reviewed strategy operators and deterministic event ordering from S0. Define or reuse the decimal wire values, schema versions and shared valid/invalid protocol fixtures required by the CLI boundary. Reject unsupported behaviour.
3. Reuse S0's synthetic inputs and independent expectations in a small versioned example pack. Add any missing release cases for fills, fees, cash, positions, return and risk rejection. Include the manifest, licence, expected invariants and fixed seed where needed.
4. Connect a thin local host to the same Rust core. Verify exact ledger outcomes and declared statistical tolerances through the CLI path. Reuse the missing-data, future-data and invalid-operator failure cases.
5. Implement the Ink presentation runtime and direct JSON command path. Display actual engine output, recorded proposal labels, input identities, and failed outcomes. Test focus, resize, no colour, ASCII, non-TTY output, and terminal cleanup.
6. Pack and install the CLI and matching native engine in a clean environment. Run the real demo on the supported Linux/macOS targets. Check the release allowlist and prohibit unpinned runtime downloads.
7. Extend credential-free CI to execute these checks. Publish the runnable example and concise guide with the verified result.

## Acceptance

Use [A03–A05, A15–A16](../specs/02-trading-domain-and-evaluation-spec.md#9-acceptance-and-preservation-of-results), plus R01–R04 and any applicable release checks in [engineering §8](../specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance).

Record exact commands, revisions, expected results, observations, and remaining gaps. Do not treat agreement between two paths using the same calculation as an independent financial baseline. A mocked success screen does not satisfy this release gate.
