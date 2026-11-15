# S-06d: Half-even rounding at a tie of the sixth digit

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. 0.0000005 is a tie between 0.000000 and 0.000001: the even digit 0.

Initial capital E0 = 10000000; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 10000005 | 0 | 2000001/2000000 | 10000005 | 0 |

## Results

1. net_return = E(n)/E0 - 1 = 1/2000000 -> 0.000000.
2. max_drawdown = 0 -> 0.000000.
3. worst_session_return = 1/2000000 -> 0.000000.
4. exposure = 0 -> 0.000000.
