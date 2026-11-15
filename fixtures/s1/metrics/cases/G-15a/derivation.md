# G-15a: Three bars have no availability time

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the pilot cohort policy and the evidence of `evidence.json` by the rules of OQ-02 sections 3.2 and 3.6 and the decision record D18. Hand: a bar without an availability time fails the gate; the limitation is repeated with every result of the gate.

| Gate | Result | Reason code |
| --- | --- | --- |
| DEFINITION_VALIDATION | PASS |  |
| DETERMINISTIC_REPLAY | PASS |  |
| ACCOUNTING_RECONCILIATION | PASS |  |
| SIGNAL_DATA_TIMING | PASS |  |
| POINT_IN_TIME_DATA | FAIL |  |
| BASE_COST_MODEL | PASS |  |
| EXCESS_OVER_BUY_AND_HOLD | PASS |  |
| WALK_FORWARD | PASS |  |
| MINIMUM_TRADE_COUNT | PASS |  |
| COST_STRESS | PASS |  |
| PARAMETER_SENSITIVITY | INSUFFICIENT | POLICY_RECORDED |
| EXECUTION_DELAY | INSUFFICIENT | POLICY_RECORDED |
| ADVERSE_REGIMES | INSUFFICIENT | POLICY_RECORDED |
| RESAMPLING | NOT_APPLICABLE | POLICY_RECORDED |
| PROSPECTIVE_EVIDENCE | NOT_APPLICABLE | POLICY_RECORDED |
| PORTFOLIO_FIT | NOT_APPLICABLE | POLICY_RECORDED |
| OPERATING_READINESS | NOT_APPLICABLE | POLICY_RECORDED |
