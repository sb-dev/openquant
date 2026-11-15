# S-07b: Ratio scale 0

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. Net return 1/3 rounds to 0; exposure 1/4 rounds to 0.

Initial capital E0 = 3; metric scale 0.

| t | Equity | Positions value | E(t)/E(t-1) | Peak P(t) | Positions / equity |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 | 1 | 4/3 | 4 | 1/4 |

## Results

1. net_return = E(n)/E0 - 1 = 1/3 -> 0.
2. max_drawdown = 0 -> 0.
3. worst_session_return = 1/3 -> 0.
4. exposure = 1/4 -> 0.
