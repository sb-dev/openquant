# S-05: Exposure as a mean of 1/3, 1/6 and 1/7

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. Hand: (1/3 + 1/6 + 1/7) / 3 = (14 + 7 + 6) / 126 = 3/14 = 0.2142857...

Initial capital E0 = 300; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 300 | 100 | 1 | 300 | 1/3 |
| 2 | 600 | 100 | 2 | 600 | 1/6 |
| 3 | 700 | 100 | 7/6 | 700 | 1/7 |

## Results

1. net_return = E(n)/E0 - 1 = 4/3 -> 1.333333.
2. max_drawdown = 0 -> 0.000000.
3. worst_session_return = 0 -> 0.000000.
4. exposure = 3/14 -> 0.214286.
