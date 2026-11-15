# S-06e: Half-even rounding at a tie of the sixth digit

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. The negative twin -0.0000005 rounds to zero and is written without a sign.

Initial capital E0 = 10000000; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 9999995 | 0 | 1999999/2000000 | 10000000 | 0 |

## Results

1. net_return = E(n)/E0 - 1 = -1/2000000 -> 0.000000.
2. max_drawdown = 1/2000000 -> 0.000000.
3. worst_session_return = -1/2000000 -> 0.000000.
4. exposure = 0 -> 0.000000.
