# M-01: A winning run: one TARGET trade under a fixed fee

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `X-09a` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Entry and exit phases; Definition execution.

## Inputs

- Initial capital E0 = 5000.00; fixed fee 1.00, fee 0 bps, gap-exit slippage 0 bps; withholding 0 bps.
- Scored sessions: 2026-01-08 to 2026-01-15 (6 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-01-08 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 2 | 2026-01-09 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 3 | 2026-01-12 | 4999.00 | 950.00 | 4999/5000 | 5000 | 950/4999 |
| 4 | 2026-01-13 | 5018.00 | 969.00 | 5018/4999 | 5018 | 969/5018 |
| 5 | 2026-01-14 | 5002.80 | 953.80 | 12507/12545 | 5018 | 4769/25014 |
| 6 | 2026-01-15 | 5188.00 | 0.00 | 12970/12507 | 5188 | 0 |

## Steps

1. net_return = E(n) / E0 - 1 = 5188 / 5000 - 1 = 47/1250 -> 0.037600.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 38/12545 -> 0.003029.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = -38/12545 -> -0.003029.
4. turnover = sum of fill notional / E0 = 2090 / 5000 -> 0.418000.
5. trade_count = 1, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 6.
6. execution cost: fees 2.00 (sum of the fill fees), gap slippage 0.00 (quantity times open minus fill price of each GAP_STOP fill), total 2.00.
7. exposure = mean of positions value / equity over the scored sessions = 45005388749/470606804811 -> 0.095633.
8. buy-and-hold buys 99 shares at the open of 2026-01-08 (cash after the buy 49.00); net return 89/500 -> 0.178000, max drawdown -> 0.019419; excess = 47/1250 - 89/500 -> -0.140400.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return 0.037600.
