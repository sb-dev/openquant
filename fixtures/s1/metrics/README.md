# S1 derived-evidence fixtures

Independent expected values for the numerical evidence that Rust derives from a completed run: the per-run metrics, the buy-and-hold benchmark and the cohort gates (OQ-02 sections 3.2 and 3.6; the S1 pilot decision record, D4 and D18), and the leaf-level checks of the validate job (lineage, in `packages/quant-core/tests/lineage.rs`). Every number is synthetic. No provider data, credentials or private account data. Licence: Apache-2.0.

The Rust tests (`packages/quant-core/tests/{metrics_fixtures,benchmark_fixtures,gates_fixtures}.rs`) compare the library with these files with a tolerance of zero. They never write or regenerate an expectation.

## Layout

| Path | Content |
| --- | --- |
| `oracle/oracle.py` | The script that derived every case. Standard library only, exact `fractions.Fraction` arithmetic, no float. Verification does not run it; the tests check only its hash. See Regenerating. |
| `policies/offline-pass.json` | The separate test policy of the PASS path: the pilot cohort policy with the three robustness checks that the pilot records as `INSUFFICIENT` set to `NOT_APPLICABLE` with a reason. |
| `cases/<id>/case.json` | The case: `id`, `title`, `kind`, `covers` and the names of its other files. |
| `cases/<id>/expected.json` | `schema` (`s1-metrics-expected/1`), `case`, `origin` and `expect`. |
| `cases/<id>/derivation.md` | Numbered rational steps that a reviewer can check by hand. |

The pilot cohort policy itself is `fixtures/protocol/valid/cohort-policy.s1-pilot.json`; the gate cases read it and do not copy it.

## Cases

| Prefix | Kind | What it states |
| --- | --- | --- |
| `M-01` to `M-18` | `metrics` | The `evaluation-metrics/1` figures of one S0 case run through the real evaluator: a winning and a losing run, a split and a dividend, costs with gap slippage, an open position at the end, a run with no trade, a long run, ratio scales 0 and 12, and three outcomes that have no metrics (`INSUFFICIENT`, `FAILED`). The strategy, input and journal come from the S0 case that `source` names (`s0:<id>`), which the S0 oracle derived without the Rust engine. |
| `S-01` to `S-08` | `series` | The figures of a hand-written equity series: drawdown ties, a flat series, a loss on the first scored session, a positive worst session, a mean of non-terminating fractions, half-even ties at the sixth digit (five cases), scales 0 and 12, and a 250-session series whose exposure has a denominator of thousands of bits. No engine runs these. |
| `B-01` to `B-12` | `benchmark` | The buy-and-hold path of one input: the first fillable open, the lot search with the fee, a split, dividends paid inside and after the window, a halted first session, an unaffordable lot, a fractional entitlement, the fee boundary under base and stress costs (`B-07a`, `B-07b`), a session without a bar, a window with no bar at all, a dividend on the buy session, a split and a dividend on one day, and an unsupported action. `input.json` is a patched copy of the S0 input where the case changes one thing; otherwise `input` names the S0 case. |
| `G-01` to `G-20` | `gates` | The 17 gate outcomes of a candidate under a policy: the PASS path, the expected `NO_ELIGIBLE_CANDIDATE`, each threshold gate failing or INSUFFICIENT, a measured failure beating missing evidence, each candidate-defect code, platform codes, `ARITHMETIC_OVERFLOW`, replay, both audits, point-in-time data, a required gate without a method, threshold boundaries, the cost model and the validation result. `evidence.json` holds compact evidence: per run its outcome, the three metrics a threshold reads, its cost policy and its audits. |

`expected.json` of a metrics case states the scored window, the strategy figures, the benchmarks and the daily series that the figures read (`series`). A buy-and-hold block that is `INSUFFICIENT` lists `reason_includes`. A gate case states the full list of gate outcomes and the inputs of the report; an undecided gate lists `reason_includes` instead of the reason text, so that the wording can change while the facts stay.

## Method

The expected values follow `packages/quant-core/src/method.txt`, which is the reviewed method text bound by the method identity. The oracle implements those rules a second time, in Python, from the specification: the series (net return, drawdown from a running peak that starts at the initial capital, worst session return, exposure), turnover, the execution cost with gap slippage measured against the open of the exit session, the benchmark with a lot search by bisection, the dividend and split rules, and the gate rules with their precedence. It shares no code with the Rust library. Every case also carries a hand derivation: the expected numbers of the main cases are derived on paper in `derivation.md` and asserted as constants inside the script (the `hand_*` functions and the asserts after each `write_*_case`), so a mistake common to the script and the library would still have to survive the hand derivation.

Where a hand value and the script disagreed while the fixtures were written, the hand value was wrong and was corrected (a drawdown of 20/5018 rounds up to 0.003986, not 0.003985; the equity after a fee is 4999.00, not 5000.00). The assertions stay as a record.

## Regenerating

The script writes the whole tree. Run it from any directory with the standard library only:

```sh
python3 -I fixtures/s1/metrics/oracle/oracle.py
```

Each `expected.json` carries `origin.oracle_sha256`, the SHA-256 of the script. A test fails when the script changed and the expectations did not, so regenerating is a reviewed change with an explained reason, never a side effect of a test run. The method digest in `tests/method_golden.rs` is computed separately, with `hashlib.sha256` over the text of `method.txt`.

## Limits

- The metrics cases use S0 journals, which exercise one instrument, whole lots and the S0 price scales (2 and 0). The synthetic series cases cover wider values. Real AAPL-magnitude data arrives only with the provider probe.
- The gate evidence is compact. The test builds a schema-valid `evaluation-metrics/1` around three values (net return, excess return and trade count), and takes the audits as given. The audits are tested separately against real results in `tests/run_audits.rs`.
- The benchmark is independent of the evaluator in the fixtures. `tests/benchmark_fixtures.rs` also cross-checks it against the evaluator's own equity on S0 cases that buy once and never sell.
- No fixture states a statistic with uncertainty: S1 computes none (OQ-02 section 3.6).
