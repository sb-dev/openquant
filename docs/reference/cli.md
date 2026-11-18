# Operator CLI

`openquant` is the S1 operator command line (`apps/cli`). It talks to the API only through the typed client `@openquant/api-client`, which reads its routes from the [route manifest](../../packages/api-contracts/routes/v1.json) and validates every answer with the shared contracts. The persistent terminal of [OQ-04 §2](../specs/04-ink-ux-ui-spec.md#2-navigation-and-shell) (`openquant` without a command) and `openquant demo` are not implemented: without a command the CLI prints its usage and exits 2.

Build and run it with Node 24:

```sh
pnpm --filter @openquant/cli run build
node apps/cli/dist/openquant.mjs --help
```

The build is one ES module with Ink and React inside; it needs no `node_modules`. No API is deployed yet: the CLI has been run only against the API test app and loopback fakes.

## Output

Every result starts with the operating context ([OQ-04 §2](../specs/04-ink-ux-ui-spec.md#2-navigation-and-shell)):

```text
OpenQuant | env DEV | mode BACKTEST | money SIMULATED | tz UTC
account: simulated per-candidate ledger (no broker account)
risk: UNKNOWN - no risk evaluation covers research candidates in S1
read at: 2026-11-15T10:00:00Z
```

- `env` is `DEV`, `STAGING` or `PROD`, from the API's `system.identity` at login, or `UNKNOWN` before login.
- S1 runs research only: every mission run is a `BACKTEST` on a simulated per-candidate ledger, and nothing evaluates risk, so risk is `UNKNOWN` with that reason, never `OK`.
- `read at` is when the CLI read the authoritative state shown.

Values are shown as the API states them, with their units; nothing is recomputed. A value that nothing reported is shown as `unknown`, `not recorded yet`, `pending` or `not assessed`, never as zero. S1 records no `EVALUATING` → `PAPER` Decision: `mission decisions` shows that Decision alone as `none recorded` ([OQ-04 §5](../specs/04-ink-ux-ui-spec.md#5-arena)).

All text from the API, from input files and from errors is sanitised before it is printed: control characters, escape sequences, bidirectional overrides and line separators become `?`. Lines are wrapped, never clipped, to at most 80 columns (narrower when the terminal is). In a terminal Ink renders the result; on a pipe the same lines are printed as plain text.

`--json` prints one JSON document on stdout and never renders Ink:

```json
{ "openquant_cli": 1, "command": "mission show", "outcome": "OK", "exit_code": 0,
  "context": { "environment": "DEV", "api_environment": "DEVELOPMENT", "mode": "BACKTEST", "money": "SIMULATED",
               "account": "simulated per-candidate ledger", "risk": { "state": "UNKNOWN", "reason": "..." },
               "observed_at": "2026-11-15T10:00:00Z", "time_zone": "UTC" },
  "data": { "schema_version": "mission-view/1", "...": "..." }, "error": null }
```

`data` holds the view or the command status unchanged; `error` holds `code`, `message`, `state_changed`, `retry_safe`, `next`, `diagnostic_ref` and, where they apply, `current_revision` and `violations`. JSON escapes control and bidirectional characters, so the values are exact. In text mode a failure goes to stderr.

## Credentials

`openquant login --api <url>` reads a person's long-lived credential from stdin, or asks for it without echo in a terminal, exchanges it through `auth.token` for a 15-minute access token, reads the environment and writes both to `credentials.json` in the configuration directory: `OPENQUANT_CONFIG_DIR`, else `$XDG_CONFIG_HOME/openquant`, else `~/.config/openquant`. The file has mode 0600 in a 0700 directory and is replaced whole; the CLI refuses a credentials file that other users can read. The access token is renewed with the stored credential a minute before it expires and once after `UNAUTHENTICATED`. Neither the credential nor a token is ever printed, logged or put in an error. The API address must use https; http is accepted only for `localhost`, `127.0.0.1` and `[::1]`. `OPENQUANT_API_URL` can name the address. `openquant logout` removes the file; it does not revoke the credential, which an Administrator does.

## Commands

The API decides authority on every request ([OQ-05 §9](../specs/05-system-architecture-and-data-spec.md#9-authentication-and-authority)); the roles below are the roles of the route manifest. A refused command exits 4 and names the roles it needs.

| Command | Role | Behaviour |
| --- | --- | --- |
| `login [--api <url>]` | any person | Exchange the credential for an access token and store both. |
| `logout` | | Remove the stored credential and token. |
| `budget register --file <BudgetCap.json>` | Steward | `register_budget`. |
| `profile register --file <research-profile.json>` | Steward | `register_research_profile`. |
| `policy register --file <cohort-policy.json>` | Steward | `register_cohort_policy`, which records the Steward's approval. |
| `seed register --file <seed.json>` | Researcher | `register_seed`: the file holds `draft`, `origin`, `sources` and `source_differences`. |
| `mission create --file <MissionSpec.json>` | Researcher | `create_mission`, then the mission is read back and shown. |
| `mission run-now <mission-id> [--yes]` | Researcher | `run_mission_now`, after a confirmation. |
| `mission cancel <mission-id> --reason <text> [--yes]` | Researcher | `cancel_mission`, after a confirmation. |
| `mission show <mission-id>` | any role | Status, outcome and reasons, scope, candidates, jobs, runs and attention items. |
| `mission budget <mission-id>` | any role | Budget limits, pools (limit, committed, overrun) and reservations. |
| `mission lineage <mission-id>` | any role | Strategy versions with their parents, runs, findings and Decisions. |
| `mission trials <mission-id>` | any role | Trial slots, run slots with run status, mode and environment, and proposals. |
| `mission findings <mission-id>` | any role | Critic findings and their treatment per transition. |
| `mission gates <mission-id>` | any role | Gate reports, with eligibility shown apart from the gate results. The first read of holdout observations is recorded by the API as their consumption ([OQ-02 §3.3](../specs/02-trading-domain-and-evaluation-spec.md)). |
| `mission decisions <mission-id>` | any role | Recorded Decisions, and `none recorded` for `EVALUATING` → `PAPER`. |
| `mission watch <mission-id> [--interval <s>]` | any role | Terminal only: the mission, read again every 5 to 300 seconds (10 by default), with a `Summary` and a `Budget` tab. |
| `command show <command-id>` | any role | Read a command back by its ID. |
| `command resolve <command-id>` | the sender | Settle a command whose outcome is `UNKNOWN`. |

Registrations take `--expected-revision <n>`: by default one less than the `revision` of the document (0 for a seed). `mission run-now` and `mission cancel` read the mission first and send the revision they showed, or `--expected-revision`. Every command takes `--command-id <id>` to choose its client command ID, and `--json`.

### Confirmations

`mission run-now` and `mission cancel` are medium-risk actions ([OQ-04 §13](../specs/04-ink-ux-ui-spec.md#13-confirmations-and-environments)). In a terminal the CLI shows the action, the mission and its revision as read, the effect, that it cannot be undone and the safe default, with focus on `Keep as is`. Tab, Shift+Tab, Left and Right move the focus; Enter chooses the focused button; Esc or Ctrl+C declines. A paste is never a key press. In a terminal narrower than 40 columns the dialog asks to be widened and accepts nothing else. A declined confirmation sends nothing and exits 12. Outside a terminal, and with `--json`, these commands need `--yes`; without it they send nothing and exit 2.

### Outcomes of a command

Every command gets a client command ID and is read back by it ([OQ-04 §12](../specs/04-ink-ux-ui-spec.md#12-connectivity-and-command-outcomes)):

- `APPLIED`: the record and the revision it produced are shown; `mission create`, `run-now` and `cancel` then read the mission back.
- `PENDING`: accepted and durable, not applied after a bounded read-back. `command show` reads it again.
- `REJECTED`: the API refused it. "No state changed" is printed only because the API states it.
- `UNKNOWN`: no usable answer arrived and the read-back did not find the command. The CLI keeps the exact request in `pending/<command-id>.json` (mode 0600) in the configuration directory and refuses every new command until `command resolve <command-id>` settles it: that reads the command back and, only when the API has no command with that ID, sends the identical request once more. The same ID with the same body is applied once.

A stale revision (`REVISION_CONFLICT`) is never retried with a newer revision: the CLI reads the mission again, shows it with the current revision and exits 7, and the operator decides again.

`mission watch` polls; S1 has no notification channel ([OQ-05 §8](../specs/05-system-architecture-and-data-spec.md#8-client-runtime-and-notifications)). A failed read keeps the last state on screen marked `STALE`, with the time it was read and the failure, and waits longer before each retry, up to five minutes. `q`, Esc or Ctrl+C detaches: the mission keeps running, and only `mission cancel` cancels it.

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `OK` | The read succeeded or the command was applied. |
| 1 | `INTERNAL` | The API answered `INTERNAL`, or the CLI failed. |
| 2 | `USAGE` | A bad argument or input document, a missing confirmation, or a command that needs a terminal. Nothing was sent. |
| 3 | `UNAUTHENTICATED` | Not logged in, the credential was refused, or the credentials file is unreadable or open to others. |
| 4 | `FORBIDDEN` | The caller's roles do not allow the route. |
| 5 | `NOT_FOUND` | No such mission, command or journal entry. |
| 6 | `REJECTED` | The API refused the command or the request: a policy, budget, execution or contract rule. |
| 7 | `CONFLICT` | A stale revision (the current state is shown) or a reused command ID. |
| 8 | `PENDING` | The command was accepted and is not applied yet. |
| 9 | `UNKNOWN` | The outcome is unknown, or an earlier command's outcome is unknown; run `command resolve`. |
| 10 | `UNAVAILABLE` | No answer to a read, `UNAVAILABLE` or `RATE_LIMITED`. |
| 11 | `PROTOCOL` | An answer failed its contract and was not used. |
| 12 | `DECLINED` | The operator declined the confirmation; nothing was sent. |
| 130 | `INTERRUPTED` | Interrupted (Ctrl+C at the credential prompt, or SIGINT). |
