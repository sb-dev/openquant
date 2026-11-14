# S0 final review

Date: 2026-11-14. Owner: OQ-06 section 8 (S0) and the roadmap S0 row. Reviewed commit: `a5b7f3b` (`a5b7f3bc8bd3b6f680e57871efb78d7f3551a63d`) on `main`, the merge of S0 as PR #8.

Status: separate-session model review, not a human review. A separate Claude Code session reviewed the merged S0 commit before S1 work starts. Its report does not state the model that ran it. This log records the reviewer's report. The canonical specifications own the requirements. The [S0 log](2026-11-13-s0-offline-seed-evaluation.md) records the S0 decisions and the earlier review rounds.

## Commit

- `git rev-parse HEAD` in the reviewer's worktree gave `a5b7f3bc8bd3b6f680e57871efb78d7f3551a63d`. That commit is on `origin/main`. Its message is "docs: Record round 3 review outcomes in the S0 log".
- The reviewer changed no tracked file: `git status --short` was empty after the review. Its probe inputs and outputs stayed in its scratch space and are not committed.

## Environment

- Node v24.19.0, which matches `.node-version`.
- rustc 1.97.0 (2d8144b78 2026-07-07) and cargo 1.97.0 (c980f4866 2026-06-30), which match `rust-toolchain.toml`.
- Host x86_64-unknown-linux-gnu, Linux 6.18, 4 vCPU.
- A Git worktree with an empty `target/` directory, so every crate was compiled. The `~/.cargo` registry cache was warm, so crate download was not tested.

## Commands and results

| Command | Result |
| --- | --- |
| `node scripts/verify.ts` | Exit 0 in 218 s with a cold `target/`. Repository tests: 116 run, 116 passed, 0 failed, 0 skipped. `cargo fmt --check` clean. `cargo clippy` with `-D warnings` clean. `cargo test --workspace --locked`: 454 passed, 0 failed, 0 ignored. `s0-replay`: 98 cases, 0 failed, 0 coverage problems. Fixture digest unchanged. Final message "Verification passed". |
| `target/debug/s0-replay --out <scratch>/rerun` | Exit 0, 98 of 98. `results/` and `index.json` are byte-identical to the verify run. The report body is identical apart from its header. |
| GitHub check runs for `a5b7f3b` (`gh api`) | Run 43507285573 (push to `main`): "Bootstrap checks" and "ci" both `success`. The job log shows Node v24.19.0, 116 of 116 repository tests, 454 Rust tests passed and 98 cases with 0 failed. |
| Probe: the 21 cases without `restore_every_cut`, copied with it set and with the committed expectations | 14 of the 21 process events. All 14 pass restore at every cut (20 to 36 cuts each). The other 7 are rejected before the first event, so there is nothing to restore. All 21 pass. |
| Probe P-01 and P-02: C-01a with `quantity_scale` 2 and lot 0.01 | P-02 (10.00 shares) is `COMPLETED`. P-01 (10.25 shares) ends `INSUFFICIENT` with `FRACTIONAL_ENTITLEMENT` at the 2-for-1 split ("would leave 20.50 shares from 10.25"). This is defect 1. |

## Spot checks

The reviewer derived these by hand or with its own exact-fraction script. It did not read the oracle. It read the case titles and the ENT-01-v1 design notes before deriving, so the checks are independent of the oracle but not blind. Every check matches the committed expectation.

1. X-01: signal, ATR, slot cap, the 19-share fill with its fee, cash, stop, target and equity.
2. C-01b: a split on a pending entry.
3. C-01a and C-01c: a split on a held position, including the break-even stop before and after the split.
4. C-03 and C-04b: the dividend receivable, its payment and the slot cap that excludes the unpaid receivable.
5. ENT-01, ENT-02 and ENT-03: RSI values, the rank and the entry decision at thresholds 30, 32 and 40.
6. DEF-01 and DEF-02: break-even off and on, a gap through the scheduled stop, and an intraday stop.
7. SEM-03: the first valid index of every indicator in the warm-up.

## Requirement verdicts

The requirements are the S0 paragraphs and case rows of OQ-06 section 8 and the roadmap S0 row, as they stood at `a5b7f3b`.

| Requirement | Main evidence | Verdict | Notes |
| --- | --- | --- | --- |
| One complete one-instrument path through the shared Rust core | `signals.rs`, the execution phases, `Run::step`; report sections of ENT-01-v1, DEF-01 and R-01 | PASS | |
| Independent expectations: both RSI entry conditions, timing, sizing, corporate actions, invalid inputs | 97 oracle cases and F0-smoke; the oracle hash check in `s0_fixtures.rs`; spot checks 1 to 7 | PASS | Verify does not rerun the oracle. Git cannot show blind authorship. |
| Each variant is a versioned contract and definition; no hard-coded seed path | The strategy files differ only in data; distinct SHA-256; no variant names in `quant-core/src` | PASS | |
| Only the reviewed operator subset the seed needs | 19 operators in `operators/catalogue.rs` | PASS | `lt` is unused; `min` and `max` are absent though OQ-02 section 2.2 lists them (S0 interpretation 3). |
| Versioned schemas, generated Rust bindings, version, unknown-field and decimal validation, shared fixtures | 5 schemas; `build.rs`; 18 valid and 61 invalid manifest entries | PASS | |
| Checkpoint binds identities and the cursor to positions, cash, reservations, pending entries, scheduled stops and applied actions | `checkpoint.rs` write and restore | PASS | Restore does not cross-check stop, target, snapshot or rank values (known limit). |
| Numerical payload uses the shared result schema; no remote identities | `evaluation-result` schema; every case reports "schema ok" | PASS | |
| Clean checkout: workspace, toolchain, lockfile; checks wired into verify and CI | `scripts/rust.ts`, `scripts/verify.ts`, `ci.yml`; the verify run; CI run 43507285573 | PASS | A worktree with a cold target and a warm registry, not a fresh clone. |
| Harness exposes signals, trades, cash and positions | `local-runs/s0/report.md` sections per case | PASS | |
| Record of revision, identities, engine, command, expected and actual results, limits | Report header, identities, comparison and limitations | PASS | |
| Repeat runs agree | Separate-process rerun is byte-identical | PASS | |
| Restore keeps the cursor and action IDs, so a split is not applied twice | 77 cases restore at every cut; the 21-case probe | PASS | Restore of a failed run is not in verify (defect 3). |
| No claim of A11, an acceptance ID or the CLI release gate | S0 log and report limitations | PASS | |
| Definition execution | DEF-01, DEF-02, ENT cases, I-04a and I-04b, protocol strategy fixtures | PASS | |
| Shared payloads in Rust | Protocol tests, result round trips, checkpoint mismatch payloads | PASS | |
| Seed semantics, with explicit source-to-seed changes | SEM-01 to SEM-05; indicator and evaluation code; S0 log | PARTIAL | The formulas pass. The source-difference table comes from the 2026-11-07 log, not the scripts. Several source cells read "Not recorded" (defect 2). |
| Entry variants | ENT-01, ENT-02, ENT-03; spot check 5 | PASS | |
| Unplanned non-trading events, S0 part | I-02, I-06, I-07, I-09, C-06 | PASS | Cohort coverage belongs to S4. |
| Split across an ex-date | C-01a to C-01c, C-02, C-05, C-07, C-08; spot checks 2 and 3 | PASS | |
| Cash dividend | C-03, C-04, C-04a to C-04c, C-05, R-01; spot check 4 | PASS | |
| Entry and exit phases | X-05 to X-14, G cases, DEF cases | PASS | |
| Cash and quantities in one ledger | X-01 to X-04, X-10, X-11, I-06 | PASS | |
| Invalid inputs | I-01 to I-12c, C-02, C-06 to C-08, G-07a and G-07b | PASS | |
| Local replay | F0-smoke, R-01, restore checks, rerun | PASS | |
| Roadmap S0 row | All of the above | PASS | |

## Defects

1. Minor, correctness and coverage. A split refuses any non-integer holding, even under a fractional-lot policy. `corporate_actions.rs` tests the post-split quantity with `is_integer`. With `quantity_scale` 2 and lot 0.01 the policy accepts 10.25 shares, but a 2-for-1 split ends the run `INSUFFICIENT` with `FRACTIONAL_ENTITLEMENT`, although 20.50 lies on the quantity grid. It fails safe: no number is invented. The code comment assumes whole shares, interpretation 11 does not state the rule, `Run::prepare` accepts the combination, and no fixture combines `quantity_scale` above 0 with a split.
2. Minor, evidence. The source-to-seed differences were never checked against the source scripts. The scripts are outside Git.
3. Minor, test gap. Verify never restores a failed or insufficient run. The 14 committed cases that fail after processing events do not request `restore_every_cut`. The reviewer's copies with restore enabled all pass, so this is a fixture configuration gap, not a behaviour defect.
4. Process and documentation. The S0 log records round 4 reviews as not run and still names branch `ccr-17c8728f-tu3pa4` in its status. Its "Node 22 locally" note is now supplemented: this review and CI both used Node 24.19.0.
5. Known limits, documented and not new: restore does not cross-check level values; verify does not re-derive expected values; the applied-ID guard is unpinned (V2-2); CI wiring checks are substring checks (V2-1); rank ties compare a rounded rank; late halt evidence, payment at `DURING_SESSION`, a non-positive sale price and a break-even on the fill day are pinned by unit tests only (interpretations 8, 10, 17 and 30).
6. Observation outside the S0 rows. `evaluation-result/1` carries no return metric. S0 reports equity only, so its contribution to the return calculations of A04 is indirect.

## Overall verdict

PASS WITH LIMITS. Every S0 requirement of OQ-06 section 8 and the roadmap S0 row is met at `a5b7f3b`, except the source-to-seed record, which is PARTIAL. Verification reproduces 116 repository tests, 454 Rust tests and 98 cases with no failure, locally with Node 24.19.0 and on GitHub CI. The reviewer found no numerical disagreement with an expected value. The defects are minor, and none changes a committed result.

## Limits of this review

- A model session reviewed the commit. No human repeated the review.
- Read in full: `run.rs`, the execution phases, `operators/{eval,indicators,catalogue}.rs`, `signals.rs` and `state.rs`. Read in part: `checkpoint.rs`, `numeric.rs`, `scripts/verify.ts`, `scripts/rust.ts` and `scripts/s0.ts`.
- Not reviewed: `compile.rs`, `strategy.rs`, `ratio.rs`, `format.rs`, the `api-contracts` crate internals and the harness `compare.rs` and `replay.rs`.
- About 15 cases were checked by hand. The other cases rely on the committed expectations.
- Not run: mutation testing, fuzzing, release-profile runs, a fresh clone with a cold registry, macOS or `cargo doc`.
- The authorship and blindness claims of the fixtures, and the figures that other agents reported in the S0 log, were not verified.

## How S1 treats each finding

| Finding | S1 treatment |
| --- | --- |
| 1. Fractional split | Not exercised. The pilot uses whole-share lots: `quantity_scale` 0, lot size 1 ([S1 pilot record](2026-11-14-s1-pilot-profile.md)). The limit stays recorded. A profile with fractional lots needs a fix and a fixture first. |
| 2. Source-to-seed record PARTIAL | Carried as a stated limit of the seed's source-interpretation record. The Researcher registers the seed with its recorded source-to-seed differences, and that record states that they were not checked against the scripts. |
| 3. Failed-run restore not in verify | Carried to the P3 tests, which add restore of failed and insufficient runs. |
| 4. Process and documentation | The S0 log stays as it was merged. This record is the final review of the merged commit and records Node 24.19.0. |
| 5. Known limits | Carried unchanged. |
| 6. No return metric in `evaluation-result/1` | S1 adds `evaluation-metrics/1`, computed by the Rust core (OQ-02 section 3.6). `evaluation-result/1` is unchanged. |

## Verification

This change adds this log and its index line only. The figures above come from the reviewer's report. This log does not repeat them.
