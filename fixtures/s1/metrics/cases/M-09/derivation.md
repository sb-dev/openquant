# M-09: The lead's hand-derived smoke case

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `F0-smoke` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Local replay; Entry and exit phases; Cash and quantities; Shared payloads.

## Inputs

- Initial capital E0 = 5000.00; fixed fee 1.00, fee 0 bps, gap-exit slippage 0 bps; withholding 0 bps.
- Scored sessions: 2026-01-08 to 2026-01-16 (7 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-01-08 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 2 | 2026-01-09 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 3 | 2026-01-12 | 5026.00 | 945.00 | 2513/2500 | 5026 | 135/718 |
| 4 | 2026-01-13 | 5053.00 | 972.00 | 5053/5026 | 5053 | 972/5053 |
| 5 | 2026-01-14 | 5079.00 | 0.00 | 5079/5053 | 5079 | 0 |
| 6 | 2026-01-15 | 5105.00 | 1026.00 | 5105/5079 | 5105 | 1026/5105 |
| 7 | 2026-01-16 | 5132.00 | 1053.00 | 5132/5105 | 5132 | 1053/5132 |

## Steps

1. net_return = E(n) / E0 - 1 = 5132 / 5000 - 1 = 33/1250 -> 0.026400.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 0 -> 0.000000.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = 0 -> 0.000000.
4. turnover = sum of fill notional / E0 = 2916 / 5000 -> 0.583200.
5. trade_count = 1, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 7.
6. execution cost: fees 3.00 (sum of the fill fees), gap slippage 0.00 (quantity times open minus fill price of each GAP_STOP fill), total 3.00.
7. exposure = mean of positions value / equity over the scored sessions = 37380937335849/332678075864540 -> 0.112364.
8. buy-and-hold buys 49 shares at the open of 2026-01-08 (cash after the buy 99.00); net return 104/625 -> 0.166400, max drawdown -> 0.000200; excess = 33/1250 - 104/625 -> -0.140000.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return 0.026400.
