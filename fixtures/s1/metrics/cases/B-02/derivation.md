# B-02: A 2-for-1 split inside the window doubles the quantity

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from the input of the S0 case `C-01a`. Hand: 50 shares at 100.00 (capital 5000, no fee); closes 100 101 100 102, then the split on 01-14 gives 100 shares at 51.50 and 52.

- Capital 5000.00; fixed fee 0, fee 0 bps; scored window 2026-01-08 to 2026-01-15.
- The buy is the open of 2026-01-08: 50 shares, cash after the buy 0.00.

| Session | Equity after the close |
| --- | --- |
| 2026-01-08 | 5000.00 |
| 2026-01-09 | 5050.00 |
| 2026-01-12 | 5000.00 |
| 2026-01-13 | 5100.00 |
| 2026-01-14 | 5150.00 |
| 2026-01-15 | 5200.00 |

net_return = 5200 / 5000.00 - 1 = 1/25 -> 0.040000; max_drawdown 1/101 -> 0.009901.
