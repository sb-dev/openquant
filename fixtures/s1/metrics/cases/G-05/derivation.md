# G-05: The buy-and-hold benchmark is unavailable in V

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the offline cohort policy and the evidence of `evidence.json` by the rules of OQ-02 sections 3.2 and 3.6 and the decision record D18. Hand: D and H hold; V has no excess to read, so the two gates that need it are INSUFFICIENT, never PASS. The net-return threshold of the same gate holds in V.

| Gate | Result | Reason code |
| --- | --- | --- |
| DEFINITION_VALIDATION | PASS |  |
| DETERMINISTIC_REPLAY | PASS |  |
| ACCOUNTING_RECONCILIATION | PASS |  |
| SIGNAL_DATA_TIMING | PASS |  |
| POINT_IN_TIME_DATA | PASS |  |
| BASE_COST_MODEL | PASS |  |
| EXCESS_OVER_BUY_AND_HOLD | INSUFFICIENT | BENCHMARK_UNAVAILABLE |
| WALK_FORWARD | INSUFFICIENT | BENCHMARK_UNAVAILABLE |
| MINIMUM_TRADE_COUNT | PASS |  |
| COST_STRESS | PASS |  |
| PARAMETER_SENSITIVITY | NOT_APPLICABLE | POLICY_RECORDED |
| EXECUTION_DELAY | NOT_APPLICABLE | POLICY_RECORDED |
| ADVERSE_REGIMES | NOT_APPLICABLE | POLICY_RECORDED |
| RESAMPLING | NOT_APPLICABLE | POLICY_RECORDED |
| PROSPECTIVE_EVIDENCE | NOT_APPLICABLE | POLICY_RECORDED |
| PORTFOLIO_FIT | NOT_APPLICABLE | POLICY_RECORDED |
| OPERATING_READINESS | NOT_APPLICABLE | POLICY_RECORDED |
