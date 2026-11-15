# G-02: The expected S1 outcome: no eligible candidate

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the pilot cohort policy and the evidence of `evidence.json` by the rules of OQ-02 sections 3.2 and 3.6 and the decision record D18. Hand: excess return is positive in D only, so EXCESS_OVER_BUY_AND_HOLD, WALK_FORWARD and COST_STRESS fail; trade counts 11, 9 and 8 are below 10, so MINIMUM_TRADE_COUNT is INSUFFICIENT with BELOW_THRESHOLD; the three robustness checks are INSUFFICIENT by policy and the other four gates NOT_APPLICABLE.

| Gate | Result | Reason code |
| --- | --- | --- |
| DEFINITION_VALIDATION | PASS |  |
| DETERMINISTIC_REPLAY | PASS |  |
| ACCOUNTING_RECONCILIATION | PASS |  |
| SIGNAL_DATA_TIMING | PASS |  |
| POINT_IN_TIME_DATA | PASS |  |
| BASE_COST_MODEL | PASS |  |
| EXCESS_OVER_BUY_AND_HOLD | FAIL |  |
| WALK_FORWARD | FAIL |  |
| MINIMUM_TRADE_COUNT | INSUFFICIENT | BELOW_THRESHOLD |
| COST_STRESS | FAIL |  |
| PARAMETER_SENSITIVITY | INSUFFICIENT | POLICY_RECORDED |
| EXECUTION_DELAY | INSUFFICIENT | POLICY_RECORDED |
| ADVERSE_REGIMES | INSUFFICIENT | POLICY_RECORDED |
| RESAMPLING | NOT_APPLICABLE | POLICY_RECORDED |
| PROSPECTIVE_EVIDENCE | NOT_APPLICABLE | POLICY_RECORDED |
| PORTFOLIO_FIT | NOT_APPLICABLE | POLICY_RECORDED |
| OPERATING_READINESS | NOT_APPLICABLE | POLICY_RECORDED |
