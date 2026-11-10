# Strategy definition, watchlist evaluation and research skills

Date: 2026-11-07. Reviewed [PR #4](https://github.com/sb-dev/openquant/pull/4) at `5daacdf1faf6fd9a8d78fd86f037fd941ec91e60`.

Status: adopted into OQ-01–OQ-07 v1.2.0 on 2026-11-08. The original research below records the rationale; the canonical specifications own the resulting requirements. Runtime implementation and strategy performance remain unverified.

## Recommendation and rationale

Keep per-stock research. Represent a strategy's signals, stock selection, sizing and exits in one immutable Strategy Version. Evaluate the complete policy jointly when stocks compete for cash or position slots.

[OQ-02 §§2 and 5](../specs/02-trading-domain-and-evaluation-spec.md) already defines a strategy universe, a shared Rust core, portfolio allocation and coordinated account execution. PR #4 adds watchlist inputs, provider contracts and recurring research. Its per-stock missions do not restrict every executable strategy to one stock. The remaining gap is precise support for joint ranking, shared strategy cash and stateful exits.

| Scope | Benefits | Costs and limits |
| --- | --- | --- |
| Per-stock research | Focused company evidence, parallel work, clear attribution and isolated failures. | Individual tests cannot establish a policy that selects between stocks. Independently tuning every stock expands the search. |
| Joint strategy evaluation | Tests selection, displaced trades and capital reuse together. One version identifies the complete trading policy. | Requires common dates, missing-data rules and per-stock attribution. Universe changes can alter many trades. Shared rules can miss company-specific behaviour. |

With four positions open and one slot free, three qualifying stocks cannot all enter. The selected stock occupies cash and a slot until exit, changing later opportunities. Separate stock backtests cannot reconstruct that result by adding returns.

Per-stock signals plus a common selector can produce the same trades if timing, selection and accounting match. The important boundary is ownership: the strategy owns its ranking and allocation within its assigned budget; the portfolio allocator distributes capital across strategies; account execution owns broker orders and enforces account limits. Joint evaluation improves fidelity. A return advantage remains untested.

Use the existing reviewed-operator format. A Python sandbox offers broader experimentation but adds another execution and numerical-verification boundary. Treat supplied Python as source material for strategy drafts. Add new operators through reviewed code contributions.

## Seed family and first experiment

The user supplied `daily_multifactor_swing_trader.py` (V1) and `gemini-code-1793903237866.py` (V2). They are external examples, not repository fixtures.

Both use daily bars and long positions. Their shared rules are:

- Close exceeds its 50-bar simple moving average.
- At least one of the previous two RSI values is below or equal to the recent-weakness threshold; current RSI exceeds 30. This does not require an upward crossing today.
- Volume exceeds its 20-bar average, including the current bar.
- Eligible new entries rank by `50 * (volume / volume_SMA20) + (100 - RSI)`, descending.
- At most five positions are held. New positions receive available cash divided by vacant slots.
- Initial stop is `entry_price - 2 * entry_ATR`; target is `entry_price + 5 * entry_ATR`.

RSI components and ATR both use 14-bar simple rolling means. V2 changes the recent-weakness threshold from 30 to 32. It also moves the stop once to entry after the daily high reaches `entry_price + entry_ATR`.

The versions are not a controlled comparison. V1 downloads maximum history; V2 downloads one year and evaluates at most 60 rows. Both align stocks by row number and can mark remaining positions beyond the simulated endpoint. They use completed-bar signals at the same close. V2 updates the stop from the high before checking the low, although daily bars do not reveal that order.

Before comparison, use common dated observations and one valuation cutoff. Specify costs, gap fills, missing data, currency and quantity accounting. A simple daily baseline can enter at the next session's open and activate newly triggered stop changes from the next session. These change the source assumptions and require explicit versioning.

Then compare under the same frozen data, dates, costs, timing and benchmarks:

| Candidate | Recent-weakness threshold | Break-even adjustment |
| --- | ---: | --- |
| Baseline | 30 | Off |
| Entry variant | 32 | Off |
| Exit variant | 30 | On |
| Combined variant | 32 | On |

Measure net return, drawdown, turnover, trade count and cost sensitivity. Retain per-stock contributions and skipped-entry reasons. This comparison isolates both changes and their interaction; it does not assume an improvement.

### Source identities

SHA-256 values below were calculated from the original uploaded bytes on 2026-11-10. The scripts remain outside Git. Reviewers need those exact source files to inspect the extraction; the hashes identify the inputs but do not supply their contents.

| Source | SHA-256 |
| --- | --- |
| `daily_multifactor_swing_trader.py` (V1) | `f3c6b65607c4b3ab783b53d639772fb3952447034f3cc7e4b7891507fdeed8d1` |
| `gemini-code-1793903237866.py` (V2) | `51aeec0ddd6bf257e318253e7a8dcb598516144e0bacf7e74001cf0333dc37fe` |

## Agent formulation and iteration

Keep the existing boundaries in [OQ-02 §§1–3](../specs/02-trading-domain-and-evaluation-spec.md) and [OQ-03 §§1–4](../specs/03-model-backed-execution-spec.md):

1. Freeze the mission's evidence, evaluation policy, allowed operators, parameter bounds and budgets.
2. Let proposers use source methods, existing strategies and prior failures to form hypotheses. Test new families, controlled revisions and removal of individual components.
3. Require a parent hash where applicable, rationale, exact rule changes, expected effect, invalidation conditions and source references.
4. Register each trial before evaluation. The critic challenges assumptions; the Rust engine produces official numbers; application policy determines eligibility.
5. Feed permitted findings into later proposals. Retain failed variants and consumed holdouts. Freeze promising versions for prospective paper evidence.

The Strategy Contract and executable Definition share one version. A run separately binds the watchlist, data, engine, costs and evaluation policy. Agents cannot improve a reported result by silently changing the measurement conditions. Historical model knowledge remains a limitation even with date-filtered retrieval.

## Reading list and skill priorities

Keep the full reference list; prioritise which methods to extract first. Coverage was checked against publisher descriptions and contents. The applications below are recommendations; full PDFs have not been analysed.

| Area | Book | Selected use |
| --- | --- | --- |
| Strategy formulation | Ernest P. Chan — [Algorithmic Trading: Winning Strategies and Their Rationale](https://www.wiley.com/en-gb/algorithmic-trading-winning-strategies-and-their-rationale-p-9781118460146) | Translate momentum and mean-reversion rationales into explicit rules and testable variants. |
| Experiment design | Robert Pardo — [The Evaluation and Optimization of Trading Strategies, 2nd edition](https://www.wiley.com/en-gb/the-evaluation-and-optimization-of-trading-strategies-2nd-edition-p-9781118045053) | Design bounded parameter searches and walk-forward tests: fit on earlier data, then evaluate on later data. |
| Technical analysis | Perry J. Kaufman — [Trading Systems and Methods, 6th edition](https://www.wiley.com/en-us/trading-systems-and-methods-6th-edition-p-9781119605355) | Extract relevant indicator definitions, trend, momentum and volume methods. Use selected chapters as a component reference. |
| Technical analysis | John J. Murphy — [Technical Analysis of the Financial Markets: A Comprehensive Guide to Trading Methods and Applications](https://penguinrandomhousehighereducation.com/book/?isbn=9780735200661) | Generate chart- and indicator-based hypotheses. Convert each pattern into explicit rules before testing. |
| Fundamental analysis | Stephen H. Penman — [Financial Statement Analysis and Security Valuation, 5th edition](https://www.mheducation.co.uk/ebook-financial-statement-analysis-and-security-valuation-9780077147921-emea) | Derive profitability, cash-flow, sustainable-earnings and accounting-quality hypotheses. Use valuation methods when the experiment needs them. |
| Stock selection | Wesley R. Gray and Jack R. Vogel — [Quantitative Momentum: A Practitioner's Guide to Building a Momentum-Based Stock Selection System](https://www.wiley.com/en-us/quantitative-momentum-a-practitioner%27s-guide-to-building-a-momentum-based-stock-selection-system-p-9781119237259) | Form stock-ranking and rebalance hypotheses for joint watchlist evaluation. Keep relative momentum separate from the seed's RSI pullback. |
| Empirical validation | David Aronson — [Evidence-Based Technical Analysis: Applying the Scientific Method and Statistical Inference to Trading Signals](https://www.wiley.com/en-gb/evidence-based-technical-analysis-applying-the-scientific-method-and-statistical-inference-to-trading-signals-p-9780470008744) | Make hypotheses falsifiable and challenge improvements caused by searching many variants. |
| Sizing and risk | Robert Carver — [Systematic Trading](https://www.harriman-house.com/authors/robert-carver/systematic-trading/9780857194459) | Turn signals into positions with explicit risk, diversification and cost assumptions. |
| Execution assumptions | Larry Harris — [Trading and Exchanges: Market Microstructure for Practitioners](https://academic.oup.com/book/52292) | Specify order, spread, liquidity and fill assumptions. Check present-day venue rules separately. |
| Machine-learning validation | Marcos López de Prado — [Advances in Financial Machine Learning](https://www.wiley.com/en-ie/advances-in-financial-machine-learning-p-9781119482086) | Design time-aware validation for learned models, including separation of overlapping training and test observations. |

For the first swing-strategy skills, start with selected Chan and Kaufman methods, Pardo's experiment design and Aronson's validation guidance. Use the remaining references when a hypothesis needs their methods; later priority does not remove a book from the list. A fundamental filter is a separate experiment, and a valuation strategy needs its own holding horizon.

Fundamental values must be tied to filing versions and verified availability times. Period-end dates do not establish when a value became public. Follow [OQ-02 §1.1](../specs/02-trading-domain-and-evaluation-spec.md#11-watchlists-profiles-and-source-evidence) for amendments and restatements. Executable fundamental features require reviewed operators and registered data semantics.

## Converting PDFs into skills

Organise skills around formulation, experiment design, backtest critique and sizing. Several books can support one task. Keep source-specific detail in references.

For each method, retain the edition, chapter/page, assumptions, exact formula, worked example and a check that can reject an incorrect implementation. Verify extracted equations against the PDF. Evaluate the procedures on fresh examples, including the supplied scripts' timing and comparison defects.

Use concise workflows and original method notes. Do not place book PDFs or lengthy copied passages in the public repository. Reviewed procedures enter the explicit `packages/agents` behaviour bundle with a recorded version; installing a development skill does not activate it for deployed agents. Follow the [existing integration boundary](../product/production-skills.md#development-and-deployed-agents).

## Specification and delivery decision

- **OQ-02 §§2.4–2.6 and 3.7:** joint selection, shared strategy cash, daily event phases, the corrected seed family and its controlled comparison are canonical requirements.
- **OQ-03/OQ-04:** structured seed/revision proposals and authoring views expose extracted rules, unresolved assumptions and parent/child differences. OQ-05 owns coordinated dispatch and frozen joint inputs.
- **M1 (delivery mapping updated 2026-11-10):** S0 verifies the offline seed's signals, execution, accounting and local state restore through the shared Rust core. S1 reuses that evidence for connected competition. S4 includes joint watchlist replay and the four-candidate comparison. S5 uses bounded prior findings for revisions and verifies distributed recovery. OQ-06 owns acceptance; OQ-07 owns example provenance and publication. See the [roadmap](../product/roadmap.md).

Retain the existing account allocator and execution boundaries. No new service, agent role or numerical engine is needed for this proposal.

## Evidence and limits

This log records specification and source-code inspection plus publisher-source checks. No market-data backtest or full-book PDF analysis was performed. No strategy edge, skill effectiveness or runtime capability is established. Repository checks for a canonical update do not establish runtime acceptance.
