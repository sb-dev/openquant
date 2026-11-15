# B-10: A dividend on the buy session pays nothing; a later one pays on the shares held

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from a patched copy of the input of the S0 case `X-09a`. Hand: 99 shares are bought at the open of the ex-date 01-08, so DIV-A is worth 0.00; DIV-B pays 99 * 0.40 = 39.60 on 01-13.

- Capital 5000.00; fixed fee 1.00, fee 0 bps; scored window 2026-01-08 to 2026-01-15.
- The buy is the open of 2026-01-08: 99 shares, cash after the buy 49.00.

| Session | Equity after the close |
| --- | --- |
| 2026-01-08 | 4999.00 |
| 2026-01-09 | 5098.00 |
| 2026-01-12 | 4999.00 |
| 2026-01-13 | 5137.60 |
| 2026-01-14 | 5058.40 |
| 2026-01-15 | 5929.60 |

net_return = 29648/5 / 5000.00 - 1 = 581/3125 -> 0.185920; max_drawdown 99/5098 -> 0.019419.
