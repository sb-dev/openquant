# M-10: A run that never trades: every figure is zero and the benchmark is computed

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `ENT-02-v1` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Entry variants; Definition execution.

## Inputs

- Initial capital E0 = 10000.00; fixed fee 1.00, fee 0 bps, gap-exit slippage 0 bps; withholding 0 bps.
- Scored sessions: 2026-03-16 to 2026-04-02 (14 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-03-16 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 2 | 2026-03-17 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 3 | 2026-03-18 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 4 | 2026-03-19 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 5 | 2026-03-20 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 6 | 2026-03-23 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 7 | 2026-03-24 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 8 | 2026-03-25 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 9 | 2026-03-26 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 10 | 2026-03-27 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 11 | 2026-03-30 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 12 | 2026-03-31 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 13 | 2026-04-01 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 14 | 2026-04-02 | 10000.00 | 0.00 | 1 | 10000 | 0 |

## Steps

1. net_return = E(n) / E0 - 1 = 10000 / 10000 - 1 = 0 -> 0.000000.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 0 -> 0.000000.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = 0 -> 0.000000.
4. turnover = sum of fill notional / E0 = 0 / 10000 -> 0.000000.
5. trade_count = 0, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 14.
6. execution cost: fees 0.00 (sum of the fill fees), gap slippage 0.00 (quantity times open minus fill price of each GAP_STOP fill), total 0.00.
7. exposure = mean of positions value / equity over the scored sessions = 0 -> 0.000000.
8. buy-and-hold buys 84 shares at the open of 2026-03-16 (cash after the buy 109.68); net return -1619/125000 -> -0.012952, max drawdown -> 0.019198; excess = 0 - -1619/125000 -> 0.012952.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return 0.000000.
