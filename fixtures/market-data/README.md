# Market data

Status: synthetic, Alpaca-shaped provider responses and independently derived expectations for the S1 market adapter and normaliser (`apps/engine/src/market`), plus the synthetic S0 bars that live inside each case in [S0 fixtures](../s0/README.md). No recorded provider data exists here. Licence: Apache-2.0.

Record event time, availability time, instrument identity, source, dataset version, content hash, and redistribution rights. Include missing and invalid cases. Never put proprietary data here without permission.

## What these fixtures are, and are not

Every value is invented: one instrument (`SYNTH`, asset id `00000000-0000-4000-8000-000000000001`), invented prices and volumes, invented provider record ids. The response bodies follow the shape that Alpaca's public API reference describes for daily bars, minute bars, corporate actions, the calendar and the asset record, as last known. That shape is **not verified against a live response**: no credential exists in this repository and no provider call is allowed from it. The provider probe of the delivery step is the first real check. A real response that differs fails with a typed `MALFORMED_RESPONSE`; it does not silently pass.

Two facts about the shape matter most. The corporate-actions response of the market-data API is not known to carry a declaration date or a record id, and the profile names `declaration_date` as the field that evidences an action's availability. These cases give the actions that field, as a provider would have to for the profile to be usable. `B-01-dividend-field-missing` and `B-14-split-field-missing` show what happens when it is absent: the profile is blocked, and nothing replaces the evidence.

## Layout

| Path | Content |
| --- | --- |
| `cases/index.json` | The case ids in order. A test requires it to equal the directories below `cases`. |
| `cases/<id>/case.json` | The full `retrieval-request/1`, the host identity, the clock (`now`) and the script: for each provider request the adapter must send (host, path, query), the answer to give (status, headers, body file, or a transport failure). |
| `cases/<id>/responses/NN-<operation>.json` | The provider body of step NN, byte for byte. The SHA-256 of these bytes is the `content_digest` in the manifest. Some bodies are deliberately not valid JSON (the E cases), the extension is only a name. |
| `cases/<id>/expected.json` | The expectation derived by the oracle: the manifest and its digest, or the typed profile block, or the typed provider error, plus the call log (sequence, operation, start time, status, error class, retry hint) and the waits. |
| `cases/<id>/derivation.md` | Numbered hand derivation of the case and the hand-checked values the oracle asserts. |
| `oracle/oracle.py` | The independent oracle. Standard library only: `zoneinfo` for the New York offset, `decimal` for exact numbers, `hashlib` for digests. It shares no code with the Rust normaliser and states its rules in its own words. |

## Cases

| Group | Cases |
| --- | --- |
| `N-*` normalised snapshots | `N-01` a 4-for-1 split; `N-02` a cash dividend with its ex-date and payment inside a rising run; `N-03` a holiday; `N-04` an early close; `N-05` and `N-06` the two daylight-saving changes; `N-07` an unscheduled closure that the calendar still lists (PARTIAL, no halt invented); `N-08` the same closure omitted by the calendar (COMPLETE); `N-09` three bar pages and two action pages; `N-10` an empty response (NO_OBSERVATIONS); `N-11` a dividend payable after the range end (the snapshot calendar extends to it); `N-12` three fractional price digits with exponent and trailing-zero tokens; `N-13` a special dividend kept as an unsupported distribution; `N-14` split ratio reduction and same-day action ids; `N-15` an identical retransmitted bar; `N-16` the request end clamped to the minimum end age. |
| `B-*` blocked profiles | Evidence missing, declared on or after the ex-date (dividend and split), payable date not a session or before the ex-date, five price digits, an action type with no rule, an instrument mismatch, conflicting duplicate bars, an unrepresentable split ratio, a bar on a holiday, a bar not stamped at a session start, a dividend amount with nine digits, an ex-date on a holiday. No manifest is produced. |
| `E-*` provider failures | 401, 403, 429 with `Retry-After` then success, 429 until the retries are used up, 503 then success, a redirect, malformed JSON, a truncated body, a body of the wrong shape, a repeated page token, a quoted number, a duplicate key, a budget that ends mid-pagination, a `Retry-After` past the deadline, a response above the size limit, an egress refusal. |

## How a case is checked

`apps/engine/tests/market_*.rs` load each case, play its script through the real adapter, normaliser and retrieval sequence, and compare:

- every request the adapter sends with the request the oracle expected (the scripted transport fails at the first difference);
- the call log, the waits and the number of requests;
- for a snapshot: the manifest (deep equality), its digest, the price and money scale, the source digests, and that the canonical text parses as `dataset-manifest/1` and hashes to the digest;
- for a block or an error: the code, the subject, the class and whether it is retryable.

The tests never write below `fixtures/` and never regenerate an expectation. `oracle_sha256` in every `expected.json` binds the values to the oracle that derived them: a test fails when the oracle changes without regenerated values, as for the S0 fixtures. The transformation digest in each manifest is the SHA-256 of `apps/engine/src/market/rules.txt`; changing that text changes every digest, so regenerate and review the diff.

## Regenerating

Verification does not run the oracle. Run it only when a case or a rule changes on purpose, and explain every changed expected number in the commit (OQ-02 section 7):

```
python3 -I fixtures/market-data/oracle/oracle.py
```

The oracle asserts its own computation against the hand-derived values listed in each case before it writes anything.

## Known limits

- Endpoint paths, query names and response shapes are unverified against a live provider (above).
- The Eastern rule covers 2007 to 2099 only.
- `unplanned_events` is always empty: no halt evidence source exists in S1, and an absent bar alone never creates one.
- A bar's revision history is not evidenced. A snapshot retrieved later can hold provider corrections (OQ-02 section 1.1).
