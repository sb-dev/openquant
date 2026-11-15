# B-07a: The fee boundary: costs of 100 bps (base)

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from a patched copy of the input of the S0 case `X-09a`. Hand: at 100 bps, 100 shares cost 5000.00 + 50.00; the capital is 5050.00, so the largest quantity is 100.

- Capital 5050.00; fixed fee 0.00, fee 100 bps; scored window 2026-01-08 to 2026-01-15.
- The buy is the open of 2026-01-08: 100 shares, cash after the buy 0.00.

| Session | Equity after the close |
| --- | --- |
| 2026-01-08 | 5000.00 |
| 2026-01-09 | 5100.00 |
| 2026-01-12 | 5000.00 |
| 2026-01-13 | 5100.00 |
| 2026-01-14 | 5020.00 |
| 2026-01-15 | 5900.00 |

net_return = 5900 / 5050.00 - 1 = 17/101 -> 0.168317; max_drawdown 1/51 -> 0.019608.
