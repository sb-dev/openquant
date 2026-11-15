# M-12: A fixed fee of 19.90 and 0.05 bps on a capital of 4999.50

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `X-03` (`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding at the end, ratios to 6 digits and money to 2. Covers: Cash and quantities.

## Inputs

- Initial capital E0 = 4999.50; fixed fee 19.90, fee 0.05 bps, gap-exit slippage 0 bps; withholding 0 bps.
- Scored sessions: 2026-01-08 to 2026-01-14 (5 sessions).

## Scored series

| t | Session | Equity E(t) | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-01-08 | 4999.50 | 0.00 | 1 | 9999/2 | 0 |
| 2 | 2026-01-09 | 4999.50 | 0.00 | 1 | 9999/2 | 0 |
| 3 | 2026-01-12 | 4979.59 | 931.00 | 45269/45450 | 9999/2 | 13300/71137 |
| 4 | 2026-01-13 | 4979.59 | 931.00 | 1 | 9999/2 | 13300/71137 |
| 5 | 2026-01-14 | 4979.59 | 931.00 | 1 | 9999/2 | 13300/71137 |

## Steps

1. net_return = E(n) / E0 - 1 = 497959/100 / 9999/2 - 1 = -181/45450 -> -0.003982.
2. max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: 181/45450 -> 0.003982.
3. worst_session_return = min of E(t)/E(t-1) minus 1 = -181/45450 -> -0.003982.
4. turnover = sum of fill notional / E0 = 931 / 9999/2 -> 0.186219.
5. trade_count = 0, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = 5.
6. execution cost: fees 19.91 (sum of the fill fees), gap slippage 0.00 (quantity times open minus fill price of each GAP_STOP fill), total 19.91.
7. exposure = mean of positions value / equity over the scored sessions = 7980/71137 -> 0.112178.
8. buy-and-hold buys 101 shares at the open of 2026-01-08 (cash after the buy 30.57); net return -1993/499950 -> -0.003986, max drawdown -> 0.019880; excess = -181/45450 - -1993/499950 -> 0.000004.
9. cash benchmark: net_return 0.000000, excess_return equals the strategy net_return -0.003982.
