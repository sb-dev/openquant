# M-11: A long run: 94 scored sessions, one position opened late and never closed

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `SEM-04` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Seed semantics; Entry variants.

## Inputs

- Initial capital E0 = 10000.00; fixed fee 1.00, fee 0 bps, gap-exit slippage 0 bps; withholding 0 bps.
- Scored sessions: 2026-03-16 to 2026-07-23 (94 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-03-16 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 2 | 2026-03-17 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 3 | 2026-03-18 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 4 | 2026-03-19 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 5 | 2026-03-20 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 6 | 2026-03-23 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 88 | 2026-07-15 | 9999.00 | 1872.60 | 9999/10000 | 10000 | 3121/16665 |

(Rows with a change of equity only; 94 sessions in all.)

## Steps

1. net_return = E(n) / E0 - 1 = 9999 / 10000 - 1 = -1/10000 -> -0.000100.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 1/10000 -> 0.000100.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = -1/10000 -> -0.000100.
4. turnover = sum of fill notional / E0 = 9363/5 / 10000 -> 0.187260.
5. trade_count = 0, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 94.
6. execution cost: fees 1.00 (sum of the fill fees), gap slippage 0.00 (quantity times open minus fill price of each GAP_STOP fill), total 1.00.
7. exposure = mean of positions value / equity over the scored sessions = 21847/1566510 -> 0.013946.
8. buy-and-hold buys 85 shares at the open of 2026-03-16 (cash after the buy 35.30); net return 65991/200000 -> 0.329955, max drawdown -> 0.027814; excess = -1/10000 - 65991/200000 -> -0.330055.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return -0.000100.
