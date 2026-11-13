# F0-smoke: hand derivation

Origin: derived by hand by the lead before the first run. This is a smoke case for the
foundation. The independent S0 fixtures are derived separately without access to the core.

## Inputs

- Ten sessions, 2026-01-05 to 2026-01-16. Warm-up starts 2026-01-05. Entries are allowed from
  2026-01-08.
- Capital 5000.00, five slots, lot size 1, price scale 2, quantity scale 0, money scale 2.
- Cost model: fixed fee 1.00 per fill, 0 bps, 0 bps gap slippage.
- Strategy: enter when close > SMA3(close). Snapshot ATR3 at the signal session.
  Stop = entry - 2 * ATR. Target = entry + 3 * ATR.

Closes: 100, 100, 100, 100, 102, 105, 108, 111, 114, 117.

## Signal 2026-01-09

- SMA3 = (100 + 100 + 102) / 3 = 100.6666... Close 102 > 100.6666, so the condition is TRUE.
- True ranges: TR(01-07) = max(2, 1, 1) = 2, TR(01-08) = 2,
  TR(01-09) = max(104 - 99, |104 - 100|, |99 - 100|) = 5. ATR3 = (2 + 2 + 5) / 3 = 3.
- Vacant slots 5. Cap = floor(5000.00 / 5) = 1000.00. Reserve 1000.00:
  available 4000.00, reserved 1000.00.

## Entry 2026-01-12 open 102.00

- Largest quantity with 102 q + 1.00 <= 1000.00: q = 9 (918.00 + 1.00 = 919.00).
  q = 10 would cost 1020.00 + 1.00.
- Release 1000.00 (available 5000.00), debit 919.00 (available 4081.00).
- Stop = 102 - 2 * 3 = 96. Target = 102 + 3 * 3 = 111.
- Bar 01-12: low 101 > 96, high 106 < 111. No exit. Close 105: value 9 * 105 = 945.00,
  equity 4081.00 + 945.00 = 5026.00.
- Bar 01-13: no exit. Close 108: value 972.00, equity 5053.00.

## Exit 2026-01-14 during session

- Bar 01-14: high 112 >= 111 (target), low 107 > 96 (stop). The target is touched alone.
- Sell 9 at 111.00: notional 999.00, fee 1.00, proceeds 998.00. Available 4081.00 + 998.00 =
  5079.00.
- Signal at the 01-14 close: SMA3 = (105 + 108 + 111) / 3 = 108, close 111 > 108: TRUE.
  ATR3 = (5 + 5 + 5) / 3 = 5. Not held. Cap = floor(5079.00 / 5) = 1015.80.
  Available 4063.20, reserved 1015.80, equity 5079.00.

## Re-entry 2026-01-15 open 111.00

- Largest q with 111 q + 1.00 <= 1015.80: q = 9 (999.00 + 1.00 = 1000.00).
- Release 1015.80 (available 5079.00), debit 1000.00 (available 4079.00).
- Stop = 111 - 2 * 5 = 101. Target = 111 + 3 * 5 = 126.
- Close 114: value 1026.00, equity 5105.00.

## End 2026-01-16

- No hit. Close 117: value 1053.00. Equity 4079.00 + 1053.00 = 5132.00.
- The signal at the last processed close has no next session in the run: NO_NEXT_SESSION.
- The position stays open (OPEN_AT_END). No forced liquidation.

## Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY,
4 SELL fill, 5 FILL_SELL, 6 RESERVE, 7 RELEASE, 8 BUY fill, 9 FILL_BUY.
