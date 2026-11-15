# B-04: The first scored session has no bar: the buy is the next session's open

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from a patched copy of the input of the S0 case `X-09a`. Hand: the open of 2026-01-09 is 50; 99 shares, cash 49.00; closes 51 50 51 50.2 59. Equity before the buy is the capital.

- Capital 5000.00; fixed fee 1.00, fee 0 bps; scored window 2026-01-08 to 2026-01-15.
- The buy is the open of 2026-01-09: 99 shares, cash after the buy 49.00.

| Session | Equity after the close |
| --- | --- |
| 2026-01-08 | 5000.00 |
| 2026-01-09 | 5098.00 |
| 2026-01-12 | 4999.00 |
| 2026-01-13 | 5098.00 |
| 2026-01-14 | 5018.80 |
| 2026-01-15 | 5890.00 |

net_return = 5890 / 5000.00 - 1 = 89/500 -> 0.178000; max_drawdown 99/5098 -> 0.019419.
