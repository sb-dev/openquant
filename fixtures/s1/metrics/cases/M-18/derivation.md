# M-18: An INSUFFICIENT outcome (unsupported valuation) has no metrics

Origin: derived by `fixtures/s1/metrics/oracle/oracle.py` from the S0 case `I-07`.

The S0 case ends with status INSUFFICIENT and code UNSUPPORTED_VALUATION. Metrics exist only for a `COMPLETED` outcome (OQ-02 section 3.6), so the expected result is a typed refusal and no metrics document.
