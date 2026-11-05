---
name: ml4t-calendar-ops
description: Apply exchange sessions, holidays, early closes and daylight-saving rules to financial data and scheduled research.
---

# Trading calendars

Read OQ-02 §3 and OQ-05 §3.1 in `docs/specs/`. Bind the calendar version, exchange, timezone and session policy to each dataset/profile.

## Align time explicitly

Use exchange sessions rather than generic weekdays. Count a rolling window in the units declared by the strategy: observations, sessions or elapsed time. On complete daily session data, a 20-row shift can correctly represent 20 sessions; check missing sessions before assuming equivalence.

Use timezone rules, including daylight-saving transitions. NYSE regular close is 16:00 America/New_York, not one fixed UTC time year-round. Account for early closes, unscheduled closures and overnight sessions. A bar timestamp can mark the start, end or session date; normalize according to the provider contract without losing the original.

A session close is not proof that provider data is final. Apply the configured publication/freshness window before dispatch. Deduplicate by stable schedule ID and logical slot; keep timezone/calendar versions in the frozen profile. Record late or missed slots under the bounded catch-up policy.

## Join markets and gaps

Declare the reference calendar for cross-market features. An intersection of sessions and an as-of join answer different questions; select the method before evaluation. Keep missing market observations visible. Carrying an earlier feature value requires an availability bound, maximum age and a stale flag. Do not forward-fill tradeable prices, volumes or fills.

## Verify

Include weekends, holidays, early closes, both daylight-saving transitions, overnight session boundaries, missing sessions and a delayed provider update. Verify expected logical slots and observations from independently specified examples. Do not add a new calendar service or Python runtime solely to use a teaching example.

Adapted from ML4T skills at revision `691857537a0c8befc11dc2f2ad7a458b7c7e801c`. Original Apache-2.0 licence and attribution remain in `.claude/third-party/ml4t/skills`. OpenQuant adaptation: 2026-11-05.
