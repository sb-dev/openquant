# TypeScript Ink operator client

Status: S1 direct commands implemented (`openquant`, Node 24, Ink); the persistent terminal and `openquant demo` are not. Owner: [04-ink-ux-ui-spec.md](../../docs/specs/04-ink-ux-ui-spec.md).

The [CLI reference](../../docs/reference/cli.md) lists the commands, their output and their exit codes.

| Path | Holds |
| --- | --- |
| `src/cli.ts` | Argument parsing, the commands, and output: Ink in a terminal, plain text on a pipe, one JSON document with `--json`. |
| `src/ui.ts` | Ink components: the static report, the confirmation dialog, and `mission watch`. |
| `src/format.ts`, `src/context.ts` | The text of each view and the operating context (environment, mode, simulated account, risk `UNKNOWN`). |
| `src/text.ts` | Sanitising, terminal width and wrapping within 80 columns. |
| `src/outcome.ts` | Exit codes and error reports. |
| `src/store.ts`, `src/session.ts` | The 0600 credentials file, the journal of commands with an unknown outcome, and token renewal. |
| `tools/bundle.ts` | The build of `dist/openquant.mjs`. |

Rendering, input, focus and local presentation state live here; the API is reached only through `@openquant/api-client` (Hono is the only remote boundary). The tests use fakes of the API and a loopback HTTP server for the built binary; `apps/api/test/client.test.ts` runs the client against the real API on PostgreSQL. Nothing here is deployed or published.
