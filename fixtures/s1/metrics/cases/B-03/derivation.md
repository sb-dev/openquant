# B-03: A dividend paid inside the window and one paid after its end

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from a patched copy of the input of the S0 case `C-03`. The second dividend pays on 2026-01-16, a calendar session after the scored end: its receivable stays in equity at the final mark. Hand: 100 shares; 100.00 on 01-13, 25.00 on 01-14.

- Capital 5000.00; fixed fee 0, fee 0 bps; scored window 2026-01-08 to 2026-01-15.
- The buy is the open of 2026-01-08: 100 shares, cash after the buy 0.00.

| Session | Equity after the close |
| --- | --- |
| 2026-01-08 | 5000.00 |
| 2026-01-09 | 5100.00 |
| 2026-01-12 | 5000.00 |
| 2026-01-13 | 5000.00 |
| 2026-01-14 | 5025.00 |
| 2026-01-15 | 5025.00 |

net_return = 5025 / 5000.00 - 1 = 1/200 -> 0.005000; max_drawdown 1/51 -> 0.019608.
