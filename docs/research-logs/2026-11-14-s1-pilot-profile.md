# S1 pilot profile and contract decisions

Date: 2026-11-14. Base: `main` at `a5b7f3b` (S0 merged as PR #8). Owner: OQ-02 sections 1, 3.1 to 3.6, 4 and 7; OQ-03 sections 1 to 5; OQ-04 sections 4 and 5; OQ-05 sections 3, 4, 5, 7, 8, 9 and 11; OQ-06 sections 1, 3 and 7.

Status: proposed, awaiting owner approval. Nothing in this log is implemented. The canonical specifications own the requirements. This log records the decisions, the proposed pilot values and what the owner must approve before the S1 implementation starts.

## Problem

S1 is the first connected slice: one stock, provider retrieval, frozen inputs, two proposer configurations, separate critique, evaluation through the S0 Rust core, durable official results and a small Ink/JSON view (roadmap S1, OQ-06 section 8). The pull requests P2 to P4 are built in parallel. They need frozen contracts, a frozen mission sequence and a registered pilot profile. The specifications leave the values to a registered policy. OQ-01 section 4 says that monetary values from examples are not defaults. Every number below is therefore a proposal for this pilot only.

## Decisions

Each decision is stated in its owning section in the same change as this log.

| # | Decision | Owner |
| --- | --- | --- |
| D1 | Keep `evaluation-input/1` and its tag; add a provider source value to its dataset reference under an A18 note (no number changes); an outer `evaluation-request/1` binds the other run identities. S4 needs `evaluation-input/2`. | OQ-05 §7, OQ-02 §7 |
| D2 | Engine identity is unchanged; connected envelopes are outside it. Derived evidence carries a separate method identity, pinned by a golden test and bound into payloads, submission and release identity. Engine-scope schemas are pinned by SHA-256. The workspace package version is not changed. | OQ-02 §7, OQ-05 §§7, 11 |
| D3 | Connected envelopes form a separate contract set with shared connected-common codes, one additive fixture manifest, a route manifest and one reviewed transition table. | OQ-05 §§3, 4, 7; OQ-03 §4 |
| D4 | The Rust core computes the S1 metrics with exact arithmetic, one half-even rounding and zero tolerance; benchmarks are cash and same-stock buy-and-hold; uncertainty is a recorded limitation; a Rust `assess` job writes the gate report. | OQ-02 §3.6, OQ-03 §1, OQ-05 §3, OQ-04 §5 |
| D5 | Each numerical outcome maps to a run status and gate treatment; worker death and lease expiry fence a new attempt up to an attempt cap. | OQ-02 §3.6, OQ-05 §4 |
| D6 | Runner failures map to the seven execution outcomes; a crash fences a new attempt; a late completion is rejected and recorded. | OQ-03 §§4, 5 |
| D7 | A proposer configuration is an executor profile plus a bundle hash; two proposer models, one critic profile, one zero-method baseline bundle; each model's published knowledge cutoff is recorded. | OQ-03 §2, OQ-02 §1 |
| D8 | Proposal path: TypeScript parse, API checks, Rust validation, `DRAFT`, one critique, treatment, `DRAFT` to `EVALUATING` Decision; only `APPROVED` writes runs, reservations and outbox entries; blocking categories gate `EVALUATING` to `PAPER` eligibility; no paper promotion before M2. | OQ-02 §§3.3, 4; OQ-03 §3 |
| D9 | The proposed strategy is the full `strategy-artefact/1` content minus API-assigned identity, version and hashes; an unresolved list blocks registration; rule differences are checked in TypeScript and recomputed in Rust. | OQ-03 §§3, 4 |
| D10 | TypeScript validation mirrors the Rust contract layer step by step; semantic codes stay in Rust and the deferred count is asserted. | OQ-05 §7 |
| D11 | pnpm workspace, Turborepo without cached results in verification, strict TypeScript, Biome, Vitest with no empty suites, schemas bundled and bindings generated at build. | OQ-06 §1 |
| D12 | App-issued tokens; 15-minute operator access token through `openquant login`; scoped service principals; attempt-scoped claim capability; a coding session holds at most a Viewer credential. | OQ-05 §9 |
| D13 | Fly hosts upload through attempt-scoped Hono routes; the Worker verifies hashes and writes content-addressed R2 keys; no R2 or database credentials on Fly in S1; one minimum-scope Queues consumer token. | OQ-05 §5 |
| D14 | The Rust normaliser writes bar and action availability into the manifest; the Rust `evaluate` job builds and uploads the inner input; the API checks that windows, cutoff and policy equal the request. | OQ-05 §§4, 7.1 |
| D15 | No Durable Object in S1; bounded polling with authoritative read-back. | OQ-05 §8 |
| D16 | One egress module in the batch binary with an HTTPS host, method and path allowlist and no redirects; probe evidence of refusals; the authority probe reads the live account host once and places no order. | OQ-05 §5 |
| D17 | Staging may use real read-only market data through a paper key and bounded real-model runs, labelled with mode and `STAGING`. | OQ-06 §3 |
| D18 | S1 cohort gates and the expected outcome `NO_ELIGIBLE_CANDIDATE`. | OQ-02 §§3.1, 3.2 |
| D19 | The operator registers the daily swing seed; each proposer configuration authors one controlled revision. | OQ-03 §1 |
| D20 | The comparison, including H runs, is registered before evaluation; H runs are dispatched after freeze; H consumption is recorded; H is labelled "historical holdout within model training period"; requests carry holdout exclusions. | OQ-02 §3.3, OQ-03 §§1, 4 |
| D21 | Mission status `ACTIVE`, `BLOCKED`, `WITHDRAWN`, `CONCLUDED` with outcome `ELIGIBLE_FOUND` or `NO_ELIGIBLE_CANDIDATE`; retrieve, validate and assess are typed jobs, not runs or trials. | OQ-02 §1, OQ-04 §4 |
| D22 | The per-attempt cap is reserved before dispatch; executor cost is estimated; a missing report keeps the reservation; lease expiry releases nothing until termination is confirmed. | OQ-03 §§1, 5 |
| D23 | `deploy.yml` writes, reads back and records a release identity manifest; the Neon project and roles are operator-created and verified by read-back. | OQ-06 §3, OQ-05 §11 |

## Pilot profile

Every number in this section is proposed, not a default (OQ-01 section 4). The owner approves or changes each one. The approved values go into versioned profile, cohort-policy and budget records through Steward commands. They do not go into code.

### Market, instrument and data

| Item | Proposal |
| --- | --- |
| Stock | AAPL. US equities, USD, America/New_York regular sessions. |
| Instrument identity | `instrument_id` = `alpaca:` followed by the Alpaca asset ID, recorded with its effective date. The ticker is a separate mapping. |
| Feed | Alpaca SIP historical daily bars, raw (unadjusted), with a request end time at least 15 minutes old. A failed SIP entitlement probe blocks the profile. IEX would be a new profile version, never a silent fallback. |
| Session semantics | The provider probe compares 1Day bars with regular-hours minute bars and records the session semantics before the profile is enabled. |
| Bar availability | `available_at` = session close + data-ready delay. Proposed delay: 120 minutes (proposed, not a default). On an early-close day the delay runs from the early close. Every bar is then available before the next open. |
| Corporate-action availability | See "Dividend and split availability" below. Actions are never excluded. |
| Information cutoff | The `available_at` of the last scored bar of the run (close of the scored end + 120 minutes, proposed, not a default). |

### Dividend and split availability

The rule needs a named provider field and an evidenced bound no later than the ex-date open.

- Field: the declaration (announcement) date of each cash dividend and split, as the provider reports it. The market-data corporate-actions response is the first candidate. Its field name is not yet verified. The provider probe must confirm the field from a real response. If only the Trading API announcements endpoint returns it, its read must be added to the D16 allowlist, which is an owner decision.
- Bound: `available_at` = the open of the ex-date session. This is the latest instant the core accepts for an action that takes effect before that open, so the simulation never knows the action earlier than the ex-date. The bound is valid for an action only when its evidenced declaration date is strictly before the ex-date.
- Block rule: if any cash dividend or split whose ex-date lies in a run lacks the field, or its declaration date is not before the ex-date, the profile is blocked. Do not substitute a fixed offset, the record or process date, or the retrieval time. Unknown availability stays unknown (OQ-02 section 1.1).
- Payment: `payment_session` = the payable date if it is a session, else the next session. `payment_phase` = `AFTER_CLOSE` (proposed, not a default). Withholding = 0 bps (proposed, not a default).
- A run's calendar includes the payment session of every dividend whose ex-date lies in the run, also after the scored end. These sessions count towards the 400-session limit.

### Windows

The windows are rules. They are resolved against the frozen retrieved calendar when the mission starts and recorded in the evaluation plan before any run. The dates below are the rules, not resolved sessions.

| Window | Scored range rule (proposed, not a default) |
| --- | --- |
| D (development) | All regular sessions of calendar year 2023. |
| V (validation) | All regular sessions of calendar year 2024. |
| H (holdout) | All regular sessions of calendar year 2025, ending 2025-12-31. |

- Warm-up: the 60 sessions immediately before each scored start (proposed, not a default). The seed's maximum lookback is 50 sessions (SMA50). Rust validation rejects a revision whose maximum lookback is above 60.
- Each run: warm-up, scored range and any dividend payment sessions after the scored end, at most 400 sessions. Each window gives about 250 scored sessions, so each run is well inside the limit. A warm-up may overlap an earlier window's scored range; scored ranges do not overlap.
- Each window is its own run with a fresh ledger, for the base case and the cost-stress case.

### Execution policy

| Item | Proposal (proposed, not a default) |
| --- | --- |
| Initial capital | 100,000 USD per candidate ledger. |
| Lots | Whole shares: `quantity_scale` 0, `lot_size` 1. |
| `price_scale` | The smallest scale that holds every OHLC price of the frozen dataset exactly. Expected: 2. Provider prices are never rounded to fit. A scale of 3 or 4 is accepted only after the S1 overflow test for AAPL-magnitude synthetic data passes at that scale. A scale above 4 blocks the profile. Reason: S0 interpretation 27 reports that the seed strategies fit in the S0 fixtures (price scale 2), and that a mean of ratios overflows from 10 sessions at 2 decimals and from 7 at 4. The S1 test runs the seed on AAPL-magnitude synthetic data at the chosen scale in every case. |
| `money_scale` | The larger of 2 and `price_scale` (the core requires at least `price_scale` + `quantity_scale`). |
| `diagnostic_scale` | 4. |
| Cost model | `fixed_plus_bps@1`. `fixed_fee_per_fill` 0 USD. `fee_bps` 5, a declared allowance for half-spread, opening-auction deviation and regulatory sale fees. `gap_exit_slippage_bps` 10. |
| Cost stress | Multiplier 2 on every cost parameter: `fee_bps` 10, `gap_exit_slippage_bps` 20, fixed fee 0. |
| Corporate actions | `split_cash_dividend_ex_date@1`, as in S0. |
| Metric scale | `metric_scale` 6 for every non-integer metric. Counts are integers. |
| Permitted operators | `daily-long-only-seed@1`. Parameter bounds: any indicator window, lag or constant that the S0 validator accepts, with a maximum lookback of at most 60 sessions. A controlled revision changes entry rules or exit rules, not both. |

### Benchmarks and gate thresholds

| Gate or benchmark | Proposal (proposed, not a default) |
| --- | --- |
| Buy-and-hold | Same stock. The largest whole-share quantity whose notional plus the run's fee fits the initial capital, bought at the first open of the scored range. It pays the run's cost model on that one fill (base or stress), is marked at the final close and is not sold. Corporate actions as in the run. |
| Cash | Initial capital held as cash; return 0. |
| Excess over buy-and-hold | `PASS` when the excess return is above 0 in each of D, V and H, under base costs. Otherwise `FAIL`. |
| Cash threshold | Part of the same gate: net return above 0 in each window. |
| Walk-forward | `PASS` only when every window passes on its own. No averaging across windows. |
| Minimum trade count | At least 10 closed trades in each scored window. Fewer gives `INSUFFICIENT`. Open positions at the end do not count. |
| Cost stress | `PASS` when the excess and cash thresholds still hold in each window with costs multiplied by 2. |
| Deterministic replay | A second evaluation of each candidate's D base run gives an equal result digest. |
| Accounting reconciliation | The ledger reconciles exactly (tolerance 0) under the method text. |
| Point-in-time data | Every bar and action has an availability time from the rules above, and no run fails with `FUTURE_DATA`. |

### Agent configurations

| Configuration | Proposal |
| --- | --- |
| Proposer A | `claude-opus-5-5`, baseline bundle, effort setting E. |
| Proposer B | `claude-sonnet-5-5`, baseline bundle, effort setting E. |
| Critic | `claude-opus-5-5` in its own profile and sessions, baseline bundle, effort setting E. Alternative: `claude-sonnet-5-5`. |

- Both proposers use the same bundle and effort setting, so the comparison differs only in the model. The owner chooses E. The requested value is recorded; the applied value is recorded when the executor reports it, else it stays unknown.
- The critic shares its model with one proposer whichever option is chosen. A separate session gives process separation, not independent judgement (OQ-03 section 1).
- Knowledge cutoffs: recorded at approval time from the provider's published model documentation, with the source and the date read. This log states none.
- Executor: the pinned Claude Code CLI version is set when the P4 schema-output spike passes. The plan records version 2.1.325 in the development container as a candidate. The real executor probe uses the production bundle with tools denied.

### Budgets and limits

All values are proposed, not defaults. Retries and recovery attempts consume budget.

| Item | Per mission |
| --- | --- |
| Candidates (registered Strategy Versions) | 3: the seed and one revision per proposer configuration. |
| Revisions (proposals) | 2 per proposer configuration. A second proposal is made only after the first fails validation. |
| Experiments (evaluation runs) | 21: 3 candidates x 3 windows x 2 cost cases, plus one deterministic-replay repeat per candidate. A repeat uses the same input, so it is not a new trial. |
| Model spend | 50 USD, estimated. Each agent attempt reserves 5 USD before dispatch. |
| Provider requests | 60, including pagination and retries. The provider probe has its own bound in P6. |
| Compute | 120 Machine-minutes for batch jobs and 120 for the agent runner. |
| Attempt cap | 3 attempts per logical run or job (the first and 2 recovery attempts). |
| Per-attempt timeout | Agent attempt 15 minutes. Batch `retrieve` and `evaluate` 10 minutes; `validate` and `assess` 5 minutes. P3 replaces the batch values with the measured worst-case 400-session time plus a margin, and derives the lease and queue visibility from it. |
| Output limit | Agent standard output 512 KiB; a longer output is a malformed result. Bounded diagnostic text 64 KiB. Each uploaded batch artefact 8 MiB. |
| Concurrency | At most 2 batch attempts and 2 agent attempts at a time. |
| Period cap (staging) | 100 USD model spend and 120 provider requests per calendar month across missions. |

## Expected S1 outcome

Under D18, parameter sensitivity, execution delay and adverse regimes stay `INSUFFICIENT`. These are required robustness checks, so no candidate can become eligible. The expected outcome is a valid mission with status `CONCLUDED` and outcome `NO_ELIGIBLE_CANDIDATE`. A valid outcome still needs every planned run completed or explained, the findings and their treatment recorded, H consumption recorded, and budgets reconciled. Offline fixtures under a separate test policy cover the `PASS` path.

Two properties of the pilot also make eligibility unlikely, independently of the gates:

- With five slots and one stock, the seed invests at most about one fifth of its cash. Excess return over a fully invested buy-and-hold mostly measures this lower exposure. Exposure is reported beside it. Sizing is neither an entry nor an exit rule, so a controlled revision does not change it.
- A daily swing seed on one stock may close fewer than 10 trades in a year. The minimum trade count then gives `INSUFFICIENT`.

## Alternatives considered

- A new `evaluation-input/2` for provider runs. Rejected for S1: it would change engine identity and every S0 fixture. The provider source value is the only change, under an A18 note.
- Uncertainty from a bootstrap or similar method. Rejected for S1: OQ-02 section 3.6 defines no method. Adding one is a later specification change.
- An IEX fallback when SIP is unavailable. Rejected: it changes data semantics silently. IEX would be a new profile version.
- One long development window. Rejected: each run is limited to 400 sessions. Three calendar years keep each run well inside the limit.
- A Durable Object for live updates. Deferred: bounded polling with read-back is enough for S1 (D15).

## Compatibility

- Engine identity and every S0 fixture stay byte-identical. The provider source value is the only engine-scope schema change, under an A18 note.
- No acceptance identifier changes. A01 to A18 and R01 to R10 keep their wording and order.
- Specification versions: OQ-02, OQ-03, OQ-05 and OQ-06 to 1.4.0 and OQ-04 to 1.3.0 (compatible new requirements).

## Risks

- Alpaca may not supply an evidenced declaration date for dividends. The profile is then blocked until another evidenced source exists.
- Batch egress: if neither operating-system enforcement nor the agreed probe evidence is accepted, provider enablement stays blocked (OQ-05 section 5).
- Claude Code may not enforce the recursive role schema. The fallback is host-side validation of text JSON.
- H lies inside the training period of the configured models. H is not a contamination-free holdout.
- Platform facts not yet verified: Queues visibility limits, Hyperdrive transactions, Workflows test support, Fly egress controls, Alpaca endpoints, fields and entitlements.

## Owner approval

The owner must approve, or change, each item before P2 to P4 start:

1. Decisions D1 to D23 as stated in the specification patches.
2. The specification version changes listed under Compatibility.
3. The data rules: SIP raw daily bars, the 120-minute data-ready delay and the information cutoff rule.
4. The dividend and split availability rule, the payment phase, zero withholding and the block rule; and whether a Trading API announcements read may join the allowlist if the market-data response lacks the declaration date.
5. The D, V and H window rules and the 60-session warm-up.
6. The execution policy: capital, lots, the `price_scale` rule, `money_scale`, costs, the cost-stress multiplier and `metric_scale`.
7. The cohort policy D18 and its thresholds: the benchmarks, the excess and cash thresholds, the walk-forward rule, the minimum trade count, and the expected outcome `NO_ELIGIBLE_CANDIDATE`.
8. The agent configurations: the two proposer models, the critic model and the effort setting E.
9. The per-mission budgets, the attempt cap, the timeouts, the output limits, the concurrency and the staging period cap.

## Verification

This change edits documents only. The specification index was regenerated with `node scripts/generate-spec-index.ts`. The repository check result is in the pull request. No implementation, provider call, model call or deployment was run for this log.
