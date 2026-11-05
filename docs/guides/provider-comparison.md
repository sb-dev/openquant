# Compare research providers

Status: acceptance procedure for future implementation. No provider comparison command or live integration is implemented.

## Prepare one comparison

1. Freeze a comparison ID, adapter/profile versions, stable instrument mappings, data range, as-of policy and spending limits. Declare feed coverage, timezone, session, interval, currency, price/volume adjustments, corporate actions, expected history and numerical tolerances before fetching.
2. Use a small sample covering ordinary trading, a split, a dividend, a holiday/early close, daylight-saving boundaries and a renamed/delisted instrument where required. Include malformed, partial and empty responses as deterministic fixtures. Use independent financial expectations to test transformations.
3. Retrieve Alpaca and Massive separately through `MarketDataProvider`. Traverse pagination within bounds and retain permitted source responses. Classify unsupported operations or entitlements explicitly. Freeze normalized snapshots and manifests before evaluating strategies.
4. Produce a report of requested/returned coverage, duplicates, gaps, completeness, feed/session/adjustment differences, numerical disagreements, latency and request/credit usage. Preserve both sources. Investigate differences; do not force equality, silently fill gaps or choose the source with higher strategy returns.
5. Run the same frozen strategy and evaluation policy against each compatible snapshot. Record distinct input identities and trials. Provider comparison is a data-quality experiment, not independent evidence that a strategy is profitable. Switching the future-cycle profile must not mutate old results.

## Filing and web evidence checks

For SEC, retrieve a filing and an amendment. Retain company/accession IDs, forms, accepted times, reporting periods, units and fact references. Demonstrate the cutoff excludes later amendments and distinguishes missing facts from zero. Company-level data must not be silently assigned to the wrong share class.

For Tavily, execute bounded search and extraction with source references. Include a failed URL, partial result, missing publication timestamp and a page containing hostile instructions. Preserve query/filter/usage settings. Treat snippets and extracted text as evidence candidates, not authority. A present-day search with an old date filter cannot by itself satisfy historical availability.

## Failure and repeatability checks

Exercise authentication/access failures, rate limits, `Retry-After`, timeout, cancellation, schema changes, duplicate pages, budget exhaustion and unavailable data. Reject unexpected pagination URLs and private/internal extraction targets. Keep unknown billed usage reserved until reconciled or conservatively accounted for. Shared account limits must hold across concurrent missions.

Normal CI uses synthetic or permitted recorded fixtures without credentials. Explicit opt-in live probes use bounded requests, actual entitlements and recorded adapter/deployment identities. Test each initial adapter before claiming M1 support. A fixture pass cannot replace a live probe.

## Worked acceptance design

The following cases use synthetic inputs and expected outcomes. They are not executed tests or claims about provider access. Budget units are fixture values, not provider prices.

Freeze watchlist `W1`, cycle `C1`, profile `P1`, comparison `K1` and stable instrument `I1`. Record each provider symbol mapping with its validity dates. `P1` selects Alpaca for ordinary retrieval; `K1` explicitly permits both providers. Bind each request to its profile, operation, feed, account access scope, range, cutoff, calendar version, session, interval, currency, adjustment policy, limits and adapter version. Keep distinct request/attempt and manifest identities for Alpaca and Massive, even when normalized values agree. Bind derived series to their source snapshot and transformation version.

| Case | Fixture and expected outcome |
| --- | --- |
| Split and daily bars | Give `I1` a synthetic 2-for-1 split effective 2026-03-09. Use flat raw OHLC of `100` and volume `1000` on March 6; use raw OHLC of `50` and volume `2000` on March 9. Under an explicitly declared split-adjusted price/volume policy, the earlier bar becomes `50` and `2000`; the later bar remains `50` and `2000`. The split alone creates no economic return. Preserve the raw execution series. Applying the split twice fails. A split-adjusted series does not establish dividend-adjusted total return. |
| Daylight saving | With a versioned America/New_York regular-session calendar, March 6 closes at 21:00 UTC and March 9 at 20:00 UTC. Match daily bars by instrument and declared session, preserving each original timestamp and its start/end/date meaning. Do not shift a bar to another session or invent weekend bars. Apply the data-ready window after the close. |
| Equivalent coverage | Align the supported feed, session and adjustment semantics before comparing values. An IEX-only response cannot stand in for consolidated volume. Keep incompatible coverage visible; block the affected equivalence claim. Missing pages, conflicting duplicates and unavailable corporate-action semantics cannot pass because some prices match. |
| Amendment cutoff | For a separate historical decision at `2026-03-06T22:00:00Z`, provide original accession `F1` accepted March 5 and amendment `F2` accepted March 10. Link both to the same company and correct instrument mapping. Only the available `F1` facts can enter that decision; retain `F2` as a separate later version. Bind each fact to accession, period, taxonomy/tag and unit. A present-day company-facts value matching `F2` cannot replace `F1`. |
| Uncertain web timing | At the same cutoff, a March 6 publication date with verified UTC day precision has a conservative upper bound of March 7 00:00 UTC, which is too late. Unknown timezone or publication/availability remains unknown. Exclude the item unless the registered policy has another justified availability bound for those exact contents. An immutable capture of those contents before the cutoff can supply such a bound; leave publication time unknown if it is unknown. An old page date or Tavily filter alone cannot establish the historical content version. |
| Evidence identities | Give the Tavily result, snippet, extracted page and generated summary separate identities and source links. Record query/filter/depth settings, retrieval outcome, hashes where permitted, timestamps and precision. Failed extraction stays partial. Search scores, generated claims and hostile page instructions confer no authority. Missing required evidence blocks eligibility; an optional failure remains visible. |
| Ambiguous timeout | Set the period cap to `100`, settled usage to `80`, and an unresolved timed-out attempt's reservation to `15`. Available allowance is `5`. A proposed new attempt requiring `10` is blocked. Timeout or cancellation does not release the `15`. Reconcile or conservatively account for that usage; do not call the timeout a free retry. Any later permitted retry remains within deadline, retry and shared account limits and has a recorded attempt and reservation. |
| Provider edit during work | While `C1` is active, save `P2` selecting Massive. `C1`, its pending work, retries and evidence retain `P1`. New automatic cycles use `P2`; the edit does not create another cycle for the same schedule slot or reset the period cap. An explicit comparison/rerun has its own identity, reason and budget. Do not use Massive to hide the unresolved Alpaca attempt. |

The split-adjusted comparison is a data-quality fixture, not permission to use a later split in an earlier decision. For every simulated decision, enforce that decision's information cutoff and corporate-action policy. Newly fetched filings or web evidence require proof or a justified bound for the exact historical version; their event dates alone are insufficient. Record later versions outside the earlier decision's approved evidence pack. Re-fetches create new snapshots and cannot overwrite frozen inputs.

Read back stored cycle/profile versions, manifests, evidence eligibility and budget reservations before reporting these cases as passed. Ordinary CI can verify the synthetic expectations. Actual entitlements, provider behaviour and billed usage still need separate opt-in probes.

## Record the result

Record source revision, procedure, inputs, schema/adapter versions, expectation, observation, differences and remaining gaps. Save private data in the runtime stores and only authorised evidence references in research logs. Read the persisted report back. Replaying frozen data must reproduce its normalized identity and numerical outcomes; a new live request may return revised data.

Owners: [domain §1.1](../specs/02-trading-domain-and-evaluation-spec.md#11-watchlists-profiles-and-source-evidence), [architecture §7.1](../specs/05-system-architecture-and-data-spec.md#71-pluggable-data-and-research-providers), [engineering §8](../specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance). Provider-specific references are in [service providers](../reference/service-providers.md).
