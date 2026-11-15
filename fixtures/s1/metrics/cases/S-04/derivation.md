# S-04: Every session rises: the worst session return is positive

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. Steps 101/100, 103/101 and 106/103; the smallest is 101/100.

Initial capital E0 = 100; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 101 | 0 | 101/100 | 101 | 0 |
| 2 | 103 | 0 | 103/101 | 103 | 0 |
| 3 | 106 | 0 | 106/103 | 106 | 0 |

## Results

1. net_return = E(n)/E0 - 1 = 3/50 -> 0.060000.
2. max_drawdown = 0 -> 0.000000.
3. worst_session_return = 1/100 -> 0.010000.
4. exposure = 0 -> 0.000000.
