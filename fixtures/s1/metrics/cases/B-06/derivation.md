# B-06: A 3-for-2 split on an odd quantity leaves a fractional share count

Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from a patched copy of the input of the S0 case `C-01a`. 49 shares at 100.00 with no fee; 49 * 3 / 2 = 73.5 is not a whole number of shares.

- Capital 4950.00; fixed fee 0, fee 0 bps; scored window 2026-01-08 to 2026-01-15.

The benchmark is unavailable: split SPLIT-2-1 on 2026-01-14 leaves a fractional share count.
