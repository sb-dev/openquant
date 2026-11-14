# Commands

Implemented commands. [Engineering §1](../specs/06-engineering-delivery-and-operations-spec.md#1-bootstrap-and-command-scope) points to this list, and [engineering §7](../specs/06-engineering-delivery-and-operations-spec.md#7-application-command-contract) defines the commands that are still required.

| Command | Behaviour |
| --- | --- |
| `pnpm verify` | Run repository checks and their regression tests; Rust format, clippy, tests, the S0 offline replay and the contracts report; then check the installed dependencies against `pnpm-lock.yaml` and run Turborepo typecheck, lint, test and build without cached results, and the workspace checks and their tests. Needs Node 24 and `pnpm install --frozen-lockfile` first; it never installs. |
| `pnpm verify:repository` | Run the repository integrity checks only. |
| `pnpm verify:contracts` | Run the TypeScript and Rust contract parity test. It needs `local-runs/contracts/report.json` from the Rust contracts report and fails without it. |
| `pnpm test` | Run the regression tests of the repository checks. |
| `cargo run --locked -p openquant-engine --bin s0-replay` | Replay the S0 fixture cases and write `local-runs/s0/report.md`. |
| `cargo run --locked -p openquant-contracts --bin contracts-report -- --out local-runs/contracts` | Write the Rust contract-layer verdict, code and digest of every protocol fixture to `local-runs/contracts/report.json`. |
| `pnpm generate:spec-index` | Generate the ownership/version index from the seven front-matter blocks. |
| `pnpm generate:tree` | Generate the file map from the Git index, or files in an extracted archive. |

Each `pnpm` command runs the script named in root `package.json`. Each S1 pull request that implements a command adds its row here, in the same change as the command's implementation and tests. Do not add a row for a planned command.
