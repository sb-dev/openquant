# G-18c: Decimals that differ in text and not in value

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the offline cohort policy and the evidence of `evidence.json` by the rules of OQ-02 sections 3.2 and 3.6 and the decision record D18. Hand: 0 equals 0.00 and 5.0 equals 5.

| Gate | Result | Reason code |
| --- | --- | --- |
| DEFINITION_VALIDATION | PASS |  |
| DETERMINISTIC_REPLAY | PASS |  |
| ACCOUNTING_RECONCILIATION | PASS |  |
| SIGNAL_DATA_TIMING | PASS |  |
| POINT_IN_TIME_DATA | PASS |  |
| BASE_COST_MODEL | PASS |  |
| EXCESS_OVER_BUY_AND_HOLD | PASS |  |
| WALK_FORWARD | PASS |  |
| MINIMUM_TRADE_COUNT | PASS |  |
| COST_STRESS | PASS |  |
| PARAMETER_SENSITIVITY | NOT_APPLICABLE | POLICY_RECORDED |
| EXECUTION_DELAY | NOT_APPLICABLE | POLICY_RECORDED |
| ADVERSE_REGIMES | NOT_APPLICABLE | POLICY_RECORDED |
| RESAMPLING | NOT_APPLICABLE | POLICY_RECORDED |
| PROSPECTIVE_EVIDENCE | NOT_APPLICABLE | POLICY_RECORDED |
| PORTFOLIO_FIT | NOT_APPLICABLE | POLICY_RECORDED |
| OPERATING_READINESS | NOT_APPLICABLE | POLICY_RECORDED |
