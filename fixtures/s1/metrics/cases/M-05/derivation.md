# M-05: A gap-through-stop exit with a fee in basis points

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `X-05` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Entry and exit phases; Cash and quantities.

## Inputs

- Initial capital E0 = 5000.00; fixed fee 1.00, fee 10 bps, gap-exit slippage 100 bps; withholding 0 bps.
- Scored sessions: 2026-01-08 to 2026-01-15 (6 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-01-08 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 2 | 2026-01-09 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 3 | 2026-01-12 | 4998.05 | 950.00 | 99961/100000 | 5000 | 19000/99961 |
| 4 | 2026-01-13 | 4880.69 | 0.00 | 488069/499805 | 5000 | 0 |
| 5 | 2026-01-14 | 4880.69 | 0.00 | 1 | 5000 | 0 |
| 6 | 2026-01-15 | 4880.69 | 0.00 | 1 | 5000 | 0 |

## Steps

1. net_return = E(n) / E0 - 1 = 488069/100 / 5000 - 1 = -11931/500000 -> -0.023862.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 11931/500000 -> 0.023862.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = -11736/499805 -> -0.023481.
4. turnover = sum of fill notional / E0 = 44612/25 / 5000 -> 0.356896.
5. trade_count = 1, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 6.
6. execution cost: fees 3.79 (sum of the fill fees), gap slippage 8.55 (quantity times open minus fill price of each GAP_STOP fill), total 12.34.
7. exposure = mean of positions value / equity over the scored sessions = 9500/299883 -> 0.031679.
8. buy-and-hold buys 99 shares at the open of 2026-01-08 (cash after the buy 44.05); net return -11999/100000 -> -0.119990, max drawdown -> 0.136068; excess = -11931/500000 - -11999/100000 -> 0.096128.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return -0.023862.
