# Native Rust host

Status: S0 local harness implemented (`s0-replay`, crate `openquant-engine`). The S1 market-data library is implemented as the `market` module: the Alpaca adapter, the normaliser that writes `dataset-manifest/1`, the enablement gate and the retrieval sequence, tested offline against synthetic provider responses. The S1 batch host is implemented as the `batch` module and the `engine-batch` binary: the egress module over the one HTTP client, the Cloudflare Queues pull consumer, the client of the attempt routes, the worker loop and the `retrieve`, `validate`, `evaluate` and `assess` jobs. It is tested end to end against fakes (a fake queue, API and provider behind the real egress module and clients) and over real TLS on the loopback interface. Nothing has run against Cloudflare, the application API, a provider or a deployed Machine: no credential exists, the Cloudflare Queues request shapes and the Alpaca endpoint shapes are reported facts that are not verified, and provider retrieval is off by default. The connected competition is not implemented; S1 is incomplete.

Thin entry points around quant-core. S0 runs the core locally through a small harness; it does not require the connected batch host. Add batch hosting and the first market adapter in S1, then the second market adapter in S2. Add live-data paper at M2, shadow validation at M3, and separately deployed live execution at M4. Market and broker adapters belong beside this host.

Tests (`cargo test -p openquant-engine`): `tests/s0_fixtures.rs` runs every S0 fixture case; `tests/compare.rs`, `tests/report.rs` and `tests/s0_replay_cli.rs` pin the comparison, the report and the exit status. `s0_replay_cli` also runs the binary on the committed fixtures with no `--case` filter and requires the index to list exactly the directories below `fixtures/s0/cases`, so a replay that silently drops cases fails the tests. `s0-replay` exits 1 on any difference or coverage problem and 2 on a usage or file error.

Expectation sections (`expect` in a case's `expected.json`): every section except one is a view of the result (`outcome`, `signals`, `entries`, `fills`, `trades`, `cash_ledger`, `daily`, `corporate_actions`, `final`), and only the fields it states are compared. `outcome_detail_includes` is an array of strings and each must be a substring of the actual `outcome.detail`, so a case can require that an `INSUFFICIENT` detail names the instrument, the event and the affected period without pinning the wording (OQ-02 section 2.5). It counts one check for the array and one per string, like any array. An absent or non-string `outcome.detail` fails every string at once, and an empty array asserts nothing. The matching is exact and case-sensitive.

The detail text comes from the shared core. It is written for a reader and the harness never parses it. It names these facts: `MISSING_REQUIRED_BAR` the instrument and the session with no bar; `UNSUPPORTED_VALUATION` the instrument, the `event_id` of every confirmed halt of the session, the first unvalued session and the last session of the scored window (`windows.scored_end`); `UNSUPPORTED_CORPORATE_ACTION` and `FRACTIONAL_ENTITLEMENT` the instrument, the `action_id` and the effective session. The result schema limits the detail to 1000 characters.

Lints: the crate inherits the workspace lint policy, so `unwrap`, `expect`, `panic`, indexing and float arithmetic are denied in the library and the binary as in the core. The integration tests allow them at their crate roots, as the core tests do.

## Market data (S1)

`src/market` holds the provider side of retrieval (OQ-05 sections 5, 7 and 7.1; OQ-02 sections 1.1, 2.5 and 2.6). It reads no environment variable, clock, file or network socket of its own: the batch host supplies the transport, the clock and the configuration.

| Module | Role |
| --- | --- |
| `provider` | The `MarketDataProvider` interface, the capabilities an adapter declares and `CallContext`, which enforces the request budget (reserved before any I/O, retries and pages included), the deadline, cancellation and the bounded retry policy outside the adapter. Every attempt is one recorded call; every successful response is kept as a source body. |
| `alpaca` | The Alpaca adapter over an `HttpTransport`: raw daily bars, regular-hours minute bars (for the session probe), corporate actions, the trading calendar and the asset record, with `next_page_token` pagination, `Retry-After`, typed errors and the exact host and path allowlist (`EGRESS_RULES`) that the egress module of the batch host must permit. Numbers are read as JSON tokens and shifted into decimal text: no float exists anywhere. |
| `http`, `error` | The transport seam (GET only, no redirect followed, credentials beside the request and printed as `<redacted>`) and the typed errors with their `retrieval-result/1` classes. A credential, a URL, a query or a response body never appears in an error, a log or a `Debug` output. |
| `normalise` | Provider data to `dataset-manifest/1`: per-session OHLCV, `available_at` = session close + the declared data-ready delay (an early close runs from the early close), a calendar with holidays, closures, early closes and daylight saving, corporate actions with `available_at` = the ex-date open only when the declaration date is strictly before the ex-date, the payment-session rule, coverage, source hashes and the price-scale rule. Its rules are in `src/market/rules.txt`, whose SHA-256 is the transformation digest. Where the evidence is missing it blocks the profile; it never substitutes a fixed offset, the record or process date or the retrieval time, and never drops an action. |
| `gate` | Provider retrieval is off by default. It runs only when `OPENQUANT_MARKET_RETRIEVAL` is exactly `enabled` and six facts are verified by a recorded probe: paper authority, no live authority, the feed entitlement, the session semantics, the egress refusals and the declaration-date field. A `RetrievalPermit` has no public constructor, so `retrieve_snapshot` cannot be called without a yes from the gate. The gate does no I/O: the delivery probes produce the evidence. |
| `session` | The pure comparison of a daily bar with the regular-hours minute bars of its session, exact and without tolerance. |
| `retrieve` | One snapshot retrieval behind the gate: asset, calendar, daily bars, corporate actions, then the normaliser. The request ends at the earlier of its range end and the clock minus the profile's minimum end age. |
| `time`, `number` | Civil dates, UTC instants and the US Eastern rule (2007 to 2099) in integer arithmetic, and exact decimal text for provider numbers. |

Tests: `tests/market_adapter.rs` (the endpoints, pagination, typed errors, retries, `Retry-After`, the budget, cancellation, redaction), `tests/market_normaliser.rs` (every normalised and blocked case against the independent oracle, and each rule at its boundary), `tests/market_gate.rs`, `tests/market_retrieve.rs` and `tests/market_session_probe.rs`, with the shared scripted transport in `tests/market_support`. The cases and the oracle are in [market-data fixtures](../../fixtures/market-data/README.md).

Limits: the endpoint paths, query names and response shapes follow Alpaca's public reference as last known and are unverified; the market-data corporate-actions response is not known to carry the declaration date or a record id, so the profile may be blocked by rule until the provider probe or another evidenced source says otherwise (the owner approved a Trading API announcements read only conditionally, and it is not built); a corporate action of any type other than a split or a cash dividend blocks the profile because no availability rule exists for it; the price scale above 4 blocks the profile and a scale of 3 or 4 needs the S1 overflow test first.

## Batch host (S1)

`src/batch` and `src/bin/engine_batch.rs` are the batch host of OQ-05 sections 4, 5, 7 and 7.1. The binary is `engine-batch`. It holds no R2 or database credential: it reads and writes only through the attempt routes of the application API ([route manifest](../../packages/api-contracts/routes/v1.json)).

| Module | Role |
| --- | --- |
| `wire` | The one HTTP client of the binary: ureq over rustls with the bundled web PKI roots. HTTPS only (the wire builds `https://` URLs and nothing else), no redirect followed (a 3xx is returned as a response), no proxy read from the environment, a bound on the whole exchange and on the response body. No other file names a socket or an HTTP crate; a test reads the source and the manifest to prove it. |
| `egress` | The only way to send a request. A rule is one exact host, method and path (a parameter is an identifier, a SHA-256 digest or a ticker, never `/`, `%`, `.` or `..`), the query keys it may carry, the largest request body and the largest response body. A request outside the rules is refused before any I/O. Each class (provider, queue, API) has its own request budget, retries included. A redirect is refused after the exchange, and only the target's host name is kept. A credential is written into a header here and appears in no log, error or `Debug` output. The adapter of the `market` module sends through it. |
| `queue` | The Cloudflare Queues HTTP-pull consumer: pull, acknowledge, give back with a delay. One minimum-scope token. |
| `api` | The client of the attempt routes: claim, read an input by digest (the bytes are hashed and compared), upload an artefact by digest, submit a result. A read, an upload and a submission are repeated up to three times after a transient failure; a claim is repeated only after a refusal that says nothing changed. |
| `worker` | The loop and its order (below). |
| `jobs` | `retrieve`, `validate`, `evaluate` and `assess`. |
| `input` | The inner `evaluation-input/1` of a provider run, built from the manifest and the request. It selects and never computes a number. |
| `journal` | The optional local checkpoint journal of a long evaluation (below). |
| `config`, `identity`, `clock`, `secret` | The environment, the executable, engine and method identities, the clocks and the redacting `Secret`. |

### Configuration

The binary reads these variables once and fails closed. An error names the variable and never its value. `engine-batch --check-config` reads them and exits.

| Variable | Meaning |
| --- | --- |
| `OPENQUANT_ENVIRONMENT` | `DEVELOPMENT`, `STAGING` or `PRODUCTION`. A message for another environment is not claimed. |
| `OPENQUANT_API_URL` | The `https://` origin of the API: a DNS name, no user information, no port, no path. |
| `OPENQUANT_API_TOKEN` | The credential of the `batch` service principal, used for the claim only. |
| `OPENQUANT_QUEUE_ACCOUNT_ID`, `OPENQUANT_QUEUE_ID` | Plain tokens. They become literal segments of the two queue paths. |
| `OPENQUANT_QUEUE_TOKEN` | The Queues consumer token. |
| `OPENQUANT_MARKET_RETRIEVAL` | Off unless exactly `enabled`. |
| `OPENQUANT_ALPACA_KEY_ID`, `OPENQUANT_ALPACA_SECRET` | A paper-account key pair, both or neither. |
| `OPENQUANT_PROVIDER_EVIDENCE_FILE` | The recorded probe evidence (`provider-evidence/1`: six facts, the recorded terms and the licence text). Anything but the word `verified` leaves a fact unverified. The delivery probes of P6 write it; this binary never does. |
| `OPENQUANT_CONCURRENCY` | 1 (default) or 2 attempts at a time. |
| `OPENQUANT_VISIBILITY_SECONDS` | The visibility timeout of a pulled message, from 60 to 43200. Default 720 (below). |
| `OPENQUANT_STOP_FILE` | A file whose existence asks the worker to stop after its current job. |
| `OPENQUANT_SCRATCH_DIR` | A directory for the checkpoint journal. Off when unset. |

### The order of the worker

1. Pull one message. A body that is not `job-dispatch/1` is given back with a delay of one hour and never acknowledged; a message for another environment is given back with five minutes.
2. Claim the attempt with `attempt-claim/1` (the dispatch digest, the digest of the running executable, a worker id). A refusal `ATTEMPT_NOT_CLAIMABLE` or `STALE_OWNERSHIP` means the attempt is not `PENDING`: it is claimed elsewhere, terminal, cancelled or fenced. The message then has no purpose, because recovery fences a new attempt with a new message when a lease ends, so the worker acknowledges it. Any other refusal gives the message back with a delay (30 seconds for a transient one, five minutes otherwise); a refused credential stops the worker.
3. Run the job under a deadline, the lease end minus 30 seconds. Read inputs by digest; upload every artefact first; submit last.
4. Acknowledge the message only after the submission was accepted. A job that ends without a result (the attempt was cancelled or fenced, the lease is about to end, the request names another engine, method, environment or attempt, an API call fails for good) leaves the message unacknowledged. A crash anywhere before the acknowledgement has the same effect, and a lost acknowledgement after a committed result gives no second result: the claim of the redelivery is refused.

The API has no lease-renewal route and no way to read an attempt's state, so the worker cannot extend a lease or learn of a cancellation by asking. It keeps its job inside the lease, and while a job runs it reads an input of its attempt every 20 seconds: that read fails with `STALE_OWNERSHIP` or `LEASE_EXPIRED` as soon as the attempt is cancelled, fenced or expired, and the job stops without a result.

### The jobs

- `retrieve`: reads the `retrieval-request/1`, asks the enablement gate, and only then runs the retrieval of the `market` module over the egress module. A blocked gate, a missing credential, a provider failure and a normaliser block are each a `retrieval-result/1` with a class, never an abandoned job. A snapshot uploads the raw responses first (when the recorded terms let the host keep them), then the manifest, then the result. The number of provider requests in the result is the number the egress module counted. Before each provider request, retries and pages included, the retrieval asks the liveness probe above: a retrieval makes no API call of its own until its first upload, so without the probe a cancelled, fenced or expired attempt would go on spending the provider budget. When the probe finds the attempt lost the retrieval sends no more requests, uploads nothing and ends without a result.
- `validate`: reads the draft, the parent of a revision and the cohort policy; runs the shared strategy validator, the warm-up check and the lineage checks of `quant-core` (`REVISION_SCOPE`, `LINEAGE_MISMATCH`, `LOOKBACK_EXCEEDS_WARMUP`, `IDENTITY_MISMATCH`); a draft that does not parse is an `INVALID` verdict with the contract code.
- `evaluate`: reads the request, the strategy and the input (a frozen input for a REPLAY; for a BACKTEST the manifest, from which it builds and uploads the input), prepares the run with `Run::prepare`, steps it with the same `Run::run_events` that `run_to_end` uses, writes the result, checks the whole result against its schema, derives the metrics of a completed run, uploads, and submits with the actual executable, engine and method identities. A run that cannot start (a window that is not a session, a manifest of another profile, more than 400 sessions, an input or strategy the core refuses) is `NOT_PREPARED` with the core's code. A REPLAY request carries no window role, cost scenario, metric scale or limitation, so its metrics use the development window, the base scenario, scale 6 and a stated limitation.
- `assess`: reads the policy, the plan, the validation result, the manifest and, for each run, the submission and the artefacts it cites; rebuilds each completed run from its strategy and input for the accounting and timing audits; decides the gates with `quant-core` and writes `gate-report/1`. It needs the strategy artefact, which its dispatch names only by hash: when the API does not serve it, the job writes no report.
  It binds before it decides (`jobs/bind.rs`). Each run of the dispatch must claim a planned run slot of its trial slot in the evaluation plan, with the plan's window role and cost scenario, and a repeat must be the plan's repeat of the run the plan names; a planned slot that no run claims is a run without a result, so the gates that read every run (the audits and the cost model) are `INSUFFICIENT` too. A submission must name the run, the engine and the method of the running binary; the input must have the windows that the plan resolved for the role. The metrics must name the run, the window role, the cost scenario, the plan's scored window, the cited result, the input hash and engine digest of the rebuilt run, the candidate's strategy hash and the running method, and they must equal the metrics that the job recomputes from the rebuilt run and the result. The validation result must be the candidate's draft under the running engine and method, and the manifest must be the dataset that the inputs of the runs name. Evidence that does not bind is never read: the gates that need it say `INSUFFICIENT` and name the mismatch in the reason, with the reason code that the method text gives to absent evidence of its kind (`RUN_MISSING` for a run or a manifest, `METRICS_UNAVAILABLE`, `VALIDATION_FAILED`), because `gate-report/1` has no code of its own for it. Limits: the job does not compare the plan's cohort policy with the policy of its dispatch, and it reads only the first manifest that the dispatch lists.

### Checkpoint journal

A worst-case run takes seconds, so the journal is off unless `OPENQUANT_SCRATCH_DIR` names a directory. With it, `evaluate` writes the core's checkpoint and its content hash every four chunks of 30 events (30 sessions of four phases). A new attempt of the same run on the same disk resumes only after `Run::restore_stored` checked the hash before it parsed a byte, and then the strategy, input and engine identities and the cursor; anything wrong starts the run from the first event. The journal is scratch on an ephemeral disk, never read by the API, removed when the result is committed. `evaluation-request/1` and `job-dispatch/1` name no stored checkpoint, so no attempt on another Machine can resume.

### Egress rules

| Class | Host | Method and path |
| --- | --- | --- |
| provider | `data.alpaca.markets` | `GET /v2/stocks/{symbol}/bars`, `GET /v1/corporate-actions` (the query keys `adjustment`, `end`, `feed`, `limit`, `page_token`, `sort`, `start`, `symbols`, `timeframe`) |
| provider | `paper-api.alpaca.markets` | `GET /v2/calendar`, `GET /v2/assets/{symbol}` |
| queue | `api.cloudflare.com` | `POST /client/v4/accounts/{account}/queues/{queue}/messages/pull` and `.../ack`, the account and queue of the configuration |
| API | the configured host | `attempts.claim`, `attempts.input`, `attempts.artefact`, `attempts.retrieval-result`, `attempts.validation-result`, `attempts.evaluation-submission`, `attempts.gate-report`: exactly the routes of the manifest that the `batch` credential or an attempt capability of the batch principal may call. A test pins the list to the manifest in both directions. |

The account read on the live trading host of the authority probe is not here: it belongs to the one-off Machine of P6. The live trading host `api.alpaca.markets` is not on the batch list, and a test shows the worker never contacts it.

### Timing, the lease and the visibility timeout

The worst case is the largest run that the S0 limits allow (`packages/quant-core/tests/result_size_bound.rs`): 400 sessions, 32 indicators with 64-character names, 8 snapshots, 4 adjustments, 32 dividends and a trade every session, a result of 2,369,582 bytes. `tests/batch_timing.rs` runs it as a REPLAY job through the worker (claim, three reads, evaluation, schema check of the whole result, an upload of 2.4 MB, the metrics, the submission and the acknowledgement; the fake world copies each artefact once). The network is not part of it.

| Run | Core alone (prepare, step, result) | Whole job |
| --- | --- | --- |
| Release build, 9 repetitions | min 2.18 s, median 2.20 s, max 2.31 s | min 2.18 s, median 2.36 s, max 2.55 s |
| Debug build, 3 repetitions | min 3.22 s, median 3.47 s, max 3.65 s | min 3.80 s, median 3.86 s, max 3.87 s |

Measured on 2026-11-15 on 4 virtual CPUs of an Intel Xeon at 2.30 GHz with 16 GB of memory, Linux 6.18. Command: `OPENQUANT_TIMING_REPETITIONS=9 cargo test --release -p openquant-engine --test batch_timing -- --nocapture`. The `assess` job over the seven runs of the pilot candidate (each of 60 scored sessions, `tests/batch_assess.rs`) took 19 to 39 ms in a release build, measured before the job bound its evidence to the plan and recomputed the metrics of each run (one more pass over each result, not in this figure). It was not measured over seven worst-case results. It never steps a run: it parses each result and rebuilds the run with `Run::prepare`, so seven worst-case rebuilds are bounded by seven times the 2.3 s of the core run, about 16 s.

The per-attempt timeouts that this host is built for, with the rule that gives them (`PROPOSED_TIMEOUT_SECONDS` in `config.rs`; the cohort policy owns the real values and replaces the 10 and 5 minutes of the decision record with these):

| Job | Timeout | Why |
| --- | --- | --- |
| `evaluate` | 120 s | Twenty times the worst whole job (2.55 s, so 51 s) for a slower shared CPU, rounded up to 60 s, and 60 s for the reads, the uploads and the start. |
| `assess` | 120 s | The same rule over seven rebuilds. |
| `validate` | 60 s | Milliseconds of compute and four reads. |
| `retrieve` | 600 s | Bounded by the provider, not by compute: the request carries its own deadline and at most 60 provider requests. The 10 minutes of the record stay. |

The API grants a lease of the timeout plus 60 seconds (`LEASE_GRACE_SECONDS` of its claim), so the leases are 180, 180, 120 and 660 seconds. The worker stops 30 seconds before its lease ends, so a whole timeout always fits before the deadline. A pull does not know the kind of the message, so the visibility timeout must outlast the longest lease plus the time between a pull and its claim: 600 + 60 + 60 = **720 seconds**, the default of `OPENQUANT_VISIBILITY_SECONDS` (`derived_visibility_seconds`). A test pins the arithmetic. Cloudflare's own limits on the visibility timeout are not verified here (see Limits).

### Tests

| File | What it proves |
| --- | --- |
| `batch_egress.rs` | The allowlist (host, method, path, query, body size), the budget per class, redirects refused and never followed, credentials on the wire and nowhere else, the API rules equal to the batch routes of the manifest, no other HTTP client in the source or the manifest. |
| `batch_wire_tls.rs` | The real wire over real TLS on the loopback interface (a certificate authority made at test time): headers, bodies, a 302 not followed (the target server is never contacted), the response size limit, the timeout, an untrusted authority and a certificate for another name refused, no proxy read from the environment. |
| `batch_worker.rs` | The protocol: order, lost acknowledgement and redelivery give one result, a crash, lease expiry, cancellation, the liveness probe, each claim refusal, poison messages, another environment, transient and final API failures, the idle backoff, stop. |
| `batch_retrieve.rs` | All 47 market-data fixture cases through the worker against the oracle's outcome (manifest bytes, digests, calls, counts), the gate, the missing credential, a redirect, the order of the uploads, no raw retention, and a retrieval of seven provider requests that is cancelled or fenced at the second: it sends at most two requests from then on and uploads nothing. |
| `batch_validate.rs` | The seed, the three S0 revisions, `REVISION_SCOPE`, `LINEAGE_MISMATCH`, `IDENTITY_MISMATCH`, `LOOKBACK_EXCEEDS_WARMUP`, a draft that does not parse, a draft that is not canonical, an unreadable draft. |
| `batch_backtest.rs` | The input built from a manifest equals the one derived by hand; the seed at AAPL magnitude at price scales 2, 3 and 4; the exact net return; an exact overflow as a typed failure; `INSUFFICIENT`, `FUTURE_DATA`, `NOT_PREPARED` in five ways, the 400-session limit; the deterministic repeat; the cost stress. |
| `batch_seeds.rs` | Every S0 case that runs one of the four seeds (the result bytes and digest equal the S0 harness's, and so are its outcome and the identities). |
| `batch_assess.rs` | Seven real runs, the validation result, the manifest and a plan whose windows resolve to the synthetic calendar, through `assess`: the gates of the policy in order, the gates that follow from the evidence, the threshold gates against the published metrics, a missing run, an unreadable strategy, a lease lost during the assessment. Then one change at a time to an otherwise passing candidate, each expected to turn the gates that read it `INSUFFICIENT` with the reason code and name the mismatch: swapped window labels, a planned run left out, a run that names no slot or shares one, a repeat that the plan does not mark, another window than the plan resolved, a submission, metrics (every member that binds, and a number the result does not support), a manifest and a validation result of another run, dataset, draft, engine or method. |
| `batch_journal.rs` | A crash in the stepping resumes from a checked checkpoint and gives the uninterrupted result; a damaged checkpoint, and the checkpoint of another run, are never used. |
| `batch_timing.rs` | The worst case completes and its times are printed. |
| `batch_cli.rs` | Usage, configuration errors that name no value, `--check-config`, a stop file. |

The fakes are in `tests/batch_support`: the fake queue and API are built from `routes/v1.json`, check the credential of each route, answer every error as a valid `api-error/1`, check that every body parses as its contract and is canonical JSON, and check that every artefact a result cites was uploaded with the size it states. The provider fixtures are those of `tests/market_support`.

### New crates

`ureq` 3.5.2 (MIT OR Apache-2.0) with `rustls` 0.23 (Apache-2.0 OR ISC OR MIT, crypto by `ring`, Apache-2.0 AND ISC), `rustls-webpki` (ISC), `webpki-roots` (the Mozilla root list, CDLA-Permissive-2.0), `ureq-proto`, `http`, `httparse`, `rustls-pki-types`, `base64`, `untrusted`, `subtle`, `zeroize` and `utf8-zero`. `ring` and `cc` compile C and assembly at build time, so a Machine image that builds the binary (P6) needs a C compiler. Dev only: `rcgen` 0.14 (MIT OR Apache-2.0) for the test certificate and `rustls` for the test server. Nothing depends on an install script. The npm licence check does not cover Cargo crates; this list is the record.

### Limits and unverified facts

- Nothing here ran against Cloudflare, the application API, Alpaca or a Fly Machine. The Cloudflare Queues request and response shapes (the pull body `batch_size` and `visibility_timeout_ms`, the acknowledge body of `acks` and `retries` with `lease_id` and `delay_seconds`, the `result.messages` list, the message body as a string or a JSON value), their visibility limits and the endpoint shapes of Alpaca are reported facts. The deployment probe (P6) confirms or corrects them.
- There is no signal handling: the code is safe Rust with no signal crate, so a SIGTERM ends the process like a crash, which is safe by design (the message comes back and the claim is refused). A graceful stop is a stop file.
- The egress module cannot enforce at the operating-system level; it is the allowlist in the binary. P6 adds what Fly supports.
- A message that is not a dispatch is given back with a long delay and never acknowledged: no route records a malformed dispatch. The queue's dead-letter settings (P6) end it.
- The proxy that the sandbox sets is never read. The loopback test passes in a sandbox that exports `HTTPS_PROXY`; the same test elsewhere proves nothing about the proxy.
- `retrieval-result/1` has no class for a budget that ends before the retrieval completes: it is `UNAVAILABLE_DATA`, not retryable.

Owner: [05-system-architecture-and-data-spec.md](../../docs/specs/05-system-architecture-and-data-spec.md). Add executable files and required verification together.
