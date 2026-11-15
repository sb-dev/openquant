# B-11: A split and a dividend on one ex-date: the dividend counts the shares held before the split

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from the input of the S0 case `C-05`. Hand: 50 shares at 100.00; on 01-14 the dividend of 1.00 is paid on the 50 shares held before the split (50.00), then the split gives 100 shares.

- Capital 5000.00; fixed fee 0, fee 0 bps; scored window 2026-01-08 to 2026-01-15.
- The buy is the open of 2026-01-08: 50 shares, cash after the buy 0.00.

| Session | Equity after the close |
| --- | --- |
| 2026-01-08 | 5000.00 |
| 2026-01-09 | 5050.00 |
| 2026-01-12 | 5000.00 |
| 2026-01-13 | 5050.00 |
| 2026-01-14 | 5200.00 |
| 2026-01-15 | 5250.00 |

net_return = 5250 / 5000.00 - 1 = 1/20 -> 0.050000; max_drawdown 1/101 -> 0.009901.
