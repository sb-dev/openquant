# S-03: The first scored session loses: the drawdown peak is the initial capital

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. The series itself never falls after its first value, yet the fall from E0 = 100 to 90 is a drawdown of 1/10.

Initial capital E0 = 100; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 90 | 0 | 9/10 | 100 | 0 |
| 2 | 95 | 0 | 19/18 | 100 | 0 |
| 3 | 99 | 0 | 99/95 | 100 | 0 |

## Results

1. net_return = E(n)/E0 - 1 = -1/100 -> -0.010000.
2. max_drawdown = 1/10 -> 0.100000.
3. worst_session_return = -1/10 -> -0.100000.
4. exposure = 0 -> 0.000000.
