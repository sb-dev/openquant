# G-07: A measured failure wins over missing evidence

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the offline cohort policy and the evidence of `evidence.json` by the rules of OQ-02 sections 3.2 and 3.6 and the decision record D18. Hand: D fails its excess threshold and its trade count; H is missing. A threshold that provably fails cannot be rescued by the missing window: the excess gate is FAIL (below_threshold FAIL), the trade-count gate INSUFFICIENT with BELOW_THRESHOLD, not RUN_MISSING.

| Gate | Result | Reason code |
| --- | --- | --- |
| DEFINITION_VALIDATION | PASS |  |
| DETERMINISTIC_REPLAY | PASS |  |
| ACCOUNTING_RECONCILIATION | INSUFFICIENT | RUN_MISSING |
| SIGNAL_DATA_TIMING | INSUFFICIENT | RUN_MISSING |
| POINT_IN_TIME_DATA | PASS |  |
| BASE_COST_MODEL | INSUFFICIENT | RUN_MISSING |
| EXCESS_OVER_BUY_AND_HOLD | FAIL |  |
| WALK_FORWARD | FAIL |  |
| MINIMUM_TRADE_COUNT | INSUFFICIENT | BELOW_THRESHOLD |
| COST_STRESS | PASS |  |
| PARAMETER_SENSITIVITY | NOT_APPLICABLE | POLICY_RECORDED |
| EXECUTION_DELAY | NOT_APPLICABLE | POLICY_RECORDED |
| ADVERSE_REGIMES | NOT_APPLICABLE | POLICY_RECORDED |
| RESAMPLING | NOT_APPLICABLE | POLICY_RECORDED |
| PROSPECTIVE_EVIDENCE | NOT_APPLICABLE | POLICY_RECORDED |
| PORTFOLIO_FIT | NOT_APPLICABLE | POLICY_RECORDED |
| OPERATING_READINESS | NOT_APPLICABLE | POLICY_RECORDED |
