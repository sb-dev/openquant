# Research service providers

Status: planned integrations. Documentation reviewed on 2026-11-05; authenticated API, entitlement, latency and cost probes have not run. [Architecture §7.1](../specs/05-system-architecture-and-data-spec.md#71-pluggable-data-and-research-providers) owns the interfaces; [domain §1.1](../specs/02-trading-domain-and-evaluation-spec.md#11-watchlists-profiles-and-source-evidence) owns evidence meaning.

## Initial adapters

| Adapter | Documented API surface | Configuration and constraints to verify |
| --- | --- | --- |
| Alpaca / `MarketDataProvider` | Historical stock bars and feed selection; instrument/calendar/corporate-action coverage must be probed for the selected account. | Host-owned key/secret references; explicit SIP/IEX feed, range, session, adjustment, history and pagination. Free live IEX coverage is not consolidated coverage. Historical SIP access requires an end time at least 15 minutes old without the paid recent-data entitlement. |
| Massive / `MarketDataProvider` | Custom stock aggregates; reference and corporate-action APIs. | Host-owned key reference; explicit range, interval, session, split adjustment and plan/history limits. Aggregates default to split-adjusted; this is not dividend-adjusted total return. An interval with no qualifying trades may have no bar. |
| SEC EDGAR / `CompanyFilingsProvider` | Company submissions, filing documents and XBRL company facts. | Company ID mapping, forms, cutoff, accession and amendment rules; identifying User-Agent and fair-access rate policy. Public data APIs need no API key. Keep periods, tags and units; resolve facts through the appropriate filing version. |
| Tavily / `WebResearchProvider` | Search and extraction. | Host-owned key reference; query, domains, topic, date filters, depth, bounded results/content, deadline and credit reservation. Request usage reporting where supported. Record failed URLs and partial extraction separately. |

Capabilities are declared per operation and account profile. Missing required history, adjustments, calendar, corporate actions or revision information blocks the affected research profile. Do not infer complete support from this table or a successful authentication request. Exact SDK/API revisions and limits are pinned when live probes establish them.

## Profile and evidence

A research profile selects `marketData`, `companyFilings` and `webResearch` adapter IDs. It also declares required versus optional evidence, financial semantics, cutoff, retention and usage limits. Secret values are outside configuration records. Saving a change creates a new profile version; active cycles retain the frozen version.

Alpaca and Massive are interchangeable only for supported, aligned market operations. SEC and Tavily provide different evidence categories. An adapter is registered in its existing host; there is no runtime plugin download or model-selected provider routing.

Preserve stable instrument IDs separately from ticker/exchange and company IDs. A ticker can change or be reused, and a company can have multiple securities. Record mapping validity and unresolved identity. Keep raw/unadjusted execution prices separate from derived signal or return series; apply declared corporate-action semantics once.

For all sources retain request semantics, original identifiers, coverage, timing precision, adapter/transformation versions and immutable manifest references. Retrieval time is not publication time. A search date filter is not an archive. Latest financial facts can contain amendments unavailable at the requested historical cutoff. Unknown availability cannot become point-in-time evidence merely because a request contains an `asOf` field.

Raw payload retention, extraction, model processing and export must follow the selected access terms. Retain only permitted content; if required reproducibility evidence cannot be retained or legally reconstructed, block that profile or narrow its claims. Do not copy private responses or credentials into Git. Public fixtures must be synthetic or explicitly redistributable.

## Probe before support claims

Follow the [comparison guide](../guides/provider-comparison.md). Record the account profile, non-secret entitlement description, source terms reviewed, exact request/adapter revision, actual response coverage, usage and remaining gaps. Connection, capability and research acceptance are separate findings. Repeat affected probes after adapter/API changes.

## Official references

- [Alpaca market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq): feeds, authentication, historical restrictions and pagination examples.
- [Alpaca data plans](https://docs.alpaca.markets/us/docs/about-market-data-api): documented account limits and coverage.
- [Massive custom bars](https://massive.com/docs/rest/stocks/aggregates/custom-bars): interval semantics, plan access, split adjustment and limits.
- [Massive splits/dividends](https://massive.com/blog/new-splits-and-dividends-endpoints): source endpoints and adjustment metadata.
- [SEC data APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces): submissions, company facts, periods and units.
- [SEC developer guidance](https://www.sec.gov/about/developer-resources): automated access and client identification.
- [Tavily search](https://docs.tavily.com/documentation/api-reference/endpoint/search) and [extraction](https://docs.tavily.com/documentation/api-reference/endpoint/extract): filters, usage and partial results.
- [Tavily credits](https://docs.tavily.com/documentation/api-credits): request charging. Keep limits in deployment configuration rather than hard-coding prices into domain policy.
