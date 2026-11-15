# B-07b: The fee boundary: costs of 200 bps (twice the base)

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from a patched copy of the input of the S0 case `X-09a`. Hand: at 200 bps, 100 shares cost 5000.00 + 100.00; the capital is 5050.00, so the largest quantity is 99.

- Capital 5050.00; fixed fee 0.00, fee 200 bps; scored window 2026-01-08 to 2026-01-15.
- The buy is the open of 2026-01-08: 99 shares, cash after the buy 1.00.

| Session | Equity after the close |
| --- | --- |
| 2026-01-08 | 4951.00 |
| 2026-01-09 | 5050.00 |
| 2026-01-12 | 4951.00 |
| 2026-01-13 | 5050.00 |
| 2026-01-14 | 4970.80 |
| 2026-01-15 | 5842.00 |

net_return = 5842 / 5050.00 - 1 = 396/2525 -> 0.156832; max_drawdown 99/5050 -> 0.019604.
