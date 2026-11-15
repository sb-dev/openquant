# M-15: Ratio scale 0: every ratio rounds to a whole number and never to -0

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `X-08` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 0 digits and money to 2. Covers: Entry and exit phases; Cash and quantities.

## Inputs

- Initial capital E0 = 5000.00; fixed fee 1.00, fee 0 bps, gap-exit slippage 100 bps; withholding 0 bps.
- Scored sessions: 2026-01-08 to 2026-02-09 (23 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-01-08 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 2 | 2026-01-09 | 5000.00 | 0.00 | 1 | 5000 | 0 |
| 3 | 2026-01-12 | 4999.00 | 950.00 | 4999/5000 | 5000 | 950/4999 |
| 4 | 2026-01-13 | 4922.00 | 0.00 | 4922/4999 | 5000 | 0 |
| 5 | 2026-01-14 | 4922.00 | 0.00 | 1 | 5000 | 0 |
| 6 | 2026-01-15 | 4922.00 | 0.00 | 1 | 5000 | 0 |
| 7 | 2026-01-16 | 4922.00 | 0.00 | 1 | 5000 | 0 |
| 8 | 2026-01-19 | 4922.00 | 0.00 | 1 | 5000 | 0 |
| 9 | 2026-01-20 | 4921.00 | 960.00 | 4921/4922 | 5000 | 960/4921 |
| 10 | 2026-01-21 | 5120.00 | 0.00 | 5120/4921 | 5120 | 0 |
| 11 | 2026-01-22 | 5120.00 | 0.00 | 1 | 5120 | 0 |
| 12 | 2026-01-23 | 5120.00 | 0.00 | 1 | 5120 | 0 |
| 13 | 2026-01-26 | 5120.00 | 0.00 | 1 | 5120 | 0 |
| 14 | 2026-01-27 | 5120.00 | 0.00 | 1 | 5120 | 0 |
| 15 | 2026-01-28 | 5119.00 | 1008.00 | 5119/5120 | 5120 | 1008/5119 |
| 16 | 2026-01-29 | 5024.76 | 0.00 | 125619/127975 | 5120 | 0 |
| 17 | 2026-01-30 | 5024.76 | 0.00 | 1 | 5120 | 0 |
| 18 | 2026-02-02 | 5024.76 | 0.00 | 1 | 5120 | 0 |
| 19 | 2026-02-03 | 5024.76 | 0.00 | 1 | 5120 | 0 |
| 20 | 2026-02-04 | 5024.76 | 0.00 | 1 | 5120 | 0 |
| 21 | 2026-02-05 | 5023.76 | 968.00 | 125594/125619 | 5120 | 12100/62797 |
| 22 | 2026-02-06 | 5242.76 | 0.00 | 131069/125594 | 131069/25 | 0 |
| 23 | 2026-02-09 | 5242.76 | 0.00 | 1 | 131069/25 | 0 |

## Steps

1. net_return = E(n) / E0 - 1 = 131069/25 / 5000 - 1 = 6069/125000 -> 0.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 1203/64000 -> 0.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = -2356/127975 -> 0.
4. turnover = sum of fill notional / E0 = 200569/25 / 5000 -> 2.
5. trade_count = 4, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 23.
6. execution cost: fees 8.00 (sum of the fill fees), gap slippage 9.24 (quantity times open minus fill price of each GAP_STOP fill), total 17.24.
7. exposure = mean of positions value / equity over the scored sessions = 875197781929482/25983061665471533 -> 0.
8. buy-and-hold buys 99 shares at the open of 2026-01-08 (cash after the buy 49.00); net return -119/1000 -> 0, max drawdown -> 0; excess = 6069/125000 - -119/1000 -> 0.
9. cash benchmark: net_return 0, excess_return equals the strategy net_return 0.
