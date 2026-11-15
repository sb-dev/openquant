# B-01: Buy and hold at the first scored open under a fixed fee

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from the input of the S0 case `X-09a`. Hand: 99 shares at 50.00 cost 4950.00 + 1.00; 100 shares would cost 5001.00.

- Capital 5000.00; fixed fee 1.00, fee 0 bps; scored window 2026-01-08 to 2026-01-15.
- The buy is the open of 2026-01-08: 99 shares, cash after the buy 49.00.

| Session | Equity after the close |
| --- | --- |
| 2026-01-08 | 4999.00 |
| 2026-01-09 | 5098.00 |
| 2026-01-12 | 4999.00 |
| 2026-01-13 | 5098.00 |
| 2026-01-14 | 5018.80 |
| 2026-01-15 | 5890.00 |

net_return = 5890 / 5000.00 - 1 = 89/500 -> 0.178000; max_drawdown 99/5098 -> 0.019419.
