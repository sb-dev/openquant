# M-17: A FAILED outcome (INVALID_LEVEL) has no metrics

Origin: derived by `fixtures/s1/metrics/oracle/oracle.py` from the S0 case `G-07a`.

The S0 case ends with status FAILED and code INVALID_LEVEL. Metrics exist only for a `COMPLETED` outcome (OQ-02 section 3.6), so the expected result is a typed refusal and no metrics document.
