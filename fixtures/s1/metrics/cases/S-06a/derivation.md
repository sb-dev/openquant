# S-06a: Half-even rounding at a tie of the sixth digit

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. The net return is 15/10000000 = 0.0000015, a tie between 0.000001 and 0.000002: the even digit 2.

Initial capital E0 = 10000000; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 10000015 | 0 | 2000003/2000000 | 10000015 | 0 |

## Results

1. net_return = E(n)/E0 - 1 = 3/2000000 -> 0.000002.
2. max_drawdown = 0 -> 0.000000.
3. worst_session_return = 3/2000000 -> 0.000002.
4. exposure = 0 -> 0.000000.
