#!/usr/bin/env python3
"""Independent oracle for the synthetic market-data fixtures (S1, part A of the market PR).

It derives every expected value in `fixtures/market-data/cases/*/expected.json` and writes the
provider-shaped response files, `case.json` and `derivation.md` of each case. It shares no code
with the Rust normaliser: it uses the tz database (`zoneinfo`) for the New York offset, Python's
`decimal` for exact numbers and `hashlib` for the digests, and it re-states the rules of
`apps/engine/src/market/rules.txt` in its own words. Verification does not run it (OQ-06 section
8: no second numerical engine in verification); the Rust tests only check that the hash of this
file equals `origin.oracle_sha256` of every expected file, so a changed oracle without
regenerated values fails.

Every instant, count and amount stated in a `HAND` list below was derived by hand first. The
oracle asserts that its own computation agrees, so a slip in either place stops the run.

Regenerate with:  python3 -I fixtures/market-data/oracle/oracle.py

All data is synthetic: one invented instrument, invented prices, invented provider ids. Nothing
here is provider data and nothing is licensed.
"""

import datetime as dt
import hashlib
import json
import os
import shutil
import sys
from decimal import Decimal
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
MARKET = os.path.dirname(HERE)
CASES = os.path.join(MARKET, "cases")
RULES_PATH = os.path.join(MARKET, "..", "..", "apps", "engine", "src", "market", "rules.txt")

NY = ZoneInfo("America/New_York")
UTC = dt.timezone.utc

SYMBOL = "SYNTH"
ASSET_ID = "00000000-0000-4000-8000-000000000001"
INSTRUMENT_ID = "alpaca:" + ASSET_ID
NOW = "2026-11-14T10:00:00Z"
DELAY_MINUTES = 120
MIN_END_AGE_MINUTES = 15
LICENCE = (
    "Synthetic Alpaca-shaped values on an invented instrument, generated for this repository "
    "under Apache-2.0. Not provider data."
)
TERMS_REF = "docs/reference/service-providers.md#alpaca"

# Regular holidays and the one unscheduled closure that the synthetic provider calendar omits.
HOLIDAYS = {
    "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19",
    "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25", "2025-01-01", "2025-01-09",
    "2025-01-20", "2025-02-17", "2026-11-26", "2026-12-25",
}
EARLY = {"2024-07-03": "13:00", "2024-11-29": "13:00", "2024-12-24": "13:00"}


# ---- small helpers ----------------------------------------------------------------------------

def d(text):
    return dt.date.fromisoformat(text)


def ts(moment):
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def from_ts(text):
    return dt.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def local(date, hhmm):
    hour, minute = hhmm.split(":")
    return dt.datetime.combine(date, dt.time(int(hour), int(minute)), tzinfo=NY).astimezone(UTC)


def midnight(date):
    return local(date, "00:00")


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def canon_dec(token):
    """Minimal decimal text of a JSON number token, by exact decimal arithmetic."""
    value = Decimal(token)
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


def jstr(text):
    return json.dumps(text)


def sessions_between(start, end, listed_closed=None):
    closed = HOLIDAYS if listed_closed is None else listed_closed
    out = []
    day = start
    while day <= end:
        if day.weekday() < 5 and day.isoformat() not in closed:
            out.append(day)
        day += dt.timedelta(days=1)
    return out


def hours(date):
    return ("09:30", EARLY.get(date.isoformat(), "16:00"))


# ---- provider-shaped response bodies ----------------------------------------------------------

def asset_body(asset):
    return json.dumps(
        {
            "id": asset["id"],
            "class": asset["class"],
            "exchange": "NASDAQ",
            "symbol": asset["symbol"],
            "name": "Synthetic Instrument Inc.",
            "status": asset["status"],
            "tradable": True,
            "fractionable": False,
        },
        indent=2,
    ) + "\n"


def calendar_body(rows):
    return json.dumps(
        [
            {
                "date": date.isoformat(),
                "open": opened,
                "close": closed,
                "session_open": "0400",
                "session_close": "2000",
                "settlement_date": date.isoformat(),
            }
            for date, opened, closed in rows
        ],
        indent=1,
    ) + "\n"


def bar_text(bar):
    return (
        '{"t":"%s","o":%s,"h":%s,"l":%s,"c":%s,"v":%s,"n":1234,"vw":%s}'
        % (bar["stamp"], bar["o"], bar["h"], bar["l"], bar["c"], bar["v"], bar["c"])
    )


def bars_body(bars, token=None, raw=None):
    if raw is not None:
        return raw
    items = ",\n".join("  " + bar_text(bar) for bar in bars)
    nxt = "null" if token is None else jstr(token)
    return '{\n "bars": [\n%s\n ],\n "symbol": "%s",\n "next_page_token": %s\n}\n' % (items, SYMBOL, nxt)


def empty_bars_body():
    return '{\n "bars": null,\n "symbol": "%s",\n "next_page_token": null\n}\n' % SYMBOL


def action_text(action):
    fields = []
    if "id" in action:
        fields.append(("id", jstr(action["id"])))
    fields.append(("symbol", jstr(action.get("symbol", SYMBOL))))
    kind = action["type"]
    if kind in ("forward_splits", "reverse_splits"):
        fields += [("new_rate", action["new_rate"]), ("old_rate", action["old_rate"])]
    elif kind == "cash_dividends":
        fields += [
            ("rate", action["rate"]),
            ("special", "true" if action.get("special") else "false"),
            ("foreign", "true" if action.get("foreign") else "false"),
        ]
    for key in ("process_date", "ex_date", "record_date", "payable_date", "declaration_date"):
        if action.get(key) is not None:
            fields.append((key, jstr(action[key])))
    return "{" + ",".join('"%s":%s' % pair for pair in fields) + "}"


def actions_body(actions, token=None):
    by_type = {}
    for action in actions:
        by_type.setdefault(action["type"], []).append(action)
    lists = []
    for kind, items in by_type.items():
        lists.append('  "%s": [\n%s\n  ]' % (kind, ",\n".join("    " + action_text(a) for a in items)))
    nxt = "null" if token is None else jstr(token)
    return '{\n "corporate_actions": {\n%s\n },\n "next_page_token": %s\n}\n' % (",\n".join(lists), nxt)


# ---- cases ------------------------------------------------------------------------------------

def bar(date, o, h, l, c, v, stamp=None):
    return {
        "date": date,
        "o": o, "h": h, "l": l, "c": c, "v": v,
        "stamp": stamp or ts(midnight(d(date))),
    }


def auto_bars(sessions, base="100.00", step="0.50", skip=()):
    out = []
    for index, day in enumerate(sessions):
        if day.isoformat() in skip:
            continue
        o = Decimal(base) + Decimal(step) * index
        out.append(
            bar(
                day.isoformat(),
                "%.2f" % o,
                "%.2f" % (o + Decimal("1.50")),
                "%.2f" % (o - Decimal("1.25")),
                "%.2f" % (o + Decimal("0.50")),
                str(1000000 + 10000 * index),
            )
        )
    return out


def split(ex, declared, new, old, ident="ca-0001", kind="forward_splits"):
    return {
        "type": kind, "id": ident, "ex_date": ex, "declaration_date": declared,
        "new_rate": new, "old_rate": old, "process_date": ex, "record_date": ex, "payable_date": ex,
    }


def dividend(ex, declared, payable, rate, ident="ca-0002", **extra):
    action = {
        "type": "cash_dividends", "id": ident, "ex_date": ex, "declaration_date": declared,
        "payable_date": payable, "rate": rate, "process_date": ex, "record_date": ex,
    }
    action.update(extra)
    return action


def case(ident, title, start, end, **kw):
    spec = {
        "id": ident, "title": title, "start": start, "end": end,
        "now": NOW, "closed": None, "bars": None, "bar_skip": (), "bar_pages": None,
        "actions": [], "action_pages": None,
        "asset": {"id": ASSET_ID, "symbol": SYMBOL, "class": "us_equity", "status": "active"},
        "limits": {"max_requests": 30, "max_retries": 2, "request_timeout_seconds": 30,
                   "max_response_bytes": 1048576},
        "edit": None, "hand": [], "notes": [], "expect": None, "listed_extra": (),
        "bars_raw": None, "actions_raw": None,
    }
    spec.update(kw)
    return spec


def build_cases():
    out = []

    # N-01: a 4-for-1 forward split inside the range, declared before the ex-date.
    sessions = sessions_between(d("2024-02-26"), d("2024-03-08"))
    bars = auto_bars(sessions[:5], base="400.00", step="1.00") + auto_bars(sessions[5:], base="100.00", step="0.25")
    out.append(case(
        "N-01-split", "A 4-for-1 forward split, evidenced by its declaration date",
        "2024-02-26", "2024-03-08", bars=bars,
        actions=[split("2024-03-04", "2024-02-28", "4", "1")],
        notes=[
            "The range 2024-02-26 to 2024-03-08 holds 10 sessions: 26 to 29 February (4, 2024 is a leap year), 1 March (1) and 4 to 8 March (5).",
            "The split is declared on 2024-02-28, strictly before its ex-date 2024-03-04, so the rule holds and `available_at` is the open of 2024-03-04.",
            "In March 2024 New York is on standard time until 10 March: 09:30 is 14:30Z, 16:00 is 21:00Z.",
            "The 2024-03-01 bar closes at 21:00Z and is available 120 minutes later, 23:00Z.",
            "4 new shares for 1 old share reduce to 4 and 1.",
        ],
        hand=[
            ("split `available_at`", lambda m: m["content"]["corporate_actions"][0]["available_at"], "2024-03-04T14:30:00Z"),
            ("ratio_new", lambda m: m["content"]["corporate_actions"][0]["ratio_new"], 4),
            ("ratio_old", lambda m: m["content"]["corporate_actions"][0]["ratio_old"], 1),
            ("bar_count", lambda m: m["coverage"]["bar_count"], 10),
            ("available_at of the 2024-03-01 bar", lambda m: next(b for b in m["content"]["bars"] if b["session"] == "2024-03-01")["available_at"], "2024-03-01T23:00:00Z"),
        ],
    ))

    # N-02: a regular cash dividend inside a rising run, payable two sessions after the ex-date.
    sessions = sessions_between(d("2025-02-03"), d("2025-02-14"))
    out.append(case(
        "N-02-cash-dividend", "A cash dividend with ex-date and payment inside a rising run",
        "2025-02-03", "2025-02-14", bars=auto_bars(sessions, base="100.00", step="0.50"),
        actions=[dividend("2025-02-11", "2025-02-04", "2025-02-13", "0.25")],
        notes=[
            "The dividend is declared on 2025-02-04, seven days before the ex-date 2025-02-11 (a Tuesday): evidenced.",
            "February is standard time: the ex-date opens at 09:30 EST = 14:30Z, so `available_at` is 2025-02-11T14:30:00Z.",
            "The payable date 2025-02-13 is a Thursday and a calendar session, two sessions after the ex-date (12 and 13 February). The payment phase is AFTER_CLOSE.",
            "The rate 0.25 is kept as the exact text. The bars rise by 0.50 a session, so a position held across 11 February sees the ex-date inside its holding period and the benchmark window.",
        ],
        hand=[
            ("dividend `available_at`", lambda m: m["content"]["corporate_actions"][0]["available_at"], "2025-02-11T14:30:00Z"),
            ("payment_session", lambda m: m["content"]["corporate_actions"][0]["payment_session"], "2025-02-13"),
            ("amount_per_share", lambda m: m["content"]["corporate_actions"][0]["amount_per_share"], "0.25"),
            ("evidence value", lambda m: m["content"]["action_evidence"][0]["provider_value"], "2025-02-04"),
        ],
    ))

    # N-03: a holiday that the provider calendar omits.
    out.append(case(
        "N-03-holiday", "A market holiday omitted by the provider calendar",
        "2024-01-08", "2024-01-19",
        notes=[
            "Monday 2024-01-15 is Martin Luther King Jr. Day. The provider calendar has no row for it and the provider has no bar for it.",
            "The range 8 to 19 January has 10 weekdays, so 9 sessions. All 9 have a bar: COMPLETE, nothing missing.",
        ],
        hand=[
            ("calendar sessions", lambda m: len(m["content"]["calendar"]), 9),
            ("bar_count", lambda m: m["coverage"]["bar_count"], 9),
            ("completeness", lambda m: m["coverage"]["completeness"], "COMPLETE"),
            ("missing", lambda m: m["coverage"]["missing_sessions"], []),
        ],
    ))

    # N-04: an early close.
    out.append(case(
        "N-04-early-close", "An early close: the data-ready delay runs from the early close",
        "2024-11-25", "2024-11-29",
        notes=[
            "Thursday 2024-11-28 is Thanksgiving (omitted). Friday 2024-11-29 closes at 13:00 local.",
            "On 29 November New York is on standard time: 13:00 EST = 18:00Z, so `close_at` is 2024-11-29T18:00:00Z, not 21:00Z.",
            "`available_at` = early close + 120 minutes = 20:00Z. A normal day, 2024-11-27, closes at 16:00 EST = 21:00Z and is available at 23:00Z.",
        ],
        hand=[
            ("early close_at", lambda m: next(s for s in m["content"]["calendar"] if s["session"] == "2024-11-29")["close_at"], "2024-11-29T18:00:00Z"),
            ("early-close bar available_at", lambda m: next(b for b in m["content"]["bars"] if b["session"] == "2024-11-29")["available_at"], "2024-11-29T20:00:00Z"),
            ("normal bar available_at", lambda m: next(b for b in m["content"]["bars"] if b["session"] == "2024-11-27")["available_at"], "2024-11-27T23:00:00Z"),
            ("sessions", lambda m: [s["session"] for s in m["content"]["calendar"]], ["2024-11-25", "2024-11-26", "2024-11-27", "2024-11-29"]),
        ],
    ))

    # N-05: the spring daylight-saving change.
    out.append(case(
        "N-05-dst-spring", "Daylight saving starts on Sunday 2024-03-10",
        "2024-03-08", "2024-03-12",
        notes=[
            "US daylight time starts on the second Sunday of March: 2024-03-10. Friday 8 March is still EST (UTC-5), Monday 11 March is EDT (UTC-4).",
            "Friday 8 March: open 09:30 EST = 14:30Z, close 16:00 EST = 21:00Z, bar stamp 05:00Z, available 23:00Z.",
            "Monday 11 March: open 09:30 EDT = 13:30Z, close 16:00 EDT = 20:00Z, bar stamp 04:00Z, available 22:00Z.",
            "Tuesday 12 March is the same as the 11th.",
        ],
        hand=[
            ("open_at 8 March", lambda m: m["content"]["calendar"][0]["open_at"], "2024-03-08T14:30:00Z"),
            ("close_at 8 March", lambda m: m["content"]["calendar"][0]["close_at"], "2024-03-08T21:00:00Z"),
            ("available_at 8 March", lambda m: m["content"]["bars"][0]["available_at"], "2024-03-08T23:00:00Z"),
            ("open_at 11 March", lambda m: m["content"]["calendar"][1]["open_at"], "2024-03-11T13:30:00Z"),
            ("close_at 11 March", lambda m: m["content"]["calendar"][1]["close_at"], "2024-03-11T20:00:00Z"),
            ("available_at 11 March", lambda m: m["content"]["bars"][1]["available_at"], "2024-03-11T22:00:00Z"),
        ],
    ))

    # N-06: the autumn daylight-saving change.
    out.append(case(
        "N-06-dst-autumn", "Daylight saving ends on Sunday 2024-11-03",
        "2024-11-01", "2024-11-05",
        notes=[
            "US daylight time ends on the first Sunday of November: 2024-11-03. Friday 1 November is EDT (UTC-4), Monday 4 November is EST (UTC-5).",
            "Friday 1 November: open 09:30 EDT = 13:30Z, close 16:00 EDT = 20:00Z, bar stamp 04:00Z, available 22:00Z.",
            "Monday 4 November: open 09:30 EST = 14:30Z, close 16:00 EST = 21:00Z, bar stamp 05:00Z, available 23:00Z.",
        ],
        hand=[
            ("close_at 1 November", lambda m: m["content"]["calendar"][0]["close_at"], "2024-11-01T20:00:00Z"),
            ("available_at 1 November", lambda m: m["content"]["bars"][0]["available_at"], "2024-11-01T22:00:00Z"),
            ("open_at 4 November", lambda m: m["content"]["calendar"][1]["open_at"], "2024-11-04T14:30:00Z"),
            ("available_at 4 November", lambda m: m["content"]["bars"][1]["available_at"], "2024-11-04T23:00:00Z"),
        ],
    ))

    # N-07: an unscheduled closure that the provider calendar still lists.
    out.append(case(
        "N-07-unscheduled-closure-listed", "An unscheduled closure: the calendar lists the session, no bar exists",
        "2025-01-06", "2025-01-10", closed=set(HOLIDAYS) - {"2025-01-09"},
        bar_skip=("2025-01-09",),
        notes=[
            "2025-01-09 was a one-day closure announced at short notice. This provider calendar still lists it as a session, but the provider returns no bar.",
            "The expected sessions are the 5 weekdays 6 to 10 January. The missing session is 2025-01-09: coverage is PARTIAL, bar_count 4.",
            "An absent bar alone does not establish a halt, so `unplanned_events` stays empty.",
        ],
        hand=[
            ("completeness", lambda m: m["coverage"]["completeness"], "PARTIAL"),
            ("missing", lambda m: m["coverage"]["missing_sessions"], ["2025-01-09"]),
            ("bar_count", lambda m: m["coverage"]["bar_count"], 4),
            ("unplanned events", lambda m: m["content"]["unplanned_events"], []),
        ],
    ))

    # N-08: the same closure, omitted by the calendar.
    out.append(case(
        "N-08-unscheduled-closure-omitted", "An unscheduled closure that the provider calendar already omits",
        "2025-01-06", "2025-01-10",
        notes=[
            "The calendar omits 2025-01-09, so the expected sessions are 4 and every one has a bar: COMPLETE.",
        ],
        hand=[
            ("completeness", lambda m: m["coverage"]["completeness"], "COMPLETE"),
            ("sessions", lambda m: len(m["content"]["calendar"]), 4),
        ],
    ))

    # N-09: pagination, three bar pages and two action pages.
    sessions = sessions_between(d("2024-04-01"), d("2024-04-19"))
    out.append(case(
        "N-09-pages", "Three bar pages and two corporate-action pages",
        "2024-04-01", "2024-04-19", bar_pages=[6, 6, 3],
        bars=auto_bars(sessions, base="100.00", step="0.25"),
        actions=[
            dividend("2024-04-10", "2024-04-02", "2024-04-12", "0.24", ident="ca-0010"),
            split("2024-04-15", "2024-04-03", "3", "2", ident="ca-0011"),
        ],
        action_pages=[[0], [1]],
        notes=[
            "The 15 sessions 1 to 19 April 2024 arrive in pages of 6, 6 and 3 bars, linked by next_page_token. Every page is one call and one source response.",
            "The dividend (ex 10 April, declared 2 April, payable 12 April) is on page 1 of the actions and the 3-for-2 split (ex 15 April, declared 3 April) on page 2.",
            "April is daylight time (UTC-4): 09:30 EDT = 13:30Z. Both actions are available at the open of their ex-date.",
        ],
        hand=[
            ("bar_count", lambda m: m["coverage"]["bar_count"], 15),
            ("calls", lambda m: len(m["source_responses"]), 7),
            ("dividend available_at", lambda m: m["content"]["corporate_actions"][0]["available_at"], "2024-04-10T13:30:00Z"),
            ("split available_at", lambda m: m["content"]["corporate_actions"][1]["available_at"], "2024-04-15T13:30:00Z"),
            ("split ratio", lambda m: (m["content"]["corporate_actions"][1]["ratio_new"], m["content"]["corporate_actions"][1]["ratio_old"]), (3, 2)),
        ],
    ))

    # N-10: nothing returned.
    out.append(case(
        "N-10-empty", "An empty bar response and no corporate actions",
        "2024-06-03", "2024-06-07", bars=[], bars_raw="empty", actions_raw="empty",
        notes=[
            "The provider answers `bars: null` and an empty corporate_actions object. This is no observations, not a failure.",
            "The calendar holds the 5 weekdays 3 to 7 June 2024; none has a bar. `returned` is absent, bar_count is 0 and all 5 sessions are missing.",
        ],
        hand=[
            ("completeness", lambda m: m["coverage"]["completeness"], "NO_OBSERVATIONS"),
            ("returned", lambda m: "returned" in m["coverage"], False),
            ("missing", lambda m: len(m["coverage"]["missing_sessions"]), 5),
        ],
    ))

    # N-11: payable after the scored end.
    sessions = sessions_between(d("2024-12-02"), d("2024-12-13"))
    out.append(case(
        "N-11-payable-after-end", "A dividend payable after the requested range end",
        "2024-12-02", "2024-12-13", bars=auto_bars(sessions),
        actions=[dividend("2024-12-12", "2024-12-03", "2024-12-16", "0.30")],
        notes=[
            "The ex-date 2024-12-12 is inside the range, the payable date 2024-12-16 (Monday) is after the range end 2024-12-13.",
            "The snapshot calendar extends to the payment session: it holds the 10 sessions of the range and 2024-12-16, 11 in all. The provider calendar response ran further (to 45 days after the end) and is trimmed.",
            "December is standard time: the ex-date opens at 14:30Z.",
        ],
        hand=[
            ("calendar sessions", lambda m: len(m["content"]["calendar"]), 11),
            ("last session", lambda m: m["content"]["calendar"][-1]["session"], "2024-12-16"),
            ("payment_session", lambda m: m["content"]["corporate_actions"][0]["payment_session"], "2024-12-16"),
            ("requested end", lambda m: m["coverage"]["requested"]["end"], "2024-12-13"),
            ("bar_count", lambda m: m["coverage"]["bar_count"], 10),
        ],
    ))

    # N-12: a price scale of 3, with exponent and trailing-zero tokens.
    sessions = sessions_between(d("2024-05-06"), d("2024-05-10"))
    bars12 = [
        bar("2024-05-06", "100.125", "101.5", "99.875", "100.250", "1000000"),
        bar("2024-05-07", "1.00250e2", "101.000", "100.1", "100.75", "1.2e6"),
        bar("2024-05-08", "100.75", "102", "100.5", "101.5", "950000"),
        bar("2024-05-09", "101.5", "102.125", "101", "101.875", "1010000"),
        bar("2024-05-10", "101.875", "103", "101.5", "102.5", "1020000"),
    ]
    out.append(case(
        "N-12-price-scale-3", "Prices that need three fractional digits",
        "2024-05-06", "2024-05-10", bars=bars12,
        notes=[
            "The most precise prices are 100.125, 99.875 and 102.125: three fractional digits. The smallest scale that holds every price exactly is 3, so price_scale is 3 and money_scale is max(2, 3) = 3.",
            "A scale of 3 or 4 is accepted only after the S1 overflow test passes at that scale: overflow_evidence_required is true.",
            "Tokens keep their exact value and become minimal decimal text: 100.250 is 100.25, 1.00250e2 is 100.25, 1.2e6 is 1200000, 102 is 102.",
        ],
        hand=[
            ("open of 7 May", lambda m: m["content"]["bars"][1]["open"], "100.25"),
            ("volume of 7 May", lambda m: m["content"]["bars"][1]["volume"], "1200000"),
            ("high of 6 May", lambda m: m["content"]["bars"][0]["high"], "101.5"),
        ],
    ))

    # N-13: a special cash dividend.
    sessions = sessions_between(d("2024-06-03"), d("2024-06-14"))
    out.append(case(
        "N-13-special-dividend", "A special cash dividend is kept as an unsupported distribution",
        "2024-06-03", "2024-06-14", bars=auto_bars(sessions),
        actions=[dividend("2024-06-10", "2024-06-04", "2024-06-12", "2.00", ident="ca-0020", special=True)],
        notes=[
            "The provider marks the dividend special. The core cannot value a special distribution, so the action is kept (never dropped) as SPECIAL_DISTRIBUTION and makes the affected evidence INSUFFICIENT later.",
            "Its availability still follows the dividend rule: declared 2024-06-04, before the ex-date 2024-06-10, so `available_at` is the open of 10 June: 09:30 EDT = 13:30Z.",
            "A SPECIAL_DISTRIBUTION carries no amount or payment fields.",
        ],
        hand=[
            ("kind", lambda m: m["content"]["corporate_actions"][0]["kind"], "SPECIAL_DISTRIBUTION"),
            ("available_at", lambda m: m["content"]["corporate_actions"][0]["available_at"], "2024-06-10T13:30:00Z"),
        ],
    ))

    # N-14: split ratio reduction and same-day action identities.
    sessions = sessions_between(d("2024-05-06"), d("2024-05-17"))
    out.append(case(
        "N-14-ratios-and-ids", "Split ratios reduce to integers and same-day dividends get distinct ids",
        "2024-05-06", "2024-05-17", bars=auto_bars(sessions),
        actions=[
            split("2024-05-08", "2024-05-01", "1.5", "1", ident="ca-0031"),
            split("2024-05-15", "2024-05-09", "1", "20", ident="ca-0032", kind="reverse_splits"),
            dividend("2024-05-08", "2024-05-01", "2024-05-10", "0.10", ident="ca-0034"),
            dividend("2024-05-08", "2024-05-02", "2024-05-10", "0.05", ident="ca-0033"),
        ],
        notes=[
            "A 1.5-for-1 split is 15/10, which reduces to 3 for 2. A 1-for-20 reverse split stays 1 and 20.",
            "Two dividends share the ex-date 2024-05-08. Actions are ordered by ex-date, then splits before dividends, then provider id: split ca-0031, dividend ca-0033 (rate 0.05), dividend ca-0034 (rate 0.10).",
            "The second dividend of the day gets the suffix -2: `div-synth-2024-05-08` is ca-0033 and `div-synth-2024-05-08-2` is ca-0034.",
        ],
        hand=[
            ("ids in order", lambda m: [a["action_id"] for a in m["content"]["corporate_actions"]], ["split-synth-2024-05-08", "div-synth-2024-05-08", "div-synth-2024-05-08-2", "split-synth-2024-05-15"]),
            ("first ratio", lambda m: (m["content"]["corporate_actions"][0]["ratio_new"], m["content"]["corporate_actions"][0]["ratio_old"]), (3, 2)),
            ("reverse ratio", lambda m: (m["content"]["corporate_actions"][3]["ratio_new"], m["content"]["corporate_actions"][3]["ratio_old"]), (1, 20)),
            ("amounts", lambda m: [m["content"]["corporate_actions"][1]["amount_per_share"], m["content"]["corporate_actions"][2]["amount_per_share"]], ["0.05", "0.1"]),
        ],
    ))

    # N-15: an identical retransmitted bar.
    sessions = sessions_between(d("2024-07-08"), d("2024-07-12"))
    bars15 = auto_bars(sessions)
    bars15.insert(2, dict(bars15[1]))
    out.append(case(
        "N-15-identical-duplicate", "An identical retransmitted bar is merged",
        "2024-07-08", "2024-07-12", bars=bars15,
        notes=[
            "The provider response lists the 2024-07-09 bar twice with identical values. An identical retransmission is merged into one bar under the declared rule. A differing duplicate would block the profile (B-08).",
            "bar_count is 5, not 6.",
        ],
        hand=[("bar_count", lambda m: m["coverage"]["bar_count"], 5)],
    ))

    # N-16: the end of the request is clamped to the minimum end age.
    sessions = sessions_between(d("2026-11-09"), d("2026-11-13"))
    out.append(case(
        "N-16-end-age", "The request ends 15 minutes before it is made",
        "2026-11-09", "2026-11-13", now="2026-11-13T21:10:00Z", bars=auto_bars(sessions),
        notes=[
            "The request is made at 2026-11-13T21:10:00Z. The profile requires an end at least 15 minutes old: 21:10 minus 15 minutes is 20:55:00Z, earlier than the end of the requested day 23:59:59Z. The bar request ends at 2026-11-13T20:55:00Z.",
            "November 2026 is standard time (daylight time ended on 1 November): the Friday bar is stamped 05:00Z, which is before 20:55Z, so it is inside the request. Its close is 21:00Z and it is available at 23:00Z.",
        ],
        hand=[
            ("Friday available_at", lambda m: m["content"]["bars"][-1]["available_at"], "2026-11-13T23:00:00Z"),
            ("retrieved_at", lambda m: m["retrieval"]["retrieved_at"], "2026-11-13T21:10:00Z"),
        ],
    ))

    # ---- blocked profiles ---------------------------------------------------------------------
    sessions = sessions_between(d("2024-03-04"), d("2024-03-15"))
    plain = auto_bars(sessions)

    def blocked(ident, title, code, subject, **kw):
        notes = kw.pop("notes")
        return case(ident, title, kw.pop("start", "2024-03-04"), kw.pop("end", "2024-03-15"),
                    expect={"kind": "blocked", "code": code, "subject": subject, "class": kw.pop("klass")},
                    notes=notes, **kw)

    out.append(blocked(
        "B-01-dividend-field-missing", "A dividend without a declaration date blocks the profile",
        "ACTION_NOT_EVIDENCED", "div-synth-2024-03-08", klass="UNAVAILABLE_DATA", bars=plain,
        actions=[dividend("2024-03-08", None, "2024-03-12", "0.25")],
        notes=[
            "The profile names `declaration_date` as the field that evidences a dividend's availability. The provider record has no such field.",
            "Without evidence the availability is unknown. The rule is BLOCK_PROFILE: no fixed offset, record date, process date or retrieval time replaces it. No manifest is produced.",
        ],
    ))
    out.append(blocked(
        "B-02-dividend-declared-on-ex-date", "A dividend declared on its ex-date blocks the profile",
        "ACTION_DECLARED_NOT_BEFORE_EX_DATE", "div-synth-2024-03-08", klass="UNAVAILABLE_DATA", bars=plain,
        actions=[dividend("2024-03-08", "2024-03-08", "2024-03-12", "0.25")],
        notes=["The declaration date 2024-03-08 equals the ex-date. The bound holds only for a date strictly before the ex-date, so the profile is blocked."],
    ))
    out.append(blocked(
        "B-03-split-declared-after-ex-date", "A split declared after its ex-date blocks the profile",
        "ACTION_DECLARED_NOT_BEFORE_EX_DATE", "split-synth-2024-03-06", klass="UNAVAILABLE_DATA", bars=plain,
        actions=[split("2024-03-06", "2024-03-07", "2", "1")],
        notes=["The declaration date 2024-03-07 is after the ex-date 2024-03-06. The action would not have been known at its open, so the profile is blocked."],
    ))
    out.append(blocked(
        "B-04-payable-not-session", "A payable date on a Saturday blocks the profile",
        "PAYABLE_DATE_NOT_SESSION", "div-synth-2024-03-08", klass="UNAVAILABLE_DATA", bars=plain,
        actions=[dividend("2024-03-08", "2024-03-01", "2024-03-09", "0.25")],
        notes=["2024-03-09 is a Saturday, so it is not a calendar session. No other session replaces it: the profile is blocked."],
    ))
    prices5 = auto_bars(sessions)
    prices5[3] = bar(prices5[3]["date"], "100.12345", "101.5", "99.5", "100.5", "1000000")
    out.append(blocked(
        "B-05-price-scale-5", "Prices with five fractional digits block the profile",
        "PRICE_SCALE_ABOVE_LIMIT", "5", klass="UNSUPPORTED_CAPABILITY", bars=prices5,
        notes=["The open 100.12345 needs 5 fractional digits. Prices are never rounded to fit; a scale above 4 blocks the profile."],
    ))
    out.append(blocked(
        "B-06-unsupported-action-type", "A spin-off has no availability rule and blocks the profile",
        "UNSUPPORTED_ACTION_TYPE", "spin_offs", klass="UNSUPPORTED_CAPABILITY", bars=plain,
        actions=[{"type": "spin_offs", "id": "ca-0040", "ex_date": "2024-03-07", "process_date": "2024-03-07", "declaration_date": "2024-03-01"}],
        notes=["The profile declares availability rules for splits and cash dividends only. A spin-off in the range has none, so the profile is blocked rather than the action dropped."],
    ))
    out.append(blocked(
        "B-07-instrument-mismatch", "An asset record with another id blocks the profile",
        "INSTRUMENT_MISMATCH", "id", klass="UNAVAILABLE_DATA", bars=plain,
        asset={"id": "00000000-0000-4000-8000-0000000000ff", "symbol": SYMBOL, "class": "us_equity", "status": "active"},
        notes=["The mapping says the asset id is 00000000-0000-4000-8000-000000000001; the provider record has another id. Identity comes from the asset id, so a mismatch blocks the profile."],
    ))
    dup = auto_bars(sessions)
    changed = dict(dup[2])
    changed["v"] = "999999"
    dup.insert(3, changed)
    out.append(blocked(
        "B-08-conflicting-duplicate-bar", "Two different bars for one session block the profile",
        "CONFLICTING_DUPLICATE_BAR", "2024-03-06", klass="MALFORMED_RESPONSE", bars=dup,
        notes=["The provider returns two bars for 2024-03-06 whose volumes differ. Only an identical retransmission is merged; a conflict needs explicit revision handling, so the profile is blocked."],
    ))
    out.append(blocked(
        "B-09-split-ratio-unrepresentable", "A split ratio above 1000 blocks the profile",
        "UNREPRESENTABLE_SPLIT_RATIO", "split-synth-2024-03-06", klass="UNSUPPORTED_CAPABILITY", bars=plain,
        actions=[split("2024-03-06", "2024-03-01", "1001", "1")],
        notes=["The ratio 1001 to 1 is outside 1 to 1000. The action is never dropped, so the profile is blocked."],
    ))
    onhol = auto_bars(sessions_between(d("2024-01-08"), d("2024-01-19")))
    onhol.insert(5, bar("2024-01-15", "100", "101", "99", "100.5", "1000"))
    out.append(blocked(
        "B-10-bar-on-non-session", "A bar on a market holiday blocks the profile",
        "BAR_ON_NON_SESSION", "2024-01-15", klass="MALFORMED_RESPONSE", start="2024-01-08", end="2024-01-19", bars=onhol,
        notes=["Monday 2024-01-15 is a holiday: the calendar has no session for it, yet the provider returns a bar. The data contradicts the calendar, so the profile is blocked."],
    ))
    badstamp = auto_bars(sessions)
    badstamp[1] = dict(badstamp[1], stamp="2024-03-05T00:00:00Z")
    out.append(blocked(
        "B-11-bar-not-at-session-start", "A bar stamped at midnight UTC blocks the profile",
        "BAR_NOT_AT_SESSION_START", "2024-03-05T00:00:00Z", klass="MALFORMED_RESPONSE", bars=badstamp,
        notes=["A daily bar is stamped with local midnight in New York: 05:00Z on 2024-03-05. A stamp of 00:00Z is another instant, so the session cannot be read from it."],
    ))
    out.append(blocked(
        "B-12-payable-before-ex-date", "A payable date before the ex-date blocks the profile",
        "PAYABLE_BEFORE_EX_DATE", "div-synth-2024-03-08", klass="UNAVAILABLE_DATA", bars=plain,
        actions=[dividend("2024-03-08", "2024-03-01", "2024-03-07", "0.25")],
        notes=["The payable date 2024-03-07 is a session but before the ex-date 2024-03-08. The core refuses a payment before the ex-date, so the profile is blocked."],
    ))
    out.append(blocked(
        "B-13-dividend-amount-precision", "A dividend amount with nine fractional digits blocks the profile",
        "INVALID_ACTION_VALUE", "div-synth-2024-03-08", klass="UNSUPPORTED_CAPABILITY", bars=plain,
        actions=[dividend("2024-03-08", "2024-03-01", "2024-03-12", "0.123456789")],
        notes=["The core reads an amount with at most 8 fractional digits. 0.123456789 has 9 and is never rounded: the profile is blocked."],
    ))
    out.append(blocked(
        "B-14-split-field-missing", "A split without a declaration date blocks the profile",
        "ACTION_NOT_EVIDENCED", "split-synth-2024-03-06", klass="UNAVAILABLE_DATA", bars=plain,
        actions=[split("2024-03-06", None, "2", "1")],
        notes=["The split record has no `declaration_date`. Splits follow the same rule as dividends, so the profile is blocked."],
    ))
    out.append(blocked(
        "B-15-ex-date-not-session", "An ex-date on a market holiday blocks the profile",
        "ACTION_EX_DATE_NOT_SESSION", "div-synth-2024-01-15", klass="UNAVAILABLE_DATA", start="2024-01-08", end="2024-01-19",
        bars=auto_bars(sessions_between(d("2024-01-08"), d("2024-01-19"))),
        actions=[dividend("2024-01-15", "2024-01-05", "2024-01-17", "0.25")],
        notes=["The ex-date 2024-01-15 is a holiday and not a calendar session, but the core needs the effective session on the calendar. The profile is blocked."],
    ))

    out += error_cases()
    return out


def error_cases():
    out = []
    sessions = sessions_between(d("2024-03-04"), d("2024-03-08"))
    plain = auto_bars(sessions)

    def err(ident, title, edit, expect, notes, **kw):
        return case(ident, title, "2024-03-04", "2024-03-08", bars=kw.pop("bars", plain),
                    edit=edit, expect=expect, notes=notes, **kw)

    out.append(err(
        "E-01-401", "HTTP 401 is an authentication failure and is not retried",
        lambda steps: [dict(steps[0], reply={"status": 401, "headers": [], "body": '{"message":"unauthorized"}\n'})],
        {"kind": "error", "code": "AUTHENTICATION", "class": "AUTHENTICATION", "retryable": False, "retry_after_seconds": None},
        ["The first call, the asset read, answers 401. Authentication is never retried: one call is made and one is billed.",
         "The retrieval fails with class AUTHENTICATION, retryable false (retrieval-result/1 forces false for this class)."],
        sleeps=[],
    ))
    out.append(err(
        "E-02-403", "HTTP 403 is a permission failure and is not retried",
        lambda steps: steps[:2] + [dict(steps[2], reply={"status": 403, "headers": [], "body": '{"message":"forbidden"}\n'})],
        {"kind": "error", "code": "PERMISSION", "class": "PERMISSION", "retryable": False, "retry_after_seconds": None},
        ["The asset and the calendar succeed (calls 1 and 2). The bar request, call 3, answers 403: the key has no entitlement for the feed. Not retried; the profile does not fall back to another feed."],
        sleeps=[],
    ))
    out.append(err(
        "E-03-429-then-ok", "HTTP 429 with Retry-After: wait, retry once, then succeed",
        lambda steps: [dict(steps[0], reply={"status": 429, "headers": [["retry-after", "3"]], "body": '{"message":"rate limit"}\n'})] + steps[:1] + steps[1:],
        {"kind": "snapshot"},
        ["The first asset call answers 429 with `Retry-After: 3`. The wait is the larger of the first backoff (1 s) and 3 s: 3 s. The clock moves 3 s and the same request is sent again.",
         "Two asset calls are billed: call 1 failed (RATE_LIMITED, retry hint 3) and call 2 succeeded. Every later call is one more. The source response of the asset has sequence 2 and received_at 10:00:03Z."],
        sleeps=[3],
        hand_calls=("asset", 2),
        hand=[("asset source sequence", lambda m: m["source_responses"][0]["sequence"], 2),
              ("asset source received_at", lambda m: m["source_responses"][0]["received_at"], "2026-11-14T10:00:03Z"),
              ("retrieved_at", lambda m: m["retrieval"]["retrieved_at"], "2026-11-14T10:00:03Z")],
    ))
    out.append(err(
        "E-04-429-exhausted", "HTTP 429 until the retries are used up",
        lambda steps: [dict(steps[0], reply={"status": 429, "headers": [["retry-after", "2"]], "body": ""})] * 3,
        {"kind": "error", "code": "RATE_LIMITED", "class": "RATE_LIMITED", "retryable": True, "retry_after_seconds": 2},
        ["max_retries is 2, so the request is tried 3 times. Each 429 says `Retry-After: 2`; each wait is max(backoff, 2): backoff is 1 s then 2 s, so 2 s and 2 s.",
         "The third 429 is returned with its hint preserved: 3 calls billed, waits [2, 2], and the error stays retryable for the job's attempt policy."],
        sleeps=[2, 2],
    ))
    out.append(err(
        "E-05-503-then-ok", "HTTP 503 is transient: backoff and retry",
        lambda steps: steps[:2] + [dict(steps[2], reply={"status": 503, "headers": [], "body": ""})] + steps[2:],
        {"kind": "snapshot"},
        ["The first bar request answers 503. No Retry-After, so the wait is the first backoff, 1 s. The retry succeeds.",
         "The calls are: asset (1), calendar (2), bars 503 (3), bars ok (4), actions (5). The bars and actions responses carry received_at 10:00:01Z."],
        sleeps=[1],
        hand=[("bars source sequence", lambda m: m["source_responses"][2]["sequence"], 4),
              ("actions source received_at", lambda m: m["source_responses"][3]["received_at"], "2026-11-14T10:00:01Z")],
    ))
    out.append(err(
        "E-06-redirect", "A redirect is refused, even to the same host",
        lambda steps: [dict(steps[0], reply={"status": 302, "headers": [["location", "https://paper-api.alpaca.markets/v2/assets/SYNTH"]], "body": ""})],
        {"kind": "error", "code": "REDIRECT_REFUSED", "class": "EGRESS_REFUSED", "retryable": False, "retry_after_seconds": None},
        ["HTTP 302 with a Location on the same host. The egress policy follows no redirect: the call fails with class EGRESS_REFUSED, not retried (retrieval-result/1 rejects a retryable egress refusal)."],
        sleeps=[],
    ))
    out.append(err(
        "E-07-malformed-json", "A body that is not JSON is a malformed response",
        lambda steps: [dict(steps[0], reply={"status": 200, "headers": [], "body": "<html>gateway</html>\n"})],
        {"kind": "error", "code": "MALFORMED_RESPONSE", "class": "MALFORMED_RESPONSE", "retryable": False, "retry_after_seconds": None, "reason_contains": "invalid JSON"},
        ["HTTP 200 with an HTML body. The call was made and billed but it did not return a usable response, so the call log marks it MALFORMED_RESPONSE. Not retried."],
        sleeps=[], parse_error_step=1,
    ))
    out.append(err(
        "E-08-truncated-body", "A truncated JSON body is a malformed response",
        lambda steps: steps[:2] + [dict(steps[2], reply={"status": 200, "headers": [], "body": steps[2]["reply"]["body"][:120]})],
        {"kind": "error", "code": "MALFORMED_RESPONSE", "class": "MALFORMED_RESPONSE", "retryable": False, "retry_after_seconds": None, "reason_contains": "invalid JSON"},
        ["The bar response is cut off after 120 bytes. The JSON ends inside a value, so it is a malformed response and no partial bars are used."],
        sleeps=[], parse_error_step=3,
    ))
    out.append(err(
        "E-09-wrong-shape", "A JSON body of the wrong shape is a malformed response",
        lambda steps: steps[:2] + [dict(steps[2], reply={"status": 200, "headers": [], "body": '{"data": []}\n'})],
        {"kind": "error", "code": "MALFORMED_RESPONSE", "class": "MALFORMED_RESPONSE", "retryable": False, "retry_after_seconds": None, "reason_contains": "missing field"},
        ["The bar response is valid JSON but has no `bars` member. A missing field is a malformed response, not an empty result (an empty result is `bars: null` or `[]`)."],
        sleeps=[], parse_error_step=3,
    ))
    out.append(err(
        "E-10-repeated-token", "A page token that repeats is a malformed response",
        lambda steps: steps[:2] + [
            dict(steps[2], reply={"status": 200, "headers": [], "body": bars_body(plain[:2], token="tok-loop")}),
            dict(steps[2], expect=dict(steps[2]["expect"], query=steps[2]["expect"]["query"] + [["page_token", "tok-loop"]]),
                 reply={"status": 200, "headers": [], "body": bars_body(plain[2:4], token="tok-loop")}),
        ],
        {"kind": "error", "code": "MALFORMED_RESPONSE", "class": "MALFORMED_RESPONSE", "retryable": False, "retry_after_seconds": None, "reason_contains": "page token"},
        ["Page 1 returns next_page_token `tok-loop`. Page 2, requested with it, returns the same token. Following it again would loop, so the retrieval fails; the budget would otherwise be spent on the loop."],
        sleeps=[], parse_error_step=4,
    ))
    quoted = auto_bars(sessions)
    out.append(err(
        "E-11-quoted-number", "A price sent as a quoted string is a malformed response",
        lambda steps: steps[:2] + [dict(steps[2], reply={"status": 200, "headers": [], "body": bars_body(quoted).replace('"o":100.00', '"o":"100.00"', 1)})],
        {"kind": "error", "code": "MALFORMED_RESPONSE", "class": "MALFORMED_RESPONSE", "retryable": False, "retry_after_seconds": None, "reason_contains": "open"},
        ["The first bar's open is the string \"100.00\" instead of the number 100.00. The adapter reads numbers only; a quoted number is never coerced."],
        sleeps=[], parse_error_step=3,
    ))
    out.append(err(
        "E-12-duplicate-key", "A duplicate JSON key is a malformed response",
        lambda steps: [dict(steps[0], reply={"status": 200, "headers": [], "body": '{"id":"%s","id":"other","class":"us_equity","symbol":"SYNTH","status":"active"}\n' % ASSET_ID})],
        {"kind": "error", "code": "MALFORMED_RESPONSE", "class": "MALFORMED_RESPONSE", "retryable": False, "retry_after_seconds": None, "reason_contains": "duplicate field"},
        ["The asset record repeats the key `id` with two values. The last value must not silently win: the response is malformed."],
        sleeps=[], parse_error_step=1,
    ))
    out.append(err(
        "E-13-budget-ends-mid-pagination", "The request budget ends while bar pages remain",
        lambda steps: steps[:2] + [
            dict(steps[2], reply={"status": 200, "headers": [], "body": bars_body(plain[:2], token="tok-2")}),
            dict(steps[2], expect=dict(steps[2]["expect"], query=steps[2]["expect"]["query"] + [["page_token", "tok-2"]]),
                 reply={"status": 200, "headers": [], "body": bars_body(plain[2:4], token="tok-3")}),
        ],
        {"kind": "error", "code": "REQUEST_LIMIT_REACHED", "class": "UNAVAILABLE_DATA", "retryable": False, "retry_after_seconds": None},
        ["max_requests is 4. Calls 1 and 2 read the asset and the calendar, calls 3 and 4 read two bar pages, and page 2 names a third. The fifth request is refused before any I/O.",
         "A retrieval that stops here is partial and never complete: no manifest is returned. All 4 billed calls are recorded."],
        sleeps=[], limits={"max_requests": 4, "max_retries": 2, "request_timeout_seconds": 30, "max_response_bytes": 1048576},
    ))
    out.append(err(
        "E-14-retry-after-past-deadline", "A Retry-After beyond the deadline is not waited for",
        lambda steps: [dict(steps[0], reply={"status": 429, "headers": [["retry-after", "Sat, 14 Nov 2026 10:20:00 GMT"]], "body": ""})],
        {"kind": "error", "code": "RATE_LIMITED", "class": "RATE_LIMITED", "retryable": True, "retry_after_seconds": 1200},
        ["The request is made at 10:00:00Z with the deadline at 10:15:00Z. The 429 carries an HTTP date, 10:20:00Z: a wait of 1200 s, which would end after the deadline.",
         "The wait is not made and no second request goes out. The error keeps the hint, 1200 s, for the job's recovery policy."],
        sleeps=[],
    ))
    out.append(err(
        "E-15-response-too-large", "A response above the size limit is refused",
        lambda steps: [steps[0]],
        {"kind": "error", "code": "RESPONSE_TOO_LARGE", "class": "MALFORMED_RESPONSE", "retryable": False, "retry_after_seconds": None},
        ["max_response_bytes is 100. The asset record is larger, so the response is refused without being parsed."],
        sleeps=[], limits={"max_requests": 30, "max_retries": 2, "request_timeout_seconds": 30, "max_response_bytes": 100},
    ))
    out.append(err(
        "E-16-egress-refused", "An egress refusal is a policy failure and is never retried",
        lambda steps: [dict(steps[0], reply={"transport_error": "egress_refused"})],
        {"kind": "error", "code": "EGRESS_REFUSED", "class": "EGRESS_REFUSED", "retryable": False, "retry_after_seconds": None},
        ["The transport reports that the egress allowlist refused the request. It is a configuration failure, not a transient one: one call, no retry."],
        sleeps=[],
    ))
    return out


# ---- script ----------------------------------------------------------------------------------

def request_document(C):
    return {
        "schema_version": "retrieval-request/1",
        "job_id": "job-synth-retrieve-0001",
        "attempt": {"attempt_id": "att-synth-retrieve-0001-1", "ownership_revision": 1},
        "environment": "STAGING",
        "profile": {"id": "synth-us-daily-sip", "revision": 1, "digest": sha(b"synthetic research profile")},
        "instrument": {
            "instrument_id": INSTRUMENT_ID, "symbol": SYMBOL, "provider": "alpaca",
            "provider_asset_id": ASSET_ID, "effective_from": "2023-01-02",
        },
        "operations": [
            "provider:alpaca/daily_bars@1", "provider:alpaca/corporate_actions@1",
            "provider:alpaca/calendar@1", "provider:alpaca/asset@1",
        ],
        "range": {"start": C["start"], "end": C["end"]},
        "information_cutoff": ts(from_ts(C["now"])),
        "semantics": SEMANTICS,
        "limits": C["limits"],
        "deadline": ts(from_ts(C["now"]) + dt.timedelta(minutes=15)),
    }


SEMANTICS = {
    "feed": "SIP", "timeframe": "1Day", "adjustment": "RAW", "session_basis": "REGULAR_HOURS",
    "currency": "USD", "minimum_end_age_minutes": MIN_END_AGE_MINUTES,
    "bar_availability": {"rule": "SESSION_CLOSE_PLUS_DELAY", "delay_minutes": DELAY_MINUTES},
    "split_availability": {"provider_field": "declaration_date", "available_at": "EFFECTIVE_SESSION_OPEN",
                           "evidence": "DECLARED_BEFORE_EFFECTIVE_SESSION", "when_unevidenced": "BLOCK_PROFILE"},
    "dividend_availability": {"provider_field": "declaration_date", "available_at": "EFFECTIVE_SESSION_OPEN",
                              "evidence": "DECLARED_BEFORE_EFFECTIVE_SESSION", "when_unevidenced": "BLOCK_PROFILE"},
    "dividend_payment": {"provider_field": "payable_date", "payment_session": "PAYABLE_DATE",
                         "payment_phase": "AFTER_CLOSE", "when_unmatched": "BLOCK_PROFILE"},
}

HOST = {
    "adapter_version": "1",
    "executable": {"name": "engine-batch", "version": "0.0.0", "digest": sha(b"synthetic engine-batch binary")},
    "constraints": {"redistribution_permitted": False, "retain_raw": True, "terms_ref": TERMS_REF},
    "licence": LICENCE,
}


def listed_sessions(C):
    """The sessions the synthetic provider calendar lists, from the range start to 45 days after the end."""
    start, end = d(C["start"]), d(C["end"]) + dt.timedelta(days=45)
    return sessions_between(start, end, C["closed"])


def default_steps(C):
    """The happy-path script: asset, calendar, bar pages, action pages."""
    start, end = d(C["start"]), d(C["end"])
    rows = [(day,) + hours(day) for day in listed_sessions(C)]
    steps = [
        {"op": "asset", "expect": {"host": "paper", "path": "/v2/assets/" + SYMBOL, "query": []},
         "reply": {"status": 200, "headers": [["content-type", "application/json"]], "body": asset_body(C["asset"])}},
        {"op": "calendar", "expect": {"host": "paper", "path": "/v2/calendar", "query": [
            ["start", C["start"]], ["end", (end + dt.timedelta(days=45)).isoformat()]]},
         "reply": {"status": 200, "headers": [["content-type", "application/json"]], "body": calendar_body(rows)}},
    ]
    now = from_ts(C["now"])
    bars_end = min(from_ts(C["end"] + "T23:59:59Z"), now - dt.timedelta(minutes=MIN_END_AGE_MINUTES))
    base_query = [
        ["timeframe", "1Day"], ["start", C["start"] + "T00:00:00Z"], ["end", ts(bars_end)],
        ["limit", "10000"], ["adjustment", "raw"], ["feed", "sip"], ["sort", "asc"],
    ]
    bars = C["bars"]
    if bars is None:
        bars = auto_bars([day for day in listed_sessions(C) if start <= day <= end], skip=C["bar_skip"])
    if C["bars_raw"] == "empty":
        pages = [(empty_bars_body(), None)]
    else:
        sizes = C["bar_pages"] or [len(bars) or 1]
        pages, at = [], 0
        for index, size in enumerate(sizes):
            chunk = bars[at:at + size]
            at += size
            token = "tok-bars-%d" % (index + 2) if index + 1 < len(sizes) else None
            pages.append((bars_body(chunk, token=token), token))
    token = None
    for body, nxt in pages:
        query = list(base_query) + ([["page_token", token]] if token else [])
        steps.append({"op": "bars", "expect": {"host": "data", "path": "/v2/stocks/%s/bars" % SYMBOL, "query": query},
                      "reply": {"status": 200, "headers": [["content-type", "application/json"]], "body": body}})
        token = nxt
    actions_query = [
        ["symbols", SYMBOL], ["start", (start - dt.timedelta(days=31)).isoformat()],
        ["end", (end + dt.timedelta(days=31)).isoformat()], ["limit", "1000"],
    ]
    if C["actions_raw"] == "empty":
        pages = [('{\n "corporate_actions": {},\n "next_page_token": null\n}\n', None)]
    else:
        groups = C["action_pages"] or [list(range(len(C["actions"])))]
        pages = []
        for index, group in enumerate(groups):
            token = "tok-actions-%d" % (index + 2) if index + 1 < len(groups) else None
            pages.append((actions_body([C["actions"][i] for i in group], token=token), token))
    token = None
    for body, nxt in pages:
        query = list(actions_query) + ([["page_token", token]] if token else [])
        steps.append({"op": "actions", "expect": {"host": "data", "path": "/v1/corporate-actions", "query": query},
                      "reply": {"status": 200, "headers": [["content-type", "application/json"]], "body": body}})
        token = nxt
    return steps


OPERATION = {"asset": "asset", "calendar": "calendar", "bars": "daily_bars", "actions": "corporate_actions"}


# ---- the retry simulation ---------------------------------------------------------------------

def backoff(retries):
    return min(60, 2 ** retries)


def classify(reply, max_bytes, clock):
    """(error class, code, retryable, retry hint) of one reply, or None for success."""
    if "transport_error" in reply:
        return {
            "timeout": ("TIMEOUT", "TIMEOUT", True, None),
            "connection": ("UNAVAILABLE_DATA", "CONNECTION", True, None),
            "egress_refused": ("EGRESS_REFUSED", "EGRESS_REFUSED", False, None),
        }[reply["transport_error"]]
    status = reply["status"]
    if 200 <= status <= 299:
        if len(reply["body"].encode()) > max_bytes:
            return ("MALFORMED_RESPONSE", "RESPONSE_TOO_LARGE", False, None)
        return None
    if 300 <= status <= 399:
        return ("EGRESS_REFUSED", "REDIRECT_REFUSED", False, None)
    if status == 401:
        return ("AUTHENTICATION", "AUTHENTICATION", False, None)
    if status == 403:
        return ("PERMISSION", "PERMISSION", False, None)
    if status == 404:
        return ("UNAVAILABLE_DATA", "NOT_FOUND", False, None)
    if status == 429:
        hint = None
        for name, value in reply["headers"]:
            if name == "retry-after":
                value = value.strip()
                if value.isdigit():
                    hint = min(int(value), 86400)
                else:
                    moment = dt.datetime.strptime(value, "%a, %d %b %Y %H:%M:%S GMT").replace(tzinfo=UTC)
                    hint = min(max(int((moment - clock).total_seconds()), 0), 86400)
        return ("RATE_LIMITED", "RATE_LIMITED", True, hint)
    if status == 408 or 500 <= status <= 599:
        return ("UNAVAILABLE_DATA", "SERVER", True, None)
    return ("UNSUPPORTED_CAPABILITY", "BAD_REQUEST", False, None)


def simulate(C, steps):
    clock = from_ts(C["now"])
    deadline = clock + dt.timedelta(minutes=15)
    calls, sleeps, sources = [], [], []
    failure = None
    retries = 0
    index = 0
    while index < len(steps):
        if len(calls) >= C["limits"]["max_requests"]:
            failure = ("UNAVAILABLE_DATA", "REQUEST_LIMIT_REACHED", False, None)
            break
        step = steps[index]
        reply = step["reply"]
        verdict = classify(reply, C["limits"]["max_response_bytes"], clock)
        sequence = len(calls) + 1
        call = {
            "sequence": sequence, "operation": OPERATION[step["op"]], "started_at": ts(clock),
            "http_status": reply.get("status"), "error": verdict[0] if verdict else None,
            "retry_after_seconds": verdict[3] if verdict else None,
        }
        parse_error_step = C.get("parse_error_step")
        if verdict is None and parse_error_step == index + 1:
            call["error"] = "MALFORMED_RESPONSE"
            calls.append(call)
            failure = ("MALFORMED_RESPONSE", "MALFORMED_RESPONSE", False, None)
            break
        calls.append(call)
        if verdict is None:
            sources.append({"sequence": sequence, "step": step, "received_at": ts(clock)})
            index += 1
            retries = 0
            continue
        if not verdict[2] or retries >= C["limits"]["max_retries"] or len(calls) >= C["limits"]["max_requests"]:
            failure = verdict
            break
        wait = max(verdict[3] or 0, backoff(retries))
        if clock + dt.timedelta(seconds=wait) > deadline:
            failure = verdict
            break
        sleeps.append(wait)
        clock += dt.timedelta(seconds=wait)
        retries += 1
        # a retry repeats the same request: the next step in the script is the answer to it
        index += 1
    if failure is None and steps:
        last = steps[-1]
        pending = last["op"] in ("bars", "actions") and json.loads(last["reply"]["body"]).get("next_page_token")
        if pending and len(calls) >= C["limits"]["max_requests"]:
            failure = ("UNAVAILABLE_DATA", "REQUEST_LIMIT_REACHED", False, None)
    return {"calls": calls, "sleeps": sleeps, "sources": sources, "failure": failure, "end": clock}


# ---- the expected manifest --------------------------------------------------------------------

class Blocked(Exception):
    def __init__(self, code, subject, klass):
        super().__init__(code)
        self.code, self.subject, self.klass = code, subject, klass


def decimals(text):
    return len(text.split(".")[1]) if "." in text else 0


def is_identifier(text):
    import re
    return re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}", text) is not None


def compute(C, sim):
    """The expected manifest, derived from the case data and the rules, or a Blocked verdict."""
    start, end = d(C["start"]), d(C["end"])
    asset = C["asset"]
    for field, want in (("id", ASSET_ID), ("symbol", SYMBOL), ("class", "us_equity")):
        if asset[field] != want:
            raise Blocked("INSTRUMENT_MISMATCH", field, "UNAVAILABLE_DATA")

    # Calendar: every listed session with its UTC open and close, by the tz database.
    cal = {}
    for day in listed_sessions(C):
        opened, closed = hours(day)
        cal[day] = (local(day, opened), local(day, closed))

    bars = {}
    for raw in C["bars_resolved"]:
        stamp = from_ts(raw["stamp"])
        at_ny = stamp.astimezone(NY)
        if (at_ny.hour, at_ny.minute, at_ny.second) != (0, 0, 0):
            raise Blocked("BAR_NOT_AT_SESSION_START", raw["stamp"], "MALFORMED_RESPONSE")
        session = at_ny.date()
        if session not in cal:
            raise Blocked("BAR_ON_NON_SESSION", session.isoformat(), "MALFORMED_RESPONSE")
        values = {k: canon_dec(raw[k]) for k in ("o", "h", "l", "c", "v")}
        o, h, l, c = (Decimal(values[k]) for k in ("o", "h", "l", "c"))
        if min(o, h, l, c) <= 0 or max(o, h, l, c) > 10 ** 9 or h < max(o, c, l) or l > min(o, c, h):
            raise Blocked("INVALID_BAR", session.isoformat(), "MALFORMED_RESPONSE")
        volume = Decimal(values["v"])
        if volume != volume.to_integral_value() or volume < 0 or volume > 10 ** 15:
            raise Blocked("INVALID_BAR", session.isoformat(), "MALFORMED_RESPONSE")
        if session in bars and bars[session] != values:
            raise Blocked("CONFLICTING_DUPLICATE_BAR", session.isoformat(), "MALFORMED_RESPONSE")
        bars[session] = values
    scale = max([decimals(v[k]) for v in bars.values() for k in ("o", "h", "l", "c")] or [0])
    if scale > 4:
        raise Blocked("PRICE_SCALE_ABOVE_LIMIT", str(scale), "UNSUPPORTED_CAPABILITY")

    # Corporate actions.
    kept = [a for a in C["actions"] if start <= d(a["ex_date"]) <= end]

    def rank(a):
        return {"forward_splits": 0, "reverse_splits": 0, "cash_dividends": 1}.get(a["type"], 2)

    kept.sort(key=lambda a: (a["ex_date"], rank(a), a.get("id", "")))
    counts, actions, evidence, payments = {}, [], [], []
    for a in kept:
        if a["type"] not in ("forward_splits", "reverse_splits", "cash_dividends"):
            raise Blocked("UNSUPPORTED_ACTION_TYPE", a["type"], "UNSUPPORTED_CAPABILITY")
        prefix = "div" if a["type"] == "cash_dividends" else "split"
        key = (a["ex_date"], prefix)
        counts[key] = counts.get(key, 0) + 1
        action_id = "%s-%s-%s" % (prefix, SYMBOL.lower(), a["ex_date"])
        if counts[key] > 1:
            action_id += "-%d" % counts[key]
        ex = d(a["ex_date"])
        if ex not in cal:
            raise Blocked("ACTION_EX_DATE_NOT_SESSION", action_id, "UNAVAILABLE_DATA")
        declared = a.get("declaration_date")
        if declared is None:
            raise Blocked("ACTION_NOT_EVIDENCED", action_id, "UNAVAILABLE_DATA")
        if d(declared) >= ex:
            raise Blocked("ACTION_DECLARED_NOT_BEFORE_EX_DATE", action_id, "UNAVAILABLE_DATA")
        available_at = ts(cal[ex][0])
        if prefix == "split":
            from fractions import Fraction
            ratio = Fraction(Decimal(a["new_rate"])) / Fraction(Decimal(a["old_rate"]))
            if not (1 <= ratio.numerator <= 1000 and 1 <= ratio.denominator <= 1000):
                raise Blocked("UNREPRESENTABLE_SPLIT_RATIO", action_id, "UNSUPPORTED_CAPABILITY")
            actions.append({"kind": "SPLIT", "action_id": action_id, "effective_session": a["ex_date"],
                            "available_at": available_at, "ratio_new": ratio.numerator, "ratio_old": ratio.denominator})
        elif a.get("special") or a.get("foreign"):
            actions.append({"kind": "SPECIAL_DISTRIBUTION", "action_id": action_id,
                            "effective_session": a["ex_date"], "available_at": available_at})
        else:
            rate = canon_dec(a["rate"])
            if Decimal(rate) <= 0 or decimals(rate) > 8:
                raise Blocked("INVALID_ACTION_VALUE", action_id, "UNSUPPORTED_CAPABILITY")
            payable = d(a["payable_date"])
            if payable not in cal:
                raise Blocked("PAYABLE_DATE_NOT_SESSION", action_id, "UNAVAILABLE_DATA")
            if payable < ex:
                raise Blocked("PAYABLE_BEFORE_EX_DATE", action_id, "UNAVAILABLE_DATA")
            payments.append(payable)
            actions.append({"kind": "CASH_DIVIDEND", "action_id": action_id, "effective_session": a["ex_date"],
                            "available_at": available_at, "amount_per_share": rate,
                            "payment_session": payable.isoformat(), "payment_phase": "AFTER_CLOSE"})
        record = a.get("id")
        evidence.append({
            "action_id": action_id,
            "provider_record_id": record if record and is_identifier(record) else "alpaca:" + action_id,
            "provider_field": "declaration_date", "provider_value": declared,
        })

    cal_end = max([end] + payments)
    calendar = [{"session": day.isoformat(), "open_at": ts(cal[day][0]), "close_at": ts(cal[day][1])}
                for day in sorted(cal) if start <= day <= cal_end]
    bar_list = []
    for session in sorted(bars):
        v, close_at = bars[session], cal[session][1]
        bar_list.append({
            "session": session.isoformat(), "open": v["o"], "high": v["h"], "low": v["l"], "close": v["c"],
            "volume": v["v"], "event_time": ts(close_at),
            "available_at": ts(close_at + dt.timedelta(minutes=DELAY_MINUTES)),
        })
    expected_days = [day for day in sorted(cal) if start <= day <= end]
    missing = [day.isoformat() for day in expected_days if day not in bars]
    completeness = "NO_OBSERVATIONS" if not bars else ("COMPLETE" if not missing else "PARTIAL")
    coverage = {"requested": {"start": C["start"], "end": C["end"]}, "completeness": completeness,
                "bar_count": len(bars), "missing_sessions": missing}
    if bars:
        coverage["returned"] = {"start": min(bars).isoformat(), "end": max(bars).isoformat()}
    content = {"calendar": calendar, "bars": bar_list, "corporate_actions": actions,
               "unplanned_events": [], "action_evidence": evidence}
    content_digest = sha(canon(content).encode())
    request = request_document(C)
    responses = []
    for source in sim["sources"]:
        body = source["step"]["reply"]["body"].encode()
        responses.append({
            "sequence": source["sequence"],
            "operation": "provider:alpaca/%s@1" % OPERATION[source["step"]["op"]],
            "received_at": source["received_at"], "content_digest": sha(body),
            "stored": {"digest": sha(body), "media_type": "application/json", "size_bytes": len(body)},
        })
    with open(RULES_PATH, "rb") as handle:
        rules_digest = sha(handle.read())
    manifest = {
        "schema_version": "dataset-manifest/1",
        "dataset": {
            "id": "alpaca-%s-1day-raw-sip-%s-%s" % (SYMBOL.lower(), C["start"].replace("-", ""), C["end"].replace("-", "")),
            "version": "c" + content_digest[len("sha256:"):][:16],
            "source": "PROVIDER", "licence": LICENCE,
        },
        "instrument": request["instrument"],
        "source": {
            "provider": "alpaca", "feed": "SIP", "adapter": {"name": "alpaca", "version": "1"},
            "transformation": {"name": "alpaca-daily-normaliser", "version": "1", "digest": rules_digest},
            "executable": HOST["executable"], "profile": request["profile"],
        },
        "semantics": SEMANTICS,
        "coverage": coverage,
        "retrieval": {
            "job_id": request["job_id"], "attempt_id": request["attempt"]["attempt_id"],
            "request_digest": sha(canon(request).encode()), "retrieved_at": ts(sim["end"]),
        },
        "content": content,
        "source_responses": responses,
        "constraints": {"redistribution": "NOT_PERMITTED", "raw_retention": "RETAIN", "terms_ref": TERMS_REF},
    }
    return manifest, scale


# ---- writing ----------------------------------------------------------------------------------

def derivation_text(C, outcome_lines):
    lines = ["# %s: %s" % (C["id"], C["title"]), "",
             "Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.", "",
             "## Derivation", ""]
    for number, note in enumerate(C["notes"], 1):
        lines.append("%d. %s" % (number, note))
    lines += ["", "## Expected outcome", ""] + outcome_lines + [""]
    return "\n".join(lines)


def write_case(C):
    steps = default_steps(C)
    if C["edit"]:
        steps = C["edit"](steps)
    C["bars_resolved"] = C["bars"] if C["bars"] is not None else auto_bars(
        [day for day in listed_sessions(C) if d(C["start"]) <= day <= d(C["end"])], skip=C["bar_skip"])
    if C["bars_raw"] == "empty":
        C["bars_resolved"] = []
    sim = simulate(C, steps)
    kind = (C["expect"] or {"kind": "snapshot"})["kind"]
    expect = {"requests": len(sim["calls"]), "calls": sim["calls"], "sleeps": sim["sleeps"]}
    outcome_lines = []
    if sim["failure"] is not None:
        klass, code, retryable, hint = sim["failure"]
        declared = C["expect"]
        assert declared["kind"] == "error", (C["id"], "unexpected failure", sim["failure"])
        assert (declared["class"], declared["code"], declared["retryable"], declared["retry_after_seconds"]) == (klass, code, retryable, hint), (
            C["id"], "the hand-stated error differs from the simulation", sim["failure"])
        expect["outcome"] = "error"
        expect["error"] = {k: v for k, v in declared.items() if k != "kind"}
        outcome_lines = ["The retrieval fails with `%s` (class %s, retryable %s)." % (code, klass, str(retryable).lower()),
                         "Billed calls: %d. Waits: %s." % (len(sim["calls"]), sim["sleeps"] or "none")]
    else:
        assert kind != "error", (C["id"], "the case should fail")
        try:
            manifest, scale = compute(C, sim)
        except Blocked as blocked:
            declared = C["expect"]
            assert declared["kind"] == "blocked", (C["id"], "unexpected block", blocked.code)
            assert (declared["code"], declared["subject"], declared["class"]) == (blocked.code, blocked.subject, blocked.klass), (
                C["id"], "the hand-stated block differs", blocked.code, blocked.subject, blocked.klass)
            expect["outcome"] = "blocked"
            expect["block"] = {"code": blocked.code, "subject": blocked.subject, "class": blocked.klass}
            outcome_lines = ["The profile is blocked: `%s` (subject `%s`, class %s). No manifest is produced." % (blocked.code, blocked.subject, blocked.klass)]
        else:
            assert kind == "snapshot", (C["id"], "the case should be blocked")
            for label, getter, hand in C["hand"]:
                got = getter(manifest)
                assert got == hand, (C["id"], label, got, hand)
            expect["outcome"] = "snapshot"
            expect["manifest"] = manifest
            expect["digest"] = sha(canon(manifest).encode())
            expect["price_scale"] = scale
            expect["money_scale"] = max(2, scale)
            expect["overflow_evidence_required"] = scale >= 3
            outcome_lines = ["The manifest is in `expected.json`; its digest is `%s`." % expect["digest"],
                             "Coverage: %s, %d bars. Price scale %d, money scale %d." % (
                                 manifest["coverage"]["completeness"], manifest["coverage"]["bar_count"], scale, max(2, scale)),
                             "", "Hand-derived values, asserted by the oracle:", ""]
            outcome_lines += ["- %s: `%s`" % (label, json.dumps(hand)) for label, _, hand in C["hand"]]
    if "sleeps" in C:
        assert C["sleeps"] == sim["sleeps"], (C["id"], "hand-stated waits differ", C["sleeps"], sim["sleeps"])
    if "hand_calls" in C:
        operation, count = C["hand_calls"]
        assert sum(1 for call in sim["calls"] if call["operation"] == operation) == count, (C["id"], "hand-stated calls differ")

    directory = os.path.join(CASES, C["id"])
    os.makedirs(os.path.join(directory, "responses"))
    script = []
    for number, step in enumerate(steps, 1):
        reply = dict(step["reply"])
        if "body" in reply:
            name = "responses/%02d-%s.json" % (number, step["op"])
            with open(os.path.join(directory, name), "wb") as handle:
                handle.write(reply["body"].encode())
            reply["body"] = name
        script.append({"expect": step["expect"], "reply": reply})
    with open(os.path.abspath(__file__), "rb") as handle:
        oracle_hash = sha(handle.read())
    files = {
        "case.json": {"id": C["id"], "title": C["title"], "now": C["now"], "request": request_document(C),
                      "host": HOST, "script": script, "expected": "expected.json", "derivation": "derivation.md"},
        "expected.json": {"schema": "market-expected/1", "case": C["id"],
                          "origin": {"kind": "oracle", "oracle": "oracle/oracle.py", "oracle_sha256": oracle_hash},
                          "expect": expect},
    }
    for name, value in files.items():
        with open(os.path.join(directory, name), "w") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
    with open(os.path.join(directory, "derivation.md"), "w") as handle:
        handle.write(derivation_text(C, outcome_lines))


def main():
    if os.path.isdir(CASES):
        shutil.rmtree(CASES)
    os.makedirs(CASES)
    specs = build_cases()
    ids = [spec["id"] for spec in specs]
    assert len(ids) == len(set(ids)), "duplicate case id"
    for spec in specs:
        write_case(spec)
    with open(os.path.join(CASES, "index.json"), "w") as handle:
        json.dump({"schema": "market-cases/1", "cases": ids}, handle, indent=2)
        handle.write("\n")
    print("wrote %d cases" % len(ids))


if __name__ == "__main__":
    sys.exit(main())
