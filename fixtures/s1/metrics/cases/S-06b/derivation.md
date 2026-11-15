# S-06b: Half-even rounding at a tie of the sixth digit

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. 0.0000025 is a tie between 0.000002 and 0.000003: the even digit 2.

Initial capital E0 = 10000000; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 10000025 | 0 | 400001/400000 | 10000025 | 0 |

## Results

1. net_return = E(n)/E0 - 1 = 1/400000 -> 0.000002.
2. max_drawdown = 0 -> 0.000000.
3. worst_session_return = 1/400000 -> 0.000002.
4. exposure = 0 -> 0.000000.
