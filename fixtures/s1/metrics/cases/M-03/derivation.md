# M-03: A split and a dividend inside the holding period, three trades, costs and withholding

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `R-01` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Local replay; Split across an ex-date; Cash dividend; Entry and exit phases; Shared payloads.

## Inputs

- Initial capital E0 = 10000.00; fixed fee 1.00, fee 10 bps, gap-exit slippage 50 bps; withholding 1000 bps.
- Scored sessions: 2026-01-08 to 2026-01-30 (17 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-01-08 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 2 | 2026-01-09 | 10000.00 | 0.00 | 1 | 10000 | 0 |
| 3 | 2026-01-12 | 9997.10 | 1900.00 | 99971/100000 | 10000 | 19000/99971 |
| 4 | 2026-01-13 | 10035.10 | 1938.00 | 100351/99971 | 100351/10 | 1140/5903 |
| 5 | 2026-01-14 | 9994.20 | 0.00 | 99942/100351 | 100351/10 | 0 |
| 6 | 2026-01-15 | 9994.20 | 0.00 | 1 | 100351/10 | 0 |
| 7 | 2026-01-16 | 9994.20 | 0.00 | 1 | 100351/10 | 0 |
| 8 | 2026-01-19 | 9994.20 | 0.00 | 1 | 100351/10 | 0 |
| 9 | 2026-01-20 | 9994.20 | 0.00 | 1 | 100351/10 | 0 |
| 10 | 2026-01-21 | 9991.30 | 1900.00 | 99913/99942 | 100351/10 | 19000/99913 |
| 11 | 2026-01-22 | 10368.02 | 0.00 | 518401/499565 | 518401/50 | 0 |
| 12 | 2026-01-23 | 10403.99 | 2067.00 | 1040399/1036802 | 1040399/100 | 206700/1040399 |
| 13 | 2026-01-26 | 10442.99 | 2106.00 | 1044299/1040399 | 1044299/100 | 210600/1044299 |
| 14 | 2026-01-27 | 10520.99 | 2184.00 | 1052099/1044299 | 1052099/100 | 218400/1052099 |
| 15 | 2026-01-28 | 10571.67 | 2223.00 | 1057167/1052099 | 1057167/100 | 24700/117463 |
| 16 | 2026-01-29 | 10532.67 | 2184.00 | 351089/352389 | 1057167/100 | 72800/351089 |
| 17 | 2026-01-30 | 10532.67 | 2184.00 | 1 | 1057167/100 | 72800/351089 |

## Steps

1. net_return = E(n) / E0 - 1 = 1053267/100 / 10000 - 1 = 53267/1000000 -> 0.053267.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 438/100351 -> 0.004365.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = -409/100351 -> -0.004076.
4. turnover = sum of fill notional / E0 = 10008 / 10000 -> 1.000800.
5. trade_count = 2, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 17.
6. execution cost: fees 15.01 (sum of the fill fees), gap slippage 0.00 (quantity times open minus fill price of each GAP_STOP fill), total 15.01.
7. exposure = mean of positions value / equity over the scored sessions = 5020511385985155554852815482716851828875660/47251701046279928082396952488858675908990189 -> 0.106250.
8. buy-and-hold buys 99 shares at the open of 2026-01-08 (cash after the buy 89.10); net return 30911/250000 -> 0.123644, max drawdown -> 0.019436; excess = 53267/1000000 - 30911/250000 -> -0.070377.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return 0.053267.
