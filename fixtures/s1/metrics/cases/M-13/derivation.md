# M-13: A gap-stop exit in a 64-session run

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `DEF-02-v4` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Definition execution; Entry and exit phases.

## Inputs

- Initial capital E0 = 10000.00; fixed fee 1.00, fee 0 bps, gap-exit slippage 50 bps; withholding 0 bps.
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
| 8 | 2026-03-25 | 9999.00 | 1975.40 | 9999/10000 | 10000 | 9877/49995 |
| 9 | 2026-03-26 | 10016.00 | 1992.40 | 10016/9999 | 10016 | 4981/25040 |
| 10 | 2026-03-27 | 9971.14 | 0.00 | 498557/500800 | 10016 | 0 |
| 11 | 2026-03-30 | 9971.14 | 0.00 | 1 | 10016 | 0 |
| 12 | 2026-03-31 | 9971.14 | 0.00 | 1 | 10016 | 0 |
| 13 | 2026-04-01 | 9971.14 | 0.00 | 1 | 10016 | 0 |
| 14 | 2026-04-02 | 9971.14 | 0.00 | 1 | 10016 | 0 |

## Steps

1. net_return = E(n) / E0 - 1 = 498557/50 / 10000 - 1 = -1443/500000 -> -0.002886.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 2243/500800 -> 0.004479.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = -2243/500800 -> -0.004479.
4. turnover = sum of fill notional / E0 = 196197/50 / 10000 -> 0.392394.
5. trade_count = 1, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 14.
6. execution cost: fees 2.00 (sum of the fill fees), gap slippage 9.86 (quantity times open minus fill price of each GAP_STOP fill), total 11.86.
7. exposure = mean of positions value / equity over the scored sessions = 19853807/701049888 -> 0.028320.
8. buy-and-hold buys 84 shares at the open of 2026-03-16 (cash after the buy 109.68); net return -5819/125000 -> -0.046552, max drawdown -> 0.052585; excess = -1443/500000 - -5819/125000 -> 0.043666.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return -0.002886.
