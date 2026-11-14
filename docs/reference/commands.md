# Commands

Implemented commands. [Engineering §1](../specs/06-engineering-delivery-and-operations-spec.md#1-bootstrap-and-command-scope) points to this list, and [engineering §7](../specs/06-engineering-delivery-and-operations-spec.md#7-application-command-contract) defines the commands that are still required.

| Command | Behaviour |
| --- | --- |
| `pnpm verify` | Run repository checks and their regression tests, then Rust format, clippy, tests and the S0 offline replay. |
| `pnpm verify:repository` | Run the repository integrity checks only. |
| `pnpm test` | Run the regression tests of the repository checks. |
| `cargo run --locked -p openquant-engine --bin s0-replay` | Replay the S0 fixture cases and write `local-runs/s0/report.md`. |
| `pnpm generate:spec-index` | Generate the ownership/version index from the seven front-matter blocks. |
| `pnpm generate:tree` | Generate the file map from the Git index, or files in an extracted archive. |

Each `pnpm` command runs the Node script named in root `package.json`. Each S1 pull request that implements a command adds its row here, in the same change as the command's implementation and tests. Do not add a row for a planned command.
