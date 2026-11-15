# M-08: A dividend paid at the ex-date before the open, a closed trade and a re-entry

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `C-04a` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Cash dividend; Cash and quantities.

## Inputs

- Initial capital E0 = 5000.00; fixed fee 0, fee 0 bps, gap-exit slippage 0 bps; withholding 0 bps.
- Scored sessions: 2026-01-08 to 2026-01-14 (5 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-01-08 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 2 | 2026-01-09 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 3 | 2026-01-12 | 5000.00 | 1000.00 | 1 | 5000 | 1/5 |
| 4 | 2026-01-13 | 5220.00 | 0.00 | 261/250 | 5220 | 0 |
| 5 | 2026-01-14 | 5216.00 | 1040.00 | 1304/1305 | 5220 | 65/326 |

## Steps

1. net_return = E(n) / E0 - 1 = 5216 / 5000 - 1 = 27/625 -> 0.043200.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 1/1305 -> 0.000766.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = -1/1305 -> -0.000766.
4. turnover = sum of fill notional / E0 = 3244 / 5000 -> 0.648800.
5. trade_count = 1, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 5.
6. execution cost: fees 0.00 (sum of the fill fees), gap slippage 0.00 (quantity times open minus fill price of each GAP_STOP fill), total 0.00.
7. exposure = mean of positions value / equity over the scored sessions = 651/8150 -> 0.079877.
8. buy-and-hold buys 100 shares at the open of 2026-01-08 (cash after the buy 0.00); net return 3/50 -> 0.060000, max drawdown -> 0.116667; excess = 27/625 - 3/50 -> -0.016800.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return 0.043200.
