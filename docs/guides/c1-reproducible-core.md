# C1 — Reproducible core

Status: implementation required. This guide defines the next complete checkpoint.

## Outcome

A clean installed `openquant demo` evaluates a bundled strategy with the shared Rust core and shows its result in Ink or JSON. It needs no cloud, model, market-data, or broker credentials. Its mode is `REPLAY`.

## Build

1. Create the explicit pnpm/Turborepo and Cargo workspaces for the implemented packages. Pin tested toolchains and commit generated lockfiles. Add strict type checks, formatting, lint, and tests to `pnpm verify`.
2. Define the first supported strategy operators, decimal wire values, deterministic event ordering, schema versions, and shared valid/invalid protocol fixtures. Reject unsupported behaviour.
3. Add one small synthetic example pack with documented independent calculations for fills, fees, cash, positions, return, and risk rejection. Include inputs, manifest, licence, expected invariants, and fixed seed where needed.
4. Implement the shared Rust calculations and a thin local host. Verify exact ledger outcomes and declared statistical tolerances. Add missing-data, future-data, and invalid-operator failures.
5. Implement the Ink presentation runtime and direct JSON command path. Display actual engine output, recorded proposal labels, input identities, and failed outcomes. Test focus, resize, no colour, ASCII, non-TTY output, and terminal cleanup.
6. Pack and install the CLI and matching native engine in a clean environment. Run the real demo on the supported Linux/macOS targets. Check the release allowlist and prohibit unpinned runtime downloads.
7. Extend credential-free CI to execute these checks. Publish the runnable example and concise guide with the verified result.

## Acceptance

Use [A03–A05, A15–A16](../specs/02-trading-domain-and-evaluation-spec.md#9-acceptance-and-preservation-of-results), plus R01–R04 and any applicable release checks in [engineering §8](../specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance).

Record exact commands, revisions, expected results, observations, and remaining gaps. Do not treat agreement between two paths using the same calculation as an independent financial baseline. A mocked success screen does not complete C1.
