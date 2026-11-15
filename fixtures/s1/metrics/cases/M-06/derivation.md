# M-06: A dividend entitled in the run and paid inside it; the position is open at the end

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `C-03` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Cash dividend.

## Inputs

- Initial capital E0 = 5000.00; fixed fee 0, fee 0 bps, gap-exit slippage 0 bps; withholding 0 bps.
- Scored sessions: 2026-01-08 to 2026-01-15 (6 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-01-08 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 2 | 2026-01-09 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 3 | 2026-01-12 | 5000.00 | 1000.00 | 1 | 5000 | 1/5 |
| 4 | 2026-01-13 | 5000.00 | 980.00 | 1 | 5000 | 49/250 |
| 5 | 2026-01-14 | 5000.00 | 980.00 | 1 | 5000 | 49/250 |
| 6 | 2026-01-15 | 5000.00 | 980.00 | 1 | 5000 | 49/250 |

## Steps

1. net_return = E(n) / E0 - 1 = 5000 / 5000 - 1 = 0 -> 0.000000.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 0 -> 0.000000.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = 0 -> 0.000000.
4. turnover = sum of fill notional / E0 = 1000 / 5000 -> 0.200000.
5. trade_count = 0, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 6.
6. execution cost: fees 0.00 (sum of the fill fees), gap slippage 0.00 (quantity times open minus fill price of each GAP_STOP fill), total 0.00.
7. exposure = mean of positions value / equity over the scored sessions = 197/1500 -> 0.131333.
8. buy-and-hold buys 100 shares at the open of 2026-01-08 (cash after the buy 0.00); net return 0 -> 0.000000, max drawdown -> 0.019608; excess = 0 - 0 -> 0.000000.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return 0.000000.
