# S-06c: Half-even rounding at a tie of the sixth digit

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. The negative twin of S-06a: -0.0000015 rounds to -0.000002.

Initial capital E0 = 10000000; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 9999985 | 0 | 1999997/2000000 | 10000000 | 0 |

## Results

1. net_return = E(n)/E0 - 1 = -3/2000000 -> -0.000002.
2. max_drawdown = 3/2000000 -> 0.000002.
3. worst_session_return = -3/2000000 -> -0.000002.
4. exposure = 0 -> 0.000000.
