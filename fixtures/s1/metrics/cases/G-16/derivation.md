# G-16: A policy that requires parameter sensitivity

Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the inline cohort policy and the evidence of `evidence.json` by the rules of OQ-02 sections 3.2 and 3.6 and the decision record D18. The method has no rule for the gate.

The policy is refused with `UnsupportedRequiredGate PARAMETER_SENSITIVITY`: a required gate without a reviewed method is never passed.
