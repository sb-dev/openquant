# S-02: A flat series: no return, no drawdown, no move

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. Nothing moves, so every ratio is zero.

Initial capital E0 = 100; metric scale 6.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 100 | 0 | 1 | 100 | 0 |
| 2 | 100 | 0 | 1 | 100 | 0 |
| 3 | 100 | 0 | 1 | 100 | 0 |

## Results

1. net_return = E(n)/E0 - 1 = 0 -> 0.000000.
2. max_drawdown = 0 -> 0.000000.
3. worst_session_return = 0 -> 0.000000.
4. exposure = 0 -> 0.000000.
