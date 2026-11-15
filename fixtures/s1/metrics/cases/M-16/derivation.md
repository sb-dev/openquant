# M-16: An INSUFFICIENT outcome has no metrics

Origin: derived by `fixtures/s1/metrics/oracle/oracle.py` from the S0 case `C-02`.

The S0 case ends with status INSUFFICIENT and code FRACTIONAL_ENTITLEMENT. Metrics exist only for a `COMPLETED` outcome (OQ-02 section 3.6), so the expected result is a typed refusal and no metrics document.
