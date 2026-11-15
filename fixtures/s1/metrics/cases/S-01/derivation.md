# S-01: Drawdown ties: an equal peak, an equal trough and an equal depth from a different peak

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. Peaks 110, 110 and 120; troughs 99, 99 and 108. Each fall is a tenth of its peak: 11/110, 11/110, 12/120.

Initial capital E0 = 100; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 110 | 0 | 11/10 | 110 | 0 |
| 2 | 99 | 0 | 9/10 | 110 | 0 |
| 3 | 110 | 0 | 10/9 | 110 | 0 |
| 4 | 99 | 0 | 9/10 | 110 | 0 |
| 5 | 120 | 0 | 40/33 | 120 | 0 |
| 6 | 108 | 0 | 9/10 | 120 | 0 |
| 7 | 120 | 0 | 10/9 | 120 | 0 |

## Results

1. net_return = E(n)/E0 - 1 = 1/5 -> 0.200000.
2. max_drawdown = 1/10 -> 0.100000.
3. worst_session_return = -1/10 -> -0.100000.
4. exposure = 0 -> 0.000000.
