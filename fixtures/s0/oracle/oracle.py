#!/usr/bin/env python3
"""Independent exact-arithmetic oracle for the S0 offline seed evaluation.

Author: agent C1 (independent fixture author). Python 3 standard library only.

This script derives every S0 fixture case from the specification (OQ-02 sections
2.1 to 2.6 and 9, OQ-06 section 8, OQ-05 section 7) and the declared policy of the
S0 research log (docs/research-logs/2026-11-13-s0-offline-seed-evaluation.md: the policy table, Interpretations 1 to
16 and the information cutoff section). It never reads or runs the Rust engine. All
arithmetic uses fractions.Fraction (exact rationals). Rounding happens only at
the explicit policy points: floor, ceil and half-even.

The grid-tie cases G-01 to G-11b pin exact decisions where the exact value is a price on the grid although an
intermediate value (ATR = sum / 3, a mean, a split-converted level) has no finite decimal form. They are written
before and apart from the engine; see the section "grid ties" below and fixtures/s0/README.md.

Run:  python3 -I fixtures/s0/oracle/oracle.py   (from the repository root)
It writes case.json, input.json, expected.json, derivation.md (and strategy.json
where a case has its own strategy) for every case, fixtures/s0/coverage.json and
the protocol manifest additions. The output is deterministic.
"""
import copy
import hashlib
import json
import math
import os
import sys
import types
from datetime import date, timedelta
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
S0 = os.path.dirname(HERE)                      # fixtures/s0
FIXTURES = os.path.dirname(S0)                  # fixtures
CASES = os.path.join(S0, "cases")
STRATS = os.path.join(S0, "strategies")
PROTO = os.path.join(FIXTURES, "protocol")

# ---------------------------------------------------------------- numerics


def floor_to(x, s):
    m = 10 ** s
    return F(math.floor(F(x) * m), m)


def ceil_to(x, s):
    m = 10 ** s
    return F(math.ceil(F(x) * m), m)


def round_he(x, s):
    """Half-even rounding to s decimals (Fraction.__round__ is half-even)."""
    m = 10 ** s
    return F(round(F(x) * m), m)


def fmt(x, s):
    """Exact decimal string with exactly s decimals. x must be representable."""
    x = F(x)
    n = x * 10 ** s
    if n.denominator != 1:
        raise ValueError("value %s not representable at scale %d" % (x, s))
    n = int(n)
    sign = "-" if n < 0 else ""
    n = abs(n)
    ip, fp = divmod(n, 10 ** s)
    return sign + str(ip) + ("." + str(fp).zfill(s) if s > 0 else "")


def terminates(x):
    d = F(x).denominator
    while d % 2 == 0:
        d //= 2
    while d % 5 == 0:
        d //= 5
    return d == 1


def fmt_exact(x):
    """Shortest exact decimal string (no trailing zeros). Fails if not terminating."""
    x = F(x)
    if not terminates(x):
        raise ValueError("value %s is not a terminating decimal" % x)
    s = 0
    while (x * 10 ** s).denominator != 1:
        s += 1
    return fmt(x, s)


def diag(x, s=4):
    """Indicator display: half-even to the diagnostic scale."""
    return fmt(round_he(x, s), s)


# ---------------------------------------------------------------- identity


def canon(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha(v):
    return "sha256:" + hashlib.sha256(canon(v).encode("utf-8")).hexdigest()


def file_sha256_hex(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


# ---------------------------------------------------------------- JSON output


def jdump(obj, indent=0, width=170):
    """Readable JSON: containers that fit in one line stay on one line."""
    one = json.dumps(obj, ensure_ascii=False, separators=(", ", ": "))
    if not isinstance(obj, (dict, list)) or len(one) + indent <= width:
        return one
    pad = " " * indent
    if isinstance(obj, dict):
        items = ["%s  %s: %s" % (pad, json.dumps(k, ensure_ascii=False), jdump(v, indent + 2, width))
                 for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    items = ["%s  %s" % (pad, jdump(v, indent + 2, width)) for v in obj]
    return "[\n" + ",\n".join(items) + "\n" + pad + "]"


def write_json(path, obj, width=170):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(jdump(obj, 0, width) + "\n")


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


# ---------------------------------------------------------------- calendar


def weekdays(start_iso, n):
    d = date.fromisoformat(start_iso)
    out = []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def open_at(sess):
    return sess + "T14:30:00Z"


def close_at(sess):
    return sess + "T21:00:00Z"


def calendar_entries(sessions):
    return [{"session": s, "open_at": open_at(s), "close_at": close_at(s)} for s in sessions]


# ---------------------------------------------------------------- missing values


class Miss:
    """A missing indicator value with its reason."""

    def __init__(self, reason):
        self.reason = reason

    def __repr__(self):
        return "Miss(%s)" % self.reason

    def __eq__(self, other):
        return isinstance(other, Miss) and other.reason == self.reason

    def __hash__(self):
        return hash(self.reason)


def is_miss(x):
    return isinstance(x, Miss)


FIELD = {"OPEN": "o", "HIGH": "h", "LOW": "l", "CLOSE": "c", "VOLUME": "v"}


def op_name(node):
    return node["op"].split(":", 1)[1].rsplit("@", 1)[0]


def unit_of(node, named):
    op = op_name(node)
    p = node["params"]
    a = node["args"]
    if op == "const":
        return p["unit"]
    if op == "bar_field":
        return "SHARES" if p["field"] == "VOLUME" else "PRICE"
    if op == "ref":
        return unit_of(named[p["name"]], named)
    if op in ("lag", "sma"):
        return unit_of(a[0], named)
    if op == "rsi_simple":
        return "POINTS"
    if op == "atr_simple":
        return "PRICE"
    if op in ("add", "sub"):
        return unit_of(a[0], named)
    if op == "mul":
        u0, u1 = unit_of(a[0], named), unit_of(a[1], named)
        return u1 if u0 == "RATIO" else u0
    if op == "div":
        u0, u1 = unit_of(a[0], named), unit_of(a[1], named)
        return "RATIO" if u0 == u1 else u0
    if op in ("entry_price",):
        return "PRICE"
    if op == "snapshot":
        return "PRICE"
    return "FLAG"


# ---------------------------------------------------------------- tree interpreter


class Tree:
    """Evaluates a Strategy Definition operator tree with exact arithmetic."""

    def __init__(self, strat):
        self.strat = strat
        self.d = strat["definition"]
        self.named = {n["name"]: n["expr"] for n in self.d["indicators"]}
        self.order = [n["name"] for n in self.d["indicators"]]

    def ev(self, series, node, k, memo):
        key = (id(node), k)
        if key in memo:
            return memo[key]
        v = self._ev(series, node, k, memo)
        memo[key] = v
        return v

    def _args(self, series, node, k, memo):
        vals = [self.ev(series, a, k, memo) for a in node["args"]]
        for v in vals:
            if is_miss(v):
                return None, Miss("UPSTREAM_MISSING")
        return vals, None

    def _ev(self, series, node, k, memo):
        op = op_name(node)
        p = node["params"]
        a = node["args"]
        if op == "const":
            return F(p["value"])
        if op == "bar_field":
            if k < 0:
                return Miss("INSUFFICIENT_HISTORY")
            return series[k][FIELD[p["field"]]]
        if op == "ref":
            return self.ev(series, self.named[p["name"]], k, memo)
        if op == "lag":
            kk = k - p["periods"]
            if kk < 0:
                return Miss("INSUFFICIENT_HISTORY")
            return self.ev(series, a[0], kk, memo)
        if op == "sma":
            w = p["window"]
            if k < w - 1:
                return Miss("INSUFFICIENT_HISTORY")
            vals = [self.ev(series, a[0], k - i, memo) for i in range(w)]
            for v in vals:
                if is_miss(v):
                    return v
            return sum(vals, F(0)) / w
        if op == "rsi_simple":
            w = p["window"]
            if k < w:
                return Miss("INSUFFICIENT_HISTORY")
            cl = [self.ev(series, a[0], k - w + i, memo) for i in range(w + 1)]
            for v in cl:
                if is_miss(v):
                    return v
            g = sum((max(cl[i + 1] - cl[i], F(0)) for i in range(w)), F(0))
            l = sum((max(cl[i] - cl[i + 1], F(0)) for i in range(w)), F(0))
            if g == 0 and l == 0:
                return Miss("UNDEFINED_FLAT")
            # mean_gain / mean_loss with the common divisor w cancelled
            if l == 0:
                return F(100)
            return 100 - 100 / (1 + g / l)
        if op == "atr_simple":
            w = p["window"]
            if k < w:
                return Miss("INSUFFICIENT_HISTORY")
            trs = []
            for j in range(k - w + 1, k + 1):
                b, pc = series[j], series[j - 1]["c"]
                trs.append(max(b["h"] - b["l"], abs(b["h"] - pc), abs(b["l"] - pc)))
            return sum(trs, F(0)) / w
        vals, m = self._args(series, node, k, memo)
        if m is not None:
            return m
        return self._combine(op, vals)

    @staticmethod
    def _combine(op, vals):
        if op == "add":
            return vals[0] + vals[1]
        if op == "sub":
            return vals[0] - vals[1]
        if op == "mul":
            return vals[0] * vals[1]
        if op == "div":
            if vals[1] == 0:
                return Miss("DIV_BY_ZERO")
            return vals[0] / vals[1]
        if op == "gt":
            return vals[0] > vals[1]
        if op == "gte":
            return vals[0] >= vals[1]
        if op == "lt":
            return vals[0] < vals[1]
        if op == "lte":
            return vals[0] <= vals[1]
        if op == "and":
            return all(vals)
        if op == "or":
            return any(vals)
        raise KeyError("oracle does not implement operator " + op)

    def evp(self, node, ctx):
        """Position-scope evaluation: entry_price, snapshot, raw current bar."""
        op = op_name(node)
        p = node["params"]
        if op == "const":
            return F(p["value"])
        if op == "entry_price":
            return ctx["entry"]
        if op == "snapshot":
            return ctx["snaps"][p["name"]]
        if op == "bar_field":
            return ctx["bar"][FIELD[p["field"]]]
        vals = [self.evp(a, ctx) for a in node["args"]]
        return self._combine(op, vals)


# ---------------------------------------------------------------- strategy evaluators


class TreeStrategy:
    """Interprets a reduced strategy artefact."""

    seed_mode = False

    def __init__(self, strat):
        self.strat = strat
        self.tree = Tree(strat)
        d = strat["definition"]
        self.names = self.tree.order
        self.snap_exprs = d["entry"]["snapshots"]
        self.units = {s["name"]: unit_of(s["expr"], self.tree.named) for s in self.snap_exprs}
        self.adjustments = d["exits"]["stop_adjustments"]

    def signal(self, series, t):
        tr = self.tree
        memo = {}
        inds = [(n, tr.ev(series, tr.named[n], t, memo)) for n in self.names]
        cond = tr.ev(series, self.strat["definition"]["entry"]["condition"], t, memo)
        rank = None
        snaps = None
        if cond is True:
            rank = tr.ev(series, self.strat["definition"]["entry"]["rank"], t, memo)
            snaps = {s["name"]: tr.ev(series, s["expr"], t, memo) for s in self.snap_exprs}
        return {"ind": inds, "cond": cond, "rank": rank, "snaps": snaps}

    def levels(self, entry, snaps):
        ctx = {"entry": entry, "snaps": snaps, "bar": None}
        ex = self.strat["definition"]["exits"]
        return self.tree.evp(ex["stop"], ctx), self.tree.evp(ex["target"], ctx)

    def adj_fire(self, adj, entry, snaps, bar):
        ctx = {"entry": entry, "snaps": snaps, "bar": bar}
        return self.tree.evp(adj["trigger"], ctx) is True

    def adj_level(self, adj, entry, snaps):
        return self.tree.evp(adj["new_level"], {"entry": entry, "snaps": snaps, "bar": None})


def sma_at(vals, t, w):
    if t < w - 1:
        return Miss("INSUFFICIENT_HISTORY")
    return sum(vals[t - w + 1:t + 1], F(0)) / w


def rsi_at(closes, t, w=14):
    if t < w:
        return Miss("INSUFFICIENT_HISTORY")
    g = l = F(0)
    for j in range(t - w + 1, t + 1):
        ch = closes[j] - closes[j - 1]
        if ch > 0:
            g += ch
        else:
            l += -ch
    if g == 0 and l == 0:
        return Miss("UNDEFINED_FLAT")
    return F(100) * g / (g + l)


def atr_at(series, t, w=14):
    if t < w:
        return Miss("INSUFFICIENT_HISTORY")
    tot = F(0)
    for j in range(t - w + 1, t + 1):
        b, pc = series[j], series[j - 1]["c"]
        tot += max(b["h"] - b["l"], abs(b["h"] - pc), abs(b["l"] - pc))
    return tot / w


class SeedStrategy(TreeStrategy):
    """Hard-coded OQ-02 section 2.6 seed rules, cross-checked against the artefact tree.

    The threshold and the presence of the break-even rule are read from the artefact
    (they are the data that differs between variants). Every rule below is written
    from the specification table, not from the artefact.
    """

    seed_mode = True

    def __init__(self, strat):
        super().__init__(strat)
        named = self.tree.named
        self.thr = F(named["weak_threshold"]["params"]["value"])
        adj = strat["definition"]["exits"]["stop_adjustments"]
        self.break_even = len(adj) == 1 and adj[0]["id"] == "break_even"

    def seed_values(self, series, t):
        closes = [b["c"] for b in series]
        vols = [b["v"] for b in series]
        ind = {
            "sma50": sma_at(closes, t, 50),
            "vol_sma20": sma_at(vols, t, 20),
            "rsi14": rsi_at(closes, t),
            "atr14": atr_at(series, t),
            "rsi_floor": F(30),
            "weak_threshold": self.thr,
        }
        for name, p in (("rsi_lag1", 1), ("rsi_lag2", 2)):
            ind[name] = rsi_at(closes, t - p) if t - p >= 0 else Miss("INSUFFICIENT_HISTORY")
        return ind

    def signal(self, series, t):
        ind = self.seed_values(series, t)
        b = series[t]
        needed = [ind[k] for k in ("sma50", "rsi_lag2", "rsi_lag1", "rsi14", "vol_sma20", "atr14")]
        if any(is_miss(x) for x in needed):
            cond, rank, snaps = Miss("UPSTREAM_MISSING"), None, None
        else:
            cond = bool(b["c"] > ind["sma50"]
                        and (ind["rsi_lag2"] <= self.thr or ind["rsi_lag1"] <= self.thr)
                        and ind["rsi14"] > 30
                        and b["v"] > ind["vol_sma20"]
                        and ind["atr14"] > 0
                        and ind["vol_sma20"] > 0)
            rank = None
            snaps = None
            if cond:
                rank = 50 * (b["v"] / ind["vol_sma20"]) + (100 - ind["rsi14"])
                snaps = {"entry_atr": ind["atr14"]}
        out = {"ind": [(n, ind[n]) for n in self.names], "cond": cond, "rank": rank, "snaps": snaps}
        ref = super().signal(series, t)
        self._same(out, ref, t)
        return out

    @staticmethod
    def _same(a, b, t):
        ok = a["cond"] == b["cond"] and a["rank"] == b["rank"] and a["snaps"] == b["snaps"]
        for (n1, v1), (n2, v2) in zip(a["ind"], b["ind"]):
            ok = ok and n1 == n2 and v1 == v2
        if not ok:
            raise AssertionError("seed rules and artefact tree disagree at index %d: %r vs %r" % (t, a, b))

    def levels(self, entry, snaps):
        atr = snaps["entry_atr"]
        res = (entry - 2 * atr, entry + 5 * atr)
        if res != super().levels(entry, snaps):
            raise AssertionError("seed exit levels and artefact tree disagree")
        return res

    def adj_fire(self, adj, entry, snaps, bar):
        res = bar["h"] >= entry + snaps["entry_atr"]
        if res != super().adj_fire(adj, entry, snaps, bar):
            raise AssertionError("seed break-even trigger and artefact tree disagree")
        return res

    def adj_level(self, adj, entry, snaps):
        if entry != super().adj_level(adj, entry, snaps):
            raise AssertionError("seed break-even level disagrees")
        return entry


# ---------------------------------------------------------------- failures and explanations


class Fail(Exception):
    """A failure of one event. `facts` lists the strings an INSUFFICIENT detail must contain (OQ-02 section 2.5:
    report the instrument, event, missing evidence and affected period). They are derived from the case input only."""

    def __init__(self, status, code, session, phase, detail="", facts=None):
        Exception.__init__(self, "%s %s at %s %s %s" % (status, code, session, phase, detail))
        self.status, self.code, self.session, self.phase, self.detail = status, code, session, phase, detail
        self.facts = facts


class StopRun(Exception):
    pass


def describe_series_op(expr, named):
    op = op_name(expr)
    if op == "bar_field":
        return expr["params"]["field"].lower()
    if op == "ref":
        return describe_series_op(named[expr["params"]["name"]], named)
    return op


def explain_indicators(strat_eval, series, t, sess):
    """Step-by-step arithmetic for each top-level indicator at index t."""
    tr = strat_eval.tree
    lines = []
    closes = [b["c"] for b in series]
    for name in strat_eval.names:
        expr = tr.named[name]
        op = op_name(expr)
        p = expr["params"]
        val = tr.ev(series, expr, t, {})
        if op == "const":
            lines.append("%s = const %s" % (name, p["value"]))
        elif is_miss(val):
            lines.append("%s = missing (%s)" % (name, val.reason))
        elif op == "sma":
            w = p["window"]
            what = describe_series_op(expr["args"][0], tr.named)
            vals = [tr.ev(series, expr["args"][0], t - i, {}) for i in range(w)]
            lines.append("%s = mean of the last %d %s values (indices %d..%d): sum %s / %d = %s -> %s"
                         % (name, w, what, t - w + 1, t, fmt_dec(sum(vals, F(0))), w,
                            fmt_dec(val), diag(val)))
        elif op == "rsi_simple":
            w = p["window"]
            g = sum((max(closes[j] - closes[j - 1], F(0)) for j in range(t - w + 1, t + 1)), F(0))
            l = sum((max(closes[j - 1] - closes[j], F(0)) for j in range(t - w + 1, t + 1)), F(0))
            lines.append("%s: over the %d changes (indices %d..%d) gains sum %s, losses sum %s; "
                         "RSI = 100 * %s / (%s + %s) = %s -> %s"
                         % (name, w, t - w + 1, t, fmt_dec(g), fmt_dec(l), fmt_dec(g), fmt_dec(g),
                            fmt_dec(l), fmt_dec(val), diag(val)))
        elif op == "atr_simple":
            w = p["window"]
            trs = []
            for j in range(t - w + 1, t + 1):
                b, pc = series[j], series[j - 1]["c"]
                trs.append(max(b["h"] - b["l"], abs(b["h"] - pc), abs(b["l"] - pc)))
            lines.append("%s: true ranges (indices %d..%d) sum to %s; ATR = %s / %d = %s -> %s"
                         % (name, t - w + 1, t, fmt_dec(sum(trs, F(0))), fmt_dec(sum(trs, F(0))), w,
                            fmt_dec(val), diag(val)))
        elif op == "lag":
            lines.append("%s = %s evaluated %d session(s) earlier = %s -> %s"
                         % (name, describe_series_op(expr["args"][0], tr.named), p["periods"],
                            fmt_dec(val), diag(val)))
        else:
            lines.append("%s = %s" % (name, diag(val) if not isinstance(val, bool) else val))
    return lines


def fmt_dec(x):
    """Exact decimal if terminating, else a fraction string."""
    x = F(x)
    return fmt_exact(x) if terminates(x) else "%d/%d" % (x.numerator, x.denominator)


# ---------------------------------------------------------------- simulator (declared policy)


class Sim:
    """Daily long-only cash simulator for the declared policy of the S0 research log
    (docs/research-logs/2026-11-13-s0-offline-seed-evaluation.md): its policy table (costs, slippage, sizing,
    corporate actions), the information cutoff section and the Interpretations 6 to 11, 13, 14 and 16 (boundary
    equalities, dual touch, break-even timing, dividend entitlement, receivables, split conversion, INVALID_LEVEL,
    whole-event rollback, held through a halt). Interpretations 1 to 5 are the Tree evaluator's. Interpretation 12
    (28 significant digits) is not reproduced: every comparison here is exact. Interpretation 15 (a bar supplied
    for a confirmed halt) is a rejection before any event, declared as the expected outcome of I-09."""

    def __init__(self, inp, ev, focus=()):
        self.inp = inp
        self.ev = ev
        pol = inp["policy"]
        self.ps, self.qs, self.ms, self.ds = (pol["price_scale"], pol["quantity_scale"],
                                              pol["money_scale"], pol["diagnostic_scale"])
        self.lot = F(pol["lot_size"])
        cm = pol["cost_model"]
        self.fixed = F(cm["fixed_fee_per_fill"])
        self.bps = F(cm["fee_bps"])
        self.slip = F(cm["gap_exit_slippage_bps"])
        self.wh = F(pol["corporate_actions"]["withholding_bps"])
        inst = inp["instruments"][0]
        self.iid = inst["instrument_id"]
        self.bars = {}
        for b in inst["bars"]:
            self.bars[b["session"]] = {"o": F(b["open"]), "h": F(b["high"]), "l": F(b["low"]),
                                       "c": F(b["close"]), "v": F(b["volume"]), "avail": b["available_at"]}
        self.actions = inst["corporate_actions"]
        self.events = inst["unplanned_events"]
        w = inp["windows"]
        allsess = [c["session"] for c in inp["calendar"]["sessions"]]
        self.sess = [s for s in allsess if w["warmup_start"] <= s <= w["scored_end"]]
        self.scored_start = w["scored_start"]
        self.cutoff = w["information_cutoff"]
        self.slots = ev.strat["definition"]["selection"]["slots"]
        self.focus = set(focus)
        self.S = types.SimpleNamespace(
            avail=F(inp["initial_capital"]), reserved=F(0), recvs=[], positions=[], pending=None,
            applied=[], splits=[], seq=0, signals=[], entries=[], fills=[], trades=[], ledger=[],
            daily=[], actions=[], trace=[])
        self.outcome = {"status": "COMPLETED"}
        self.facts = None
        self.completed = True

    # ---- helpers
    def L(self, s, phase, text):
        self.S.trace.append((s, phase, text))

    def m(self, x):
        return fmt(x, self.ms)

    def p(self, x):
        return fmt(x, self.ps)

    def fee(self, notional):
        return ceil_to(self.fixed + notional * self.bps / 10000, self.ms)

    def recv_total(self):
        return sum((r["amount"] for r in self.S.recvs), F(0))

    def deadline(self, bound):
        """Latest instant at which evidence may be available: the earlier of the bound and the cutoff."""
        return self.cutoff if bound is None else min(bound, self.cutoff)

    def is_halted(self, s):
        return any(e["kind"] == "CONFIRMED_HALT" and e["effective_session"] == s
                   and e["available_at"] <= self.deadline(open_at(s)) for e in self.events)

    def halts_covering(self, s):
        """Event ids of every confirmed halt that covers session s (effective at s and known by its deadline)."""
        return [e["event_id"] for e in self.events if e["kind"] == "CONFIRMED_HALT" and e["effective_session"] == s
                and e["available_at"] <= self.deadline(open_at(s))]

    def led(self, s, phase, kind, amount):
        S = self.S
        S.ledger.append({"seq": S.seq, "session": s, "phase": phase, "kind": kind, "amount": amount,
                         "avail": S.avail, "reserved": S.reserved, "recv": self.recv_total()})
        S.seq += 1

    def causal_series(self, i):
        S = self.S
        t_sess = self.sess[i]
        out = []
        for j in range(i + 1):
            sj = self.sess[j]
            if sj not in self.bars:
                raise RuntimeError("oracle: series gap at %s is not supported" % sj)
            b = self.bars[sj]
            f = F(1)
            for eff, r in S.splits:
                if sj < eff <= t_sess:
                    f *= r
            out.append({"o": b["o"] / f, "h": b["h"] / f, "l": b["l"] / f, "c": b["c"] / f, "v": b["v"] * f})
        return out

    def pay_due(self, s, phase):
        S = self.S
        for r in list(S.recvs):
            if r["pay_session"] == s and r["pay_phase"] == phase:
                S.recvs.remove(r)
                S.avail += r["amount"]
                self.led(s, phase, "DIVIDEND_PAYMENT", r["amount"])
                self.L(s, phase, "Pay receivable of action %s: available += %s -> %s, receivables -> %s."
                       % (r["action_id"], self.m(r["amount"]), self.m(S.avail), self.m(self.recv_total())))

    def convert(self, value, unit, r):
        if unit == "PRICE":
            return value / r
        if unit == "SHARES":
            return value * r
        return value

    # ---- run
    def run(self):
        S = self.S
        phases = (("BEFORE_OPEN", self.before_open), ("OPEN", self.open_),
                  ("DURING_SESSION", self.during), ("AFTER_CLOSE", self.after_close))
        try:
            for i, s in enumerate(self.sess):
                for phase, fn in phases:
                    saved = copy.deepcopy(self.S)
                    try:
                        fn(i)
                    except Fail as f:
                        self.S = saved
                        self.outcome = {"status": f.status, "code": f.code,
                                        "at": {"session": f.session, "phase": f.phase}}
                        self.completed = False
                        self.facts = f.facts
                        self.L(f.session, f.phase, "FAILURE %s %s: %s Journal kept through the last completed event."
                               % (f.status, f.code, f.detail))
                        raise StopRun()
        except StopRun:
            pass
        return self

    # ---- BEFORE_OPEN
    def before_open(self, i):
        S = self.S
        s = self.sess[i]
        halted = self.is_halted(s)
        if not halted and s not in self.bars:
            raise Fail("INSUFFICIENT", "MISSING_REQUIRED_BAR", s, "BEFORE_OPEN",
                       "no bar for %s and no confirmed halt effective and available at %s." % (s, open_at(s)),
                       facts=[self.iid, s])
        ent_qty = sum((p["qty"] for p in S.positions), F(0))
        acts = [a for a in self.actions if a["effective_session"] == s and a["action_id"] not in S.applied]
        for a in acts:
            if a["available_at"] > self.deadline(open_at(s)):
                raise Fail("FAILED", "FUTURE_DATA", s, "BEFORE_OPEN",
                           "action %s becomes available at %s, after the deadline %s (the earlier of the session "
                           "open %s and the information cutoff %s)."
                           % (a["action_id"], a["available_at"], self.deadline(open_at(s)), open_at(s), self.cutoff))
            if a["kind"] not in ("SPLIT", "CASH_DIVIDEND"):
                raise Fail("INSUFFICIENT", "UNSUPPORTED_CORPORATE_ACTION", s, "BEFORE_OPEN",
                           "action %s has unsupported kind %s." % (a["action_id"], a["kind"]),
                           facts=[self.iid, a["action_id"], a["effective_session"]])
        for a in acts:
            if a["kind"] == "SPLIT":
                self.apply_split(s, a)
            else:
                self.apply_dividend(s, a, ent_qty)
            S.applied.append(a["action_id"])
            S.actions.append({"action_id": a["action_id"], "kind": a["kind"], "effective_session": s,
                              "applied_at": {"session": s, "phase": "BEFORE_OPEN"}})
        self.pay_due(s, "BEFORE_OPEN")
        for p in S.positions:
            if p["sched"] and p["sched"][1] == s:
                self.L(s, "BEFORE_OPEN", "Activate the scheduled stop of %s: stop %s -> %s (effective %s)."
                       % (p["trade_id"], fmt_dec(p["stop"]), fmt_dec(p["sched"][0]), s))
                p["stop"] = p["sched"][0]
                p["sched"] = None

    def apply_split(self, s, a):
        S = self.S
        r = F(a["ratio_new"], a["ratio_old"])
        for p in S.positions:
            nq = p["qty"] * r
            if nq.denominator != 1:
                raise Fail("INSUFFICIENT", "FRACTIONAL_ENTITLEMENT", s, "BEFORE_OPEN",
                           "split %s: quantity %s * %d / %d = %s is not a whole share."
                           % (a["action_id"], fmt_dec(p["qty"]), a["ratio_new"], a["ratio_old"], fmt_dec(nq)),
                           facts=[self.iid, a["action_id"], a["effective_session"]])
        self.L(s, "BEFORE_OPEN", "Split %s: ratio r = %d/%d = %s, applied exactly once."
               % (a["action_id"], a["ratio_new"], a["ratio_old"], fmt_dec(r)))
        for p in S.positions:
            old = (p["qty"], p["entry"], p["stop"], p["target"], dict(p["snaps"]), p["sched"])
            p["qty"] = old[0] * r
            p["entry"] = old[1] / r
            p["stop"] = old[2] / r
            p["target"] = old[3] / r
            for k in p["snaps"]:
                p["snaps"][k] = self.convert(old[4][k], self.ev.units[k], r)
            if p["sched"]:
                p["sched"] = (old[5][0] / r, old[5][1])
            for t in S.trades:
                if t["trade_id"] == p["trade_id"]:
                    t["qty"], t["entry"] = p["qty"], p["entry"]
            self.L(s, "BEFORE_OPEN",
                   "Position %s: quantity %s * %s = %s; entry %s / %s = %s; stop %s -> %s; target %s -> %s; "
                   "snapshots %s -> %s; scheduled stop %s -> %s."
                   % (p["trade_id"], fmt_dec(old[0]), fmt_dec(r), fmt_dec(p["qty"]), fmt_dec(old[1]), fmt_dec(r),
                      fmt_dec(p["entry"]), fmt_dec(old[2]), fmt_dec(p["stop"]), fmt_dec(old[3]),
                      fmt_dec(p["target"]),
                      ", ".join("%s=%s" % (k, fmt_dec(v)) for k, v in old[4].items()),
                      ", ".join("%s=%s" % (k, fmt_dec(v)) for k, v in p["snaps"].items()),
                      fmt_dec(old[5][0]) if old[5] else "none", fmt_dec(p["sched"][0]) if p["sched"] else "none"))
        if S.pending:
            pe = S.pending
            before = dict(pe["snaps"])
            for k in pe["snaps"]:
                pe["snaps"][k] = self.convert(before[k], self.ev.units[k], r)
            self.L(s, "BEFORE_OPEN", "Pending intent %s: snapshots %s -> %s; cap %s and rank unchanged."
                   % (pe["intent_id"], ", ".join("%s=%s" % (k, fmt_dec(v)) for k, v in before.items()),
                      ", ".join("%s=%s" % (k, fmt_dec(v)) for k, v in pe["snaps"].items()), self.m(pe["cap"])))
        S.splits.append((s, r))

    def apply_dividend(self, s, a, ent_qty):
        S = self.S
        amt = F(a["amount_per_share"])
        raw = ent_qty * amt * (1 - self.wh / 10000)
        rec = floor_to(raw, self.ms)
        self.L(s, "BEFORE_OPEN",
               "Dividend %s: entitled quantity (held at the start of BEFORE_OPEN, before any split) %s * %s per share "
               "* (1 - %s/10000) = %s; floor to money scale -> %s."
               % (a["action_id"], fmt_dec(ent_qty), fmt_dec(amt), fmt_dec(self.wh), fmt_dec(raw), self.m(rec)))
        if rec > 0:
            S.recvs.append({"action_id": a["action_id"], "amount": rec, "pay_session": a["payment_session"],
                            "pay_phase": a["payment_phase"]})
            self.led(s, "BEFORE_OPEN", "DIVIDEND_RECEIVABLE", rec)
            self.L(s, "BEFORE_OPEN", "Receivable %s due at %s %s; counts in equity, not in available cash."
                   % (self.m(rec), a["payment_session"], a["payment_phase"]))
        else:
            self.L(s, "BEFORE_OPEN", "No entitlement: no receivable and no ledger line.")

    # ---- fills
    def sell(self, s, phase, pos, price, reason, amb=False):
        S = self.S
        if price <= 0:
            raise Fail("FAILED", "INVALID_LEVEL", s, phase, "sale price must be positive")
        qty = pos["qty"]
        notional = qty * price
        fee = self.fee(notional)
        delta = notional - fee
        S.fills.append({"seq": S.seq, "session": s, "phase": phase, "side": "SELL", "qty": qty, "price": price,
                        "notional": notional, "fee": fee, "delta": delta, "reason": reason, "intent": None,
                        "amb": amb})
        S.seq += 1
        S.avail += delta
        self.led(s, phase, "FILL_SELL", delta)
        S.positions.remove(pos)
        for t in S.trades:
            if t["trade_id"] == pos["trade_id"]:
                t.update({"exit_session": s, "exit_price": price, "exit_reason": reason, "amb": amb})
        self.L(s, phase, "Sell %s at %s (%s): notional %s * %s = %s; fee = ceil(%s + %s * %s/10000) = %s; "
               "proceeds %s - %s = %s; available -> %s."
               % (fmt_dec(qty), self.p(price), reason, fmt_dec(qty), self.p(price), self.m(notional),
                  fmt_dec(self.fixed), self.m(notional), fmt_dec(self.bps), self.m(fee), self.m(notional),
                  self.m(fee), self.m(delta), self.m(S.avail)))

    # ---- OPEN
    def open_(self, i):
        S = self.S
        s = self.sess[i]
        self.pay_due(s, "OPEN")
        if self.is_halted(s):
            if S.pending:
                pe = S.pending
                self.release(s, "OPEN", pe)
                self.set_entry(pe["intent_id"], status="EXPIRED", reason="EXPIRED_NON_TRADING")
                self.L(s, "OPEN", "Confirmed halt: intent %s expires (EXPIRED_NON_TRADING); reservation %s released; "
                       "available -> %s." % (pe["intent_id"], self.m(pe["cap"]), self.m(S.avail)))
                S.pending = None
            return
        bar = self.bars[s]
        held = list(S.positions)
        for pos in held:
            if bar["o"] <= pos["stop"]:
                px = floor_to(bar["o"] * (1 - self.slip / 10000), self.ps)
                self.L(s, "OPEN", "Gap: open %s <= stop %s. Price = floor(%s * (1 - %s/10000)) = %s."
                       % (self.p(bar["o"]), fmt_dec(pos["stop"]), self.p(bar["o"]), fmt_dec(self.slip), self.p(px)))
                self.sell(s, "OPEN", pos, px, "GAP_STOP")
            elif bar["o"] >= pos["target"]:
                px = floor_to(pos["target"], self.ps)
                self.L(s, "OPEN", "Gap: open %s >= target %s. Fill at the target level %s, no slippage."
                       % (self.p(bar["o"]), fmt_dec(pos["target"]), self.p(px)))
                self.sell(s, "OPEN", pos, px, "GAP_TARGET")
        if S.pending:
            self.fill_entry(s, bar)

    def set_entry(self, intent_id, **kw):
        for e in self.S.entries:
            if e["intent_id"] == intent_id:
                e.update(kw)

    def release(self, s, phase, pe):
        S = self.S
        S.reserved -= pe["cap"]
        S.avail += pe["cap"]
        self.led(s, phase, "RELEASE", pe["cap"])

    def fill_entry(self, s, bar):
        S = self.S
        pe = S.pending
        cap, o = pe["cap"], bar["o"]
        unit = self.lot * o
        kmax = math.floor(cap / unit)
        q = F(0)
        trail = []
        for k in range(kmax, 0, -1):
            n = k * unit
            fee = self.fee(n)
            trail.append("q=%s: %s + fee %s = %s %s cap %s" % (fmt_dec(k * self.lot), self.m(n), self.m(fee),
                                                               self.m(n + fee), "<=" if n + fee <= cap else ">",
                                                               self.m(cap)))
            if n + fee <= cap:
                q = k * self.lot
                break
            if len(trail) >= 3:
                trail.append("...")
                # keep searching silently
                for kk in range(k - 1, 0, -1):
                    nn = kk * unit
                    if nn + self.fee(nn) <= cap:
                        q = kk * self.lot
                        break
                break
        self.L(s, "OPEN", "Size intent %s: cap %s, open %s, lot %s, fee(n) = ceil(%s + n * %s/10000). Largest "
               "lot multiple that fits: %s." % (pe["intent_id"], self.m(cap), self.p(o), fmt_dec(self.lot),
                                                fmt_dec(self.fixed), fmt_dec(self.bps), "; ".join(trail)))
        if q == 0:
            self.release(s, "OPEN", pe)
            self.set_entry(pe["intent_id"], status="SKIPPED", reason="CAP_BELOW_ONE_LOT")
            self.L(s, "OPEN", "Quantity 0: SKIPPED CAP_BELOW_ONE_LOT. Reservation %s released, no backfill; "
                   "available -> %s." % (self.m(cap), self.m(S.avail)))
            S.pending = None
            return
        stop, target = self.ev.levels(o, pe["snaps"])
        self.L(s, "OPEN", "Levels from the signal-session snapshots (%s): stop %s, target %s; need 0 < stop < entry "
               "%s < target."
               % (", ".join("%s=%s" % (k, fmt_dec(v)) for k, v in pe["snaps"].items()), fmt_dec(stop),
                  fmt_dec(target), self.p(o)))
        if not (0 < stop < o < target):
            raise Fail("FAILED", "INVALID_LEVEL", s, "OPEN",
                       "stop %s, entry %s, target %s violate 0 < stop < entry < target."
                       % (fmt_dec(stop), self.p(o), fmt_dec(target)))
        self.release(s, "OPEN", pe)
        notional = q * o
        fee = self.fee(notional)
        delta = -(notional + fee)
        S.fills.append({"seq": S.seq, "session": s, "phase": "OPEN", "side": "BUY", "qty": q, "price": o,
                        "notional": notional, "fee": fee, "delta": delta, "reason": "ENTRY",
                        "intent": pe["intent_id"], "amb": False})
        S.seq += 1
        S.avail += delta
        self.led(s, "OPEN", "FILL_BUY", -delta)
        tid = "T-%s-%s" % (s, self.iid)
        S.positions.append({"trade_id": tid, "qty": q, "entry": o, "stop": stop, "target": target,
                            "snaps": dict(pe["snaps"]), "fired": [], "sched": None, "entry_session": s})
        S.trades.append({"trade_id": tid, "entry_session": s, "qty": q, "entry": o, "exit_session": None,
                         "exit_price": None, "exit_reason": None, "amb": False})
        self.set_entry(pe["intent_id"], status="FILLED", qty=q, fill_price=o, fee=fee)
        self.L(s, "OPEN", "Release cap %s (available %s), buy %s at %s: notional %s, fee %s, debit %s; available -> %s."
               % (self.m(cap), self.m(S.avail - delta), fmt_dec(q), self.p(o), self.m(notional), self.m(fee),
                  self.m(-delta), self.m(S.avail)))
        S.pending = None

    # ---- DURING_SESSION
    def during(self, i):
        S = self.S
        s = self.sess[i]
        self.pay_due(s, "DURING_SESSION")
        if self.is_halted(s):
            return
        bar = self.bars[s]
        for pos in list(S.positions):
            st = bar["l"] <= pos["stop"]
            tg = bar["h"] >= pos["target"]
            self.L(s, "DURING_SESSION", "Touch test for %s: low %s %s stop %s -> %s; high %s %s target %s -> %s."
                   % (pos["trade_id"], self.p(bar["l"]), "<=" if st else ">", fmt_dec(pos["stop"]), st,
                      self.p(bar["h"]), ">=" if tg else "<", fmt_dec(pos["target"]), tg))
            if st:
                if tg:
                    self.L(s, "DURING_SESSION", "Both touched: the stop takes precedence; ambiguous_bar recorded.")
                self.sell(s, "DURING_SESSION", pos, floor_to(pos["stop"], self.ps), "STOP", amb=tg)
            elif tg:
                self.sell(s, "DURING_SESSION", pos, floor_to(pos["target"], self.ps), "TARGET")

    # ---- AFTER_CLOSE
    def pos_view(self, p):
        return {"trade_id": p["trade_id"], "qty": p["qty"], "entry": p["entry"], "stop": p["stop"],
                "target": p["target"], "snaps": list(p["snaps"].items()), "sched": p["sched"]}

    def record_daily(self, s, bar):
        S = self.S
        posval = F(0)
        if bar is not None:
            posval = sum((p["qty"] * bar["c"] for p in S.positions), F(0))
        rv = self.recv_total()
        equity = S.avail + S.reserved + rv + posval
        S.daily.append({"session": s, "avail": S.avail, "reserved": S.reserved, "recv": rv, "posval": posval,
                        "equity": equity, "positions": [self.pos_view(p) for p in S.positions]})
        self.L(s, "AFTER_CLOSE", "Daily record: equity = available %s + reserved %s + receivables %s + positions "
               "%s = %s." % (self.m(S.avail), self.m(S.reserved), self.m(rv), self.m(posval), self.m(equity)))

    def after_close(self, i):
        S = self.S
        s = self.sess[i]
        self.pay_due(s, "AFTER_CLOSE")
        if self.is_halted(s):
            if S.positions:
                raise Fail("INSUFFICIENT", "UNSUPPORTED_VALUATION", s, "AFTER_CLOSE",
                           "confirmed halt on %s while holding %s: no close to value the position, no "
                           "liquidation price is invented." % (s, S.positions[0]["trade_id"]),
                           facts=[self.iid] + self.halts_covering(s) + [s, self.inp["windows"]["scored_end"]])
            self.L(s, "AFTER_CLOSE", "Confirmed halt, nothing held: no signal can be created.")
            self.record_daily(s, None)
            return
        bar = self.bars[s]
        nxt = self.sess[i + 1] if i + 1 < len(self.sess) else None
        dl = self.deadline(open_at(nxt) if nxt is not None else None)
        if bar["avail"] > dl:
            raise Fail("FAILED", "FUTURE_DATA", s, "AFTER_CLOSE",
                       "the bar of %s is available at %s, after the deadline %s (the earlier of the next open and "
                       "the information cutoff %s; the final session has only the cutoff)."
                       % (s, bar["avail"], dl, self.cutoff))
        # stop adjustments on the raw bar of this session (log Interpretations 6 and 8)
        for pos in S.positions:
            for adj in self.ev.adjustments:
                if adj["id"] in pos["fired"]:
                    continue
                trig = self.ev.adj_fire(adj, pos["entry"], pos["snaps"], bar)
                self.L(s, "AFTER_CLOSE", "Stop adjustment %s for %s: trigger (raw high %s vs entry %s + snapshot) = %s."
                       % (adj["id"], pos["trade_id"], self.p(bar["h"]), fmt_dec(pos["entry"]), trig))
                if trig:
                    pos["fired"].append(adj["id"])
                    lvl = self.ev.adj_level(adj, pos["entry"], pos["snaps"])
                    if nxt is not None:
                        pos["sched"] = (lvl, nxt)
                        self.L(s, "AFTER_CLOSE", "Fired once: new stop level %s scheduled, effective %s before the "
                               "open; the current stop %s stays active until then." % (fmt_dec(lvl), nxt,
                                                                                         fmt_dec(pos["stop"])))
        # signal
        series = self.causal_series(i)
        sig = self.ev.signal(series, i)
        cond = sig["cond"]
        cstr = "MISSING" if is_miss(cond) else ("TRUE" if cond else "FALSE")
        rec = {"session": s, "ind": sig["ind"], "cond": cstr, "rank": None, "decision": None, "skip": None}
        scored = s >= self.scored_start
        explain = s in self.focus or cond is True
        if explain:
            for line in explain_indicators(self.ev, series, i, s):
                self.L(s, "AFTER_CLOSE", "Indicator " + line)
            if self.ev.seed_mode:
                self.L(s, "AFTER_CLOSE", self.seed_clauses(series, i))
        entry_rec = None
        if not scored:
            rec["decision"], rec["skip"] = "SKIPPED", "NOT_SCORED_YET"
        elif nxt is None:
            rec["decision"], rec["skip"] = "SKIPPED", "NO_NEXT_SESSION"
        elif is_miss(cond):
            rec["decision"], rec["skip"] = "SKIPPED", "INDICATOR_UNAVAILABLE"
        elif cond is False:
            rec["decision"] = "NO_ENTRY"
        else:
            held = len(S.positions)
            vacant = self.slots - held - (1 if S.pending else 0)
            if held >= 1:
                rec["decision"], rec["skip"] = "SKIPPED", "HELD"
            elif vacant <= 0:
                rec["decision"], rec["skip"] = "SKIPPED", "NO_VACANT_SLOT"
            elif is_miss(sig["rank"]) or any(is_miss(v) for v in sig["snaps"].values()):
                rec["decision"], rec["skip"] = "SKIPPED", "INDICATOR_UNAVAILABLE"
            else:
                cap = floor_to(S.avail / vacant, self.ms)
                self.L(s, "AFTER_CLOSE", "Decision: condition TRUE, not held, vacant slots %d - %d - %d = %d. "
                       "cap = floor(available %s / %d) = %s."
                       % (self.slots, held, 1 if S.pending else 0, vacant, self.m(S.avail), vacant, self.m(cap)))
                if cap <= 0:
                    rec["decision"], rec["skip"] = "SKIPPED", "CAP_BELOW_ONE_LOT"
                else:
                    rec["decision"], rec["rank"] = "ENTER", sig["rank"]
                    S.avail -= cap
                    S.reserved += cap
                    self.led(s, "AFTER_CLOSE", "RESERVE", cap)
                    iid = "I-%s-%s" % (s, self.iid)
                    S.pending = {"intent_id": iid, "signal_session": s, "rank": sig["rank"], "cap": cap,
                                 "snaps": dict(sig["snaps"])}
                    S.entries.append({"intent_id": iid, "signal_session": s, "rank": sig["rank"], "cap": cap,
                                      "status": "RESERVED", "reason": None, "qty": None, "fill_price": None,
                                      "fee": None})
                    self.L(s, "AFTER_CLOSE", "Reserve %s: available -> %s, reserved -> %s; rank %s; snapshots %s."
                           % (self.m(cap), self.m(S.avail), self.m(S.reserved), diag(sig["rank"], self.ds),
                              ", ".join("%s=%s" % (k, fmt_dec(v)) for k, v in sig["snaps"].items())))
        if rec["decision"] == "ENTER":
            pass
        self.L(s, "AFTER_CLOSE", "Signal: condition %s, decision %s%s." % (
            cstr, rec["decision"], (" (" + rec["skip"] + ")") if rec["skip"] else ""))
        S.signals.append(rec)
        self.record_daily(s, bar)

    def seed_clauses(self, series, t):
        ev = self.ev
        ind = dict(ev.seed_values(series, t))
        b = series[t]
        if any(is_miss(ind[k]) for k in ("sma50", "rsi_lag2", "rsi_lag1", "rsi14", "vol_sma20", "atr14")):
            return "Seed clauses: at least one referenced indicator is missing, so the condition is MISSING."

        def d(x):
            return diag(x, 4)

        parts = [
            "close %s > sma50 %s: %s" % (fmt_dec(b["c"]), d(ind["sma50"]), b["c"] > ind["sma50"]),
            "rsi_lag2 %s <= %s or rsi_lag1 %s <= %s: %s" % (d(ind["rsi_lag2"]), fmt_dec(ev.thr), d(ind["rsi_lag1"]),
                                                          fmt_dec(ev.thr),
                                                          ind["rsi_lag2"] <= ev.thr or ind["rsi_lag1"] <= ev.thr),
            "rsi14 %s > 30: %s" % (d(ind["rsi14"]), ind["rsi14"] > 30),
            "volume %s > vol_sma20 %s: %s" % (fmt_dec(b["v"]), d(ind["vol_sma20"]), b["v"] > ind["vol_sma20"]),
            "atr14 %s > 0: %s" % (d(ind["atr14"]), ind["atr14"] > 0),
            "vol_sma20 %s > 0: %s" % (d(ind["vol_sma20"]), ind["vol_sma20"] > 0),
        ]
        txt = "Seed clauses (OQ-02 2.6): " + "; ".join(parts) + "."
        if ind["vol_sma20"] > 0:
            rk = 50 * (b["v"] / ind["vol_sma20"]) + (100 - ind["rsi14"])
            txt += " Rank = 50 * (%s / %s) + (100 - %s) = %s." % (fmt_dec(b["v"]), fmt_dec(ind["vol_sma20"]),
                                                                  fmt_dec(ind["rsi14"]), fmt_dec(rk))
        return txt

    def finish(self):
        """Close the run: open trades stay OPEN_AT_END (no forced liquidation; the log does not number this)."""
        S = self.S
        if self.completed:
            for t in S.trades:
                if t["exit_reason"] is None:
                    t["exit_reason"] = "OPEN_AT_END"
            self.L(self.sess[-1], "AFTER_CLOSE", "End of run: no forced liquidation; %d open trade(s) valued at the "
                   "last close." % len([t for t in S.trades if t["exit_reason"] == "OPEN_AT_END"]))
        return self

    # ---- export
    def export(self, signal_sessions=None, sections=None, omit=()):
        """Build the expect object. sections: which journal sections to include."""
        S = self.S
        ms, ps, qs = self.ms, self.ps, self.qs
        all_sections = ("signals", "entries", "fills", "trades", "cash_ledger", "daily", "corporate_actions", "final")
        if sections is None:
            sections = all_sections
        out = {"outcome": self.outcome}
        if self.outcome["status"] == "INSUFFICIENT":
            assert self.facts, "an INSUFFICIENT outcome needs derived detail facts"
            out["outcome_detail_includes"] = list(self.facts)
        if "signals" in sections:
            sel = None if signal_sessions is None else set(signal_sessions)
            sigs = []
            for r in S.signals:
                if sel is not None and r["session"] not in sel:
                    continue
                o = {"session": r["session"], "condition": r["cond"], "decision": r["decision"]}
                if r["skip"]:
                    o["skip_reason"] = r["skip"]
                if r["rank"] is not None:
                    o["rank"] = diag(r["rank"], self.ds)
                inds = []
                for n, v in r["ind"]:
                    if is_miss(v):
                        inds.append({"name": n, "missing_reason": v.reason})
                    else:
                        inds.append({"name": n, "value": diag(v, self.ds)})
                o["indicators"] = inds
                sigs.append(o)
            if sel is not None:
                missing = sel - set(r["session"] for r in sigs)
                if missing:
                    raise AssertionError("signal sessions not produced: %s" % sorted(missing))
            out["signals"] = sigs
        if "entries" in sections:
            es = []
            for e in S.entries:
                o = {"intent_id": e["intent_id"], "signal_session": e["signal_session"]}
                if e["rank"] is not None and terminates(e["rank"]):
                    o["rank"] = fmt_exact(e["rank"])
                o["cap"] = fmt(e["cap"], ms)
                o["status"] = e["status"]
                if e["reason"]:
                    o["reason"] = e["reason"]
                if e["qty"] is not None:
                    o["quantity"] = fmt(e["qty"], qs)
                    o["fill_price"] = fmt(e["fill_price"], ps)
                    o["fee"] = fmt(e["fee"], ms)
                es.append(o)
            out["entries"] = es
        if "fills" in sections:
            fs = []
            for f in S.fills:
                o = {"seq": f["seq"], "session": f["session"], "phase": f["phase"], "side": f["side"],
                     "quantity": fmt(f["qty"], qs), "price": fmt(f["price"], ps), "notional": fmt(f["notional"], ms),
                     "fee": fmt(f["fee"], ms), "cash_delta": fmt(f["delta"], ms), "reason": f["reason"]}
                if f["intent"]:
                    o["intent_id"] = f["intent"]
                if f["amb"]:
                    o["ambiguous_bar"] = True
                fs.append(o)
            out["fills"] = fs
        if "trades" in sections:
            ts = []
            for t in S.trades:
                o = {"trade_id": t["trade_id"], "entry_session": t["entry_session"]}
                if t["exit_session"]:
                    o["exit_session"] = t["exit_session"]
                o["quantity"] = fmt(t["qty"], qs)
                o["entry_price"] = fmt(t["entry"], ps)
                if t["exit_price"] is not None:
                    o["exit_price"] = fmt(t["exit_price"], ps)
                o["exit_reason"] = t["exit_reason"]
                o["ambiguous_bar"] = bool(t["amb"])
                ts.append(o)
            out["trades"] = ts
        if "cash_ledger" in sections:
            out["cash_ledger"] = [{"seq": r["seq"], "session": r["session"], "phase": r["phase"], "kind": r["kind"],
                                   "amount": fmt(r["amount"], ms), "available_after": fmt(r["avail"], ms),
                                   "reserved_after": fmt(r["reserved"], ms),
                                   "receivables_after": fmt(r["recv"], ms)} for r in S.ledger]
        if "daily" in sections:
            out["daily"] = [{"session": d["session"], "cash_available": fmt(d["avail"], ms),
                             "cash_reserved": fmt(d["reserved"], ms), "receivables": fmt(d["recv"], ms),
                             "positions_value": fmt(d["posval"], ms), "equity": fmt(d["equity"], ms),
                             "positions": [self.pos_json(p) for p in d["positions"]]} for d in S.daily]
        if "corporate_actions" in sections:
            out["corporate_actions"] = [dict(a) for a in S.actions]
        if "final" in sections:
            last = S.daily[-1]
            out["final"] = {"cash_available": fmt(last["avail"], ms), "cash_reserved": fmt(last["reserved"], ms),
                            "receivables": fmt(last["recv"], ms), "positions_value": fmt(last["posval"], ms),
                            "equity": fmt(last["equity"], ms),
                            "open_positions": [self.pos_json(p) for p in last["positions"]]}
        for k in omit:
            out.pop(k, None)
        return out

    def pos_json(self, p):
        """An entry price, level or snapshot with no finite decimal form (for example 367/6, or an entry price of 5
        after a 3-for-1 split) is left out: the wire view carries a rounded decimal there and the oracle does not copy
        the engine's rounding. The fill that uses it is stated."""
        o = {"trade_id": p["trade_id"], "quantity": fmt(p["qty"], self.qs)}
        if terminates(p["entry"]):
            o["entry_price"] = fmt_exact(p["entry"])
        for key in ("stop", "target"):
            if terminates(p[key]):
                o[key] = fmt_exact(p[key])
        o["snapshots"] = [dict([("name", k)] + ([("value", fmt_exact(v))] if terminates(v) else []))
                          for k, v in p["snaps"]]
        if p["sched"]:
            o["scheduled_stop"] = {"level": fmt_exact(p["sched"][0]), "effective_session": p["sched"][1]}
        return o


# ---------------------------------------------------------------- builders: strategies


def ex(op, args=None, **params):
    return {"op": "operator:%s@1" % op, "args": list(args or []), "params": params}


def bf(field):
    return ex("bar_field", field=field)


def cst(value, unit):
    return ex("const", value=str(value), unit=unit)


def ref(name):
    return ex("ref", name=name)


def reduced_strategy(sid, version=1, sma_w=3, atr_w=3, stop_mult=2, target_mult=5, break_even=False,
                     hypothesis="Reduced fixture strategy: enter when the close is above its short mean.",
                     be_mult=None, condition=None):
    """be_mult scales the entry ATR in the break-even trigger (default: the seed's 1 x ATR). condition replaces the
    entry condition (default: close > mean). Both defaults reproduce the earlier cases byte for byte."""
    sma = "sma%d" % sma_w
    atr = "atr%d" % atr_w
    adjustments = []
    if break_even:
        trigger_leg = ex("snapshot", name="entry_atr")
        if be_mult is not None:
            trigger_leg = ex("mul", [cst(be_mult, "RATIO"), trigger_leg])
        adjustments = [{
            "id": "break_even",
            "trigger": ex("gte", [bf("HIGH"), ex("add", [ex("entry_price"), trigger_leg])]),
            "new_level": ex("entry_price"),
            "effective": "NEXT_SESSION"}]
    return {
        "schema_version": "strategy-artefact/1",
        "strategy_id": sid,
        "version": version,
        "operator_set": "daily-long-only-seed@1",
        "contract": {
            "hypothesis": hypothesis,
            "rationale": "Reduced strategy through the same validator and evaluator, so execution, cash and "
                         "corporate-action arithmetic can be derived by hand.",
            "intended_conditions": ["Synthetic sessions of one instrument."],
            "benchmarks": ["None."],
            "assumptions": ["Costs, scales and lots come from the evaluation policy."],
            "invalidation": ["Not a trading hypothesis."]},
        "definition": {
            "indicators": [
                {"name": sma, "expr": ex("sma", [bf("CLOSE")], window=sma_w)},
                {"name": atr, "expr": ex("atr_simple", window=atr_w)}],
            "entry": {
                "condition": ex("gt", [bf("CLOSE"), ref(sma)]) if condition is None else condition,
                "rank": cst(1, "POINTS"),
                "snapshots": [{"name": "entry_atr", "expr": ref(atr)}]},
            "selection": {"slots": 5, "max_per_instrument": 1, "tie_break": "ASCENDING_INSTRUMENT_ID"},
            "sizing": {"method": "sizing:equal_cash_per_vacant_slot@1"},
            "exits": {
                "stop": ex("sub", [ex("entry_price"),
                                   ex("mul", [cst(stop_mult, "RATIO"), ex("snapshot", name="entry_atr")])]),
                "target": ex("add", [ex("entry_price"),
                                     ex("mul", [cst(target_mult, "RATIO"), ex("snapshot", name="entry_atr")])]),
                "stop_adjustments": adjustments},
            "execution": {"entry_fill": "NEXT_OPEN", "decision": "AFTER_CLOSE"}}}


def load_seed(filename):
    with open(os.path.join(STRATS, filename), "r", encoding="utf-8") as fh:
        return json.load(fh)


SEEDS = {
    "v1": "seed-1-rsi30-breakeven-off.json",
    "v2": "seed-2-rsi32-breakeven-off.json",
    "v3": "seed-3-rsi30-breakeven-on.json",
    "v4": "seed-4-rsi32-breakeven-on.json",
    "v5": "seed-5-rsi40-breakeven-off-data-only.json",
}

# ---------------------------------------------------------------- builders: bars and inputs


def fr(x):
    """Exact rational from an int, a decimal string or a float literal (via its shortest repr)."""
    return F(repr(x)) if isinstance(x, float) else F(x)


def bar(s, o, h, l, c, v=1000, avail=None):
    return {"session": s, "o": fr(o), "h": fr(h), "l": fr(l), "c": fr(c), "v": fr(v),
            "avail": avail or close_at(s)}


def bar_json(b):
    return {"session": b["session"], "open": fmt_exact(b["o"]), "high": fmt_exact(b["h"]),
            "low": fmt_exact(b["l"]), "close": fmt_exact(b["c"]), "volume": fmt_exact(b["v"]),
            "event_time": close_at(b["session"]), "available_at": b["avail"]}


def flat(s, p, rng=2, v=1000):
    """A bar opening and closing at p with a symmetric range."""
    half = F(rng) / 2
    return bar(s, p, F(p) + half, F(p) - half, p, v)


def bars_from_closes(sessions, closes, rng=F(2), vols=None, rngs=None):
    """Bars whose open is the previous close and whose true range is exactly rng.

    The range of every bar is split around the open-close body so that high - low = rng, which keeps
    |high - previous close| and |low - previous close| below rng. Requires |close - open| <= rng.
    """
    out = []
    for j, (s, c) in enumerate(zip(sessions, closes)):
        c = F(c)
        o = c if j == 0 else F(closes[j - 1])
        r = F(rngs[j]) if rngs else F(rng)
        d = abs(c - o)
        if d > r:
            raise ValueError("move %s exceeds range %s at %s" % (d, r, s))
        cents_free = r - d
        a = F(math.floor(cents_free * 100 / 2), 100)
        b = cents_free - a
        out.append(bar(s, o, max(o, c) + a, min(o, c) - b, c, vols[j] if vols else 1000))
    return out


DEFAULT_POLICY = {
    "id": "daily-long-only-cash@1", "currency": "USD", "price_scale": 2, "quantity_scale": 0,
    "money_scale": 2, "diagnostic_scale": 4, "lot_size": "1",
    "cost_model": {"id": "fixed_plus_bps@1", "fixed_fee_per_fill": "1.00", "fee_bps": "0",
                   "gap_exit_slippage_bps": "0"},
    "corporate_actions": {"id": "split_cash_dividend_ex_date@1", "fractional": "INSUFFICIENT",
                          "withholding_bps": "0"}}


def make_policy(lot=None, fixed=None, bps=None, slip=None, wh=None, price_scale=None, money_scale=None):
    pol = copy.deepcopy(DEFAULT_POLICY)
    if lot is not None:
        pol["lot_size"] = str(lot)
    if fixed is not None:
        pol["cost_model"]["fixed_fee_per_fill"] = str(fixed)
    if bps is not None:
        pol["cost_model"]["fee_bps"] = str(bps)
    if slip is not None:
        pol["cost_model"]["gap_exit_slippage_bps"] = str(slip)
    if wh is not None:
        pol["corporate_actions"]["withholding_bps"] = str(wh)
    if price_scale is not None:
        pol["price_scale"] = price_scale
    if money_scale is not None:
        pol["money_scale"] = money_scale
    return pol


def split_action(aid, eff, new, old, avail=None):
    return {"kind": "SPLIT", "action_id": aid, "effective_session": eff,
            "available_at": avail or (eff + "T06:00:00Z"), "ratio_new": new, "ratio_old": old}


def dividend_action(aid, eff, amount, pay_session, pay_phase, avail=None):
    return {"kind": "CASH_DIVIDEND", "action_id": aid, "effective_session": eff,
            "available_at": avail or (eff + "T06:00:00Z"), "amount_per_share": str(amount),
            "payment_session": pay_session, "payment_phase": pay_phase}


def special_action(aid, eff, kind="SPECIAL_DISTRIBUTION", avail=None):
    return {"kind": kind, "action_id": aid, "effective_session": eff,
            "available_at": avail or (eff + "T06:00:00Z")}


def halt_event(eid, eff, avail=None):
    return {"event_id": eid, "kind": "CONFIRMED_HALT", "effective_session": eff,
            "available_at": avail or (eff + "T13:30:00Z")}


def default_cutoff(sessions):
    """The day after the last session at 00:00:00Z: later than every default bar availability."""
    return (date.fromisoformat(sessions[-1]) + timedelta(days=1)).isoformat() + "T00:00:00Z"


def make_input(strategy_hash, bars, sessions, scored_start, capital, policy=None, actions=(), events=(),
               dataset="s0-bars", warmup_start=None, scored_end=None, instrument="SYN", cutoff=None):
    return {
        "schema_version": "evaluation-input/1",
        "strategy_hash": strategy_hash,
        "operator_set": "daily-long-only-seed@1",
        "seed": 0,
        "dataset": {"id": dataset, "version": "1", "source": "SYNTHETIC",
                    "licence": "Apache-2.0, generated for this repository"},
        "instruments": [{"instrument_id": instrument, "bars": [bar_json(b) for b in bars],
                         "corporate_actions": list(actions), "unplanned_events": list(events)}],
        "calendar": {"sessions": calendar_entries(sessions)},
        "windows": {"warmup_start": warmup_start or sessions[0], "scored_start": scored_start,
                    "scored_end": scored_end or sessions[-1],
                    "information_cutoff": cutoff or default_cutoff(sessions)},
        "initial_capital": str(capital),
        "policy": policy or copy.deepcopy(DEFAULT_POLICY)}


def check_input(inp):
    """Sanity checks so that every case that should run is a valid, well-formed input."""
    pol = inp["policy"]
    ps = pol["price_scale"]
    sess = [c["session"] for c in inp["calendar"]["sessions"]]
    assert sess == sorted(set(sess)), "calendar must be strictly ascending"
    for b in inp["instruments"][0]["bars"]:
        assert b["session"] in sess, "bar outside the calendar: " + b["session"]
        for k in ("open", "high", "low", "close"):
            assert (F(b[k]) * 10 ** ps).denominator == 1, "price scale exceeded: %s" % b
        assert F(b["high"]) >= max(F(b["open"]), F(b["close"]), F(b["low"])), "high below body: %s" % b
        assert F(b["low"]) <= min(F(b["open"]), F(b["close"])), "low above body: %s" % b
        assert F(b["low"]) > 0 and F(b["volume"]) >= 0
        assert b["event_time"] == close_at(b["session"])
    assert pol["money_scale"] >= ps + pol["quantity_scale"]


# ---------------------------------------------------------------- cases and emission

ORACLE_PATH = os.path.abspath(__file__) if "__file__" in globals() else ""
CASE_LIST = []
MANIFEST_ADDITIONS = []
ROWS = ["Definition execution", "Shared payloads", "Seed semantics", "Entry variants",
        "Unplanned non-trading events", "Split across an ex-date", "Cash dividend", "Entry and exit phases",
        "Cash and quantities", "Invalid inputs", "Local replay"]


class Case:
    def __init__(self, cid, title, covers, strategy, inp, strategy_ref="strategy.json", kind="run", notes="",
                 hand=None, hand_text="", focus=(), signal_sessions=None, sections=None, omit=(), restore=True,
                 expect_outcome=None, strat_cls=None, policy_text="", manifest=None):
        self.id, self.title, self.covers = cid, title, covers
        self.strategy, self.inp, self.strategy_ref = strategy, inp, strategy_ref
        self.kind, self.notes, self.hand, self.hand_text = kind, notes, hand or {}, hand_text
        self.focus, self.signal_sessions, self.sections, self.omit = focus, signal_sessions, sections, omit
        self.restore = restore
        self.expect_outcome = expect_outcome
        self.strat_cls = strat_cls
        self.policy_text = policy_text
        self.manifest = manifest or []
        self.sim = None
        for r in covers:
            assert r in ROWS, "unknown row " + r
        CASE_LIST.append(self)


def get_path(obj, path):
    cur = obj
    for part in path.split("."):
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
    return cur


def table(bars):
    lines = ["| Session | Open | High | Low | Close | Volume |", "| --- | --- | --- | --- | --- | --- |"]
    for b in bars:
        lines.append("| %s | %s | %s | %s | %s | %s |" % (b["session"], fmt_exact(b["o"]), fmt_exact(b["h"]),
                                                          fmt_exact(b["l"]), fmt_exact(b["c"]), fmt_exact(b["v"])))
    return "\n".join(lines)


def policy_line(pol):
    cm = pol["cost_model"]
    return ("price scale %d, quantity scale %d, money scale %d, diagnostic scale %d, lot size %s; fixed fee %s per "
            "fill, %s bps, gap-exit slippage %s bps; dividend withholding %s bps."
            % (pol["price_scale"], pol["quantity_scale"], pol["money_scale"], pol["diagnostic_scale"],
               pol["lot_size"], cm["fixed_fee_per_fill"], cm["fee_bps"], cm["gap_exit_slippage_bps"],
               pol["corporate_actions"]["withholding_bps"]))


DETAIL_FACTS = {
    "MISSING_REQUIRED_BAR": "the session date that has no bar",
    "UNSUPPORTED_VALUATION": "the event id of every confirmed halt covering the failing session, the failing session "
                             "date and `windows.scored_end` (the end of the period that cannot be valued)",
    "UNSUPPORTED_CORPORATE_ACTION": "the id of the unsupported action and its effective session date",
    "FRACTIONAL_ENTITLEMENT": "the id of the split and its effective session date",
}


def render_derivation(c, expect):
    inp = c.inp
    inst = inp["instruments"][0]
    bars = [{"session": b["session"], "o": F(b["open"]), "h": F(b["high"]), "l": F(b["low"]), "c": F(b["close"]),
             "v": F(b["volume"])} for b in inst["bars"]]
    out = []
    out.append("# %s: %s\n" % (c.id, c.title))
    hc = "hand-checked (see the last section)" if c.hand_text else "not individually hand-checked"
    out.append("Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared "
               "policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. "
               "Status: %s. Covers: %s.\n" % (hc, ", ".join(c.covers)))
    out.append("## Design\n")
    out.append(c.notes.strip() + "\n")
    out.append("## Inputs\n")
    out.append("- Strategy: `%s` (strategy hash `%s`)." % (c.strategy_ref, sha(c.strategy)))
    out.append("- Input hash binding in `input.json`: `%s`." % inp["strategy_hash"])
    out.append("- Policy: %s" % policy_line(inp["policy"]))
    w = inp["windows"]
    out.append("- Windows: warm-up from %s, scored from %s, run ends after %s; %d calendar sessions, %d bars; "
               "initial capital %s." % (w["warmup_start"], w["scored_start"], w["scored_end"],
                                         len(inp["calendar"]["sessions"]), len(bars), inp["initial_capital"]))
    for a in inst["corporate_actions"]:
        out.append("- Corporate action: `%s`." % json.dumps(a, sort_keys=True))
    for e in inst["unplanned_events"]:
        out.append("- Unplanned event: `%s`." % json.dumps(e, sort_keys=True))
    if c.policy_text:
        out.append("- Note on the policy: " + c.policy_text)
    out.append("")
    if len(bars) <= 26:
        out.append(table(bars))
        out.append("")
    else:
        out.append("Closes by session index (index: close): " +
                   ", ".join("%d: %s" % (j, fmt_exact(b["c"])) for j, b in enumerate(bars)) + ".\n")
        out.append("Volumes by session index: " +
                   ", ".join("%d: %s" % (j, fmt_exact(b["v"])) for j, b in enumerate(bars)) + ".\n")
        out.append("Session index to date: index 0 is %s, index %d is %s.\n"
                   % (bars[0]["session"], len(bars) - 1, bars[-1]["session"]))
    if c.sim is not None:
        out.append("## Step-by-step derivation\n")
        long_case = len(bars) > 26
        groups = []
        for s, ph, t in c.sim.S.trace:
            if groups and groups[-1][0] == s:
                groups[-1][1].append((ph, t))
            else:
                groups.append((s, [(ph, t)]))
        focus = set(c.focus)
        for s, lines in groups:
            routine = all(t.startswith("Signal:") or t.startswith("Daily record:") for _, t in lines)
            if long_case and routine and s not in focus:
                continue
            out.append("### %s\n" % s)
            for ph, t in lines:
                out.append("- %s: %s" % (ph, t))
            out.append("")
        n = len(c.sim.S.fills) + len(c.sim.S.ledger)
        if n:
            seqs = sorted([(f["seq"], "%s fill" % f["side"]) for f in c.sim.S.fills] +
                          [(r["seq"], r["kind"]) for r in c.sim.S.ledger])
            out.append("### Journal sequence numbers\n")
            out.append("Fills and ledger lines share one counter: " +
                       ", ".join("%d %s" % (q, k) for q, k in seqs) + ".\n")
        o = c.sim.outcome
        out.append("### Outcome\n")
        if o["status"] == "COMPLETED":
            out.append("The run completes. Open trades stay OPEN_AT_END and are valued at the last close.\n")
        else:
            out.append("The run stops with status %s, code %s at %s %s. The expected journal is the journal through "
                       "the last completed event.\n" % (o["status"], o["code"], o["at"]["session"], o["at"]["phase"]))
            if "outcome_detail_includes" in expect:
                out.append("### Detail expectation\n")
                out.append("OQ-02 section 2.5 requires an INSUFFICIENT result to report the instrument, the event, the "
                           "missing evidence and the affected period. `outcome.detail` must contain each of these "
                           "strings (`expect.outcome_detail_includes`): %s. They come from the case input only: the "
                           "instrument id, %s. The expectation fixes the facts the text must name, not its wording.\n"
                           % (", ".join("`%s`" % x for x in expect["outcome_detail_includes"]),
                              DETAIL_FACTS[o["code"]]))
    else:
        out.append("## Expected result\n")
        out.append("Rejected before evaluation: status %s, code %s. No journal is produced.\n"
                   % (c.expect_outcome["status"], c.expect_outcome["code"]))
    if c.hand_text:
        out.append("## Hand check\n")
        out.append(c.hand_text.strip() + "\n")
        if c.hand:
            out.append("The oracle asserts these hand-derived values against its own output (a disagreement stops "
                       "the run and is resolved by re-reading the specification, never by copying a value):\n")
            for path, (want, why) in c.hand.items():
                out.append("- `%s` = `%s` (%s)" % (path, want, why))
            out.append("")
    return "\n".join(out)


def emit(c, oracle_sha):
    d = os.path.join(CASES, c.id)
    own = c.strategy_ref == "strategy.json"
    if own:
        write_json(os.path.join(d, "strategy.json"), c.strategy, 120)
    check_input_ok = c.kind == "run" or c.kind == "partial"
    if check_input_ok:
        check_input(c.inp)
    write_json(os.path.join(d, "input.json"), c.inp, 200)
    if c.kind == "reject":
        expect = {"outcome": dict(c.expect_outcome)}
    else:
        cls = c.strat_cls or TreeStrategy
        ev = cls(c.strategy)
        c.sim = Sim(c.inp, ev, focus=c.focus).run().finish()
        expect = c.sim.export(c.signal_sessions, c.sections, c.omit)
        if c.kind == "run":
            assert c.sim.outcome["status"] == "COMPLETED", "%s did not complete: %s" % (c.id, c.sim.outcome)
        for path, (want, why) in c.hand.items():
            got = get_path(expect, path)
            if F(str(got)) != F(want) if _numeric(want) else str(got) != str(want):
                raise AssertionError("%s: hand-derived %s = %s but the oracle gives %s (%s)"
                                     % (c.id, path, want, got, why))
    ex_obj = {"schema": "s0-expected/1", "case": c.id,
              "origin": {"kind": "oracle", "oracle": "oracle.py", "oracle_sha256": oracle_sha,
                         "note": "Derived from OQ-02 sections 2.1 to 2.6 with exact rational arithmetic; see "
                                 "derivation.md. Not produced by the Rust engine."},
              "expect": expect}
    write_json(os.path.join(d, "expected.json"), ex_obj, 120)
    case_json = {"id": c.id, "title": c.title, "covers": c.covers, "strategy": c.strategy_ref,
                 "input": "input.json", "expected": "expected.json", "derivation": "derivation.md",
                 "restore_every_cut": bool(c.restore and c.kind == "run")}
    write_json(os.path.join(d, "case.json"), case_json, 120)
    write_text(os.path.join(d, "derivation.md"), render_derivation(c, expect))
    for m in c.manifest:
        MANIFEST_ADDITIONS.append(m)


def _numeric(s):
    try:
        F(str(s))
        return True
    except (ValueError, ZeroDivisionError):
        return False


# ---------------------------------------------------------------- seed-case data builders


def split_even(total_cents, k):
    base, rem = divmod(total_cents, k)
    return [base + 1 if i < rem else base for i in range(k)]


def designed_changes(r2, r1, r0, ng=4, nl=6):
    """The 16 close changes c[t-15..t] giving RSI14 = r2, r1, r0 at t-2, t-1, t.

    Every window holds total movement T = 10.00, so RSI = 10 * (sum of gains). Dropping a1 = c[t-15] and adding
    b1 = c[t-1] moves RSI from r2 to r1; dropping a2 = c[t-14] and adding b0 = c[t] moves it from r1 to r0.
    The 12 fillers c[t-13..t-2] carry the rest of the window t-2 gains and losses.
    """
    r2, r1, r0 = F(r2), F(r1), F(r0)
    x1, x0 = abs(r1 - r2) / 10, abs(r0 - r1) / 10
    a1, b1 = (-x1, x1) if r1 > r2 else ((x1, -x1) if r1 < r2 else (F(0), F(0)))
    a2, b0 = (-x0, x0) if r0 > r1 else ((x0, -x0) if r0 < r1 else (F(0), F(0)))
    g2 = r2 / 10
    l2 = 10 - g2
    gf = g2 - max(a1, 0) - max(a2, 0)
    lf = l2 - max(-a1, 0) - max(-a2, 0)
    assert gf >= 0 and lf >= 0 and (gf * 100).denominator == 1 and (lf * 100).denominator == 1
    gains = [F(c, 100) for c in split_even(int(gf * 100), ng)]
    losses = [-F(c, 100) for c in split_even(int(lf * 100), nl)]
    fillers = []
    gi = li = 0
    while gi < ng or li < nl:
        if li < nl:
            fillers.append(losses[li])
            li += 1
        if gi < ng:
            fillers.append(gains[gi])
            gi += 1
    fillers += [F(0)] * (12 - len(fillers))
    assert len(fillers) == 12 and max(abs(x) for x in fillers) <= 2
    return [a1, a2] + fillers + [b1, b0]


def event_closes(n, events, rise=F(1, 2), start=F(100), tail=None, gap_rise=None):
    """Closes for indices 0..n-1: a steady rise, each event's designed window ending at its t, then a tail.

    The rise before the first event is `rise`; rises between later events are `gap_rise` (default: rise)."""
    ch = {}
    for ev_ in events:
        t = ev_["t"]
        dc = designed_changes(*ev_["path"], ng=ev_.get("ng", 4), nl=ev_.get("nl", 6))
        for k, v in enumerate(dc):
            ch[t - 15 + k] = v
    last_t = max(e["t"] for e in events)
    first_t = min(e["t"] for e in events)
    closes = [F(start)]
    for j in range(1, n):
        if j in ch:
            d = ch[j]
        elif j <= last_t:
            d = rise if (j <= first_t or gap_rise is None) else gap_rise
        else:
            d = tail[j - last_t - 1] if tail and j - last_t - 1 < len(tail) else F(0)
        closes.append(closes[-1] + d)
    return closes


def seed_volumes(n, spikes, base=1000):
    v = [F(base)] * n
    for idx, val in spikes.items():
        v[idx] = F(val)
    return v


SEED_POLICY = make_policy(fixed="1.00", bps="0", slip="0")
SEED_CAPITAL = "10000.00"
SEED_SCORED = 50
LICENCE = "Apache-2.0, generated for this repository"


def seed_input(strategy, bars, sessions, policy=None, scored=SEED_SCORED, dataset="s0-seed-bars"):
    return make_input(sha(strategy), bars, sessions, sessions[scored], SEED_CAPITAL, policy or SEED_POLICY,
                      dataset=dataset)


def sig_pos(sel, idx, sessions):
    return sorted(sessions[i] for i in sel).index(sessions[idx])


def sel_list(idxs, sessions):
    return sorted(set(sessions[i] for i in idxs))


# ---------------------------------------------------------------- SEM cases

VARIANT_TEXT = {
    "v1": "threshold 30, break-even off", "v2": "threshold 32, break-even off",
    "v3": "threshold 30, break-even on", "v4": "threshold 32, break-even on",
    "v5": "threshold 40, break-even off (data-only fifth variant)"}


def seed_case(cid, vkey, title, covers, bars, sessions, notes, sel, hand=None, hand_text="", policy=None,
              scored=SEED_SCORED, focus_idx=(), restore=True, dataset=None):
    strat = load_seed(SEEDS[vkey])
    inp = seed_input(strat, bars, sessions, policy, scored, dataset=dataset or cid.lower() + "-bars")
    return Case(cid, title, covers, strat, inp, strategy_ref="../../strategies/" + SEEDS[vkey], notes=notes,
                hand=hand, hand_text=hand_text, focus=[sessions[i] for i in focus_idx],
                signal_sessions=sel_list(sel, sessions), strat_cls=SeedStrategy, restore=restore)


def build_sem01():
    # Irregular synthetic OHLCV: the rise, the designed dip and the volumes are perturbed by a fixed linear
    # congruential generator so that no window is a round number. Constants below were tuned once so that the
    # ATR14 sum at the signal session is a multiple of 14 cents (a two-decimal ATR keeps the levels exact).
    n, t = 72, 58
    sessions = weekdays("2026-01-05", n)
    lcg = [20260105]

    def rnd(lo, hi):
        lcg[0] = (lcg[0] * 1103515245 + 12345) % (2 ** 31)
        return lo + (lcg[0] >> 8) % (hi - lo + 1)

    ev_ = [{"t": t, "path": (F(27), F(33), F(36)), "ng": 5, "nl": 6}]
    base = event_closes(n, ev_)
    closes = [base[0]]
    for j in range(1, n):
        d = base[j] - base[j - 1]
        if j <= t - 16:
            d = F(rnd(10, 90), 100)          # irregular rise of 0.10 to 0.90 per session
        closes.append(closes[-1] + d)
    rngs = [F(rnd(150, 330), 100) for _ in range(n)]
    for j in range(n):
        d = abs(closes[j] - closes[j - 1]) if j else F(0)
        rngs[j] = max(rngs[j], d)
    vols = [F(rnd(850, 1150)) for _ in range(n)]
    vols[t] = F(2300)
    return sessions, closes, rngs, vols, t


def tune_atr(closes, rngs, t, w=14):
    """Adjust the range of bar t-1 so that the 14 true ranges sum to a multiple of 14 cents."""
    total = sum(rngs[t - w + 1:t + 1], F(0))
    cents = int(total * 100)
    fix = (-cents) % w
    rngs[t - 1] += F(fix, 100)
    assert int(sum(rngs[t - w + 1:t + 1], F(0)) * 100) % w == 0
    return rngs


def make_sem01():
    sessions, closes, rngs, vols, t = build_sem01()
    n = len(sessions)
    rngs = tune_atr(closes, rngs, t)
    bars = bars_from_closes(sessions, closes, rngs=rngs, vols=vols)
    sel = [13, 14, 15, 16, 18, 19, 48, 49, t - 2, t - 1, t, t + 1, n - 1]
    return seed_case(
        "SEM-01", "v1", "Seed indicators on irregular synthetic OHLCV (72 sessions)", ["Seed semantics"],
        bars, sessions,
        "72 sessions of irregular synthetic OHLCV for seed variant 1 (threshold 30, break-even off). Rises are "
        "0.10 to 0.90 per session (fixed LCG), ranges 1.50 to 3.30 plus a tuned bar, volumes 850 to 1150 with a "
        "volume spike at the signal session. The 16 closes before the signal session are designed so that the "
        "weak-RSI path reaches the entry condition. The listed signal sessions cover the first valid session of "
        "every indicator (indices 14 for RSI14 and ATR14, 15 for the first lagged RSI, 16 for the second, 19 for "
        "the volume mean, 49 for SMA50), the sessions around the signal session and the last session. Indicator "
        "values are the exact rational results rounded half-even to four decimals; the ATR14 sum at the signal "
        "session is tuned to a multiple of 14 cents so that stop and target are exact two-decimal prices.",
        sel, hand={
            "signals.8.indicators.2.value": ("27", "designed window: gains 2.70, losses 7.30"),
            "signals.9.indicators.2.value": ("33", "gains 3.30, losses 6.70"),
            "signals.10.indicators.2.value": ("36", "gains 3.60, losses 6.40"),
            "signals.10.indicators.3.value": ("2.4", "ATR14 sum 33.60 / 14, tuned to a whole number of cents"),
            "signals.10.decision": ("ENTER", "weak via 27 <= 30, floor 36 > 30, trend and volume hold"),
            "entries.0.quantity": ("17", "2000.00 / 117.54 = 17.01; 17 * 117.54 + 1.00 = 1999.18 <= 2000.00"),
            "fills.0.cash_delta": ("-1999.18", "-(17 * 117.54 + 1.00)"),
            "final.open_positions.0.stop": ("112.74", "117.54 - 2 * 2.40"),
            "final.open_positions.0.target": ("129.54", "117.54 + 5 * 2.40"),
        }, hand_text=SEM01_TEXT, focus_idx=[14, 15, 16, 19, 48, 49, t - 2, t - 1, t])


SEM01_TEXT = """
- The three RSI values around the signal come from the designed window (total movement 10.00 in every window, RSI = 10 * gains):
  gains 2.70 / losses 7.30 give 27, 3.30 / 6.70 give 33, 3.60 / 6.40 give 36. The lagged values at the signal session are therefore
  RSI(t-2) = 27 and RSI(t-1) = 33, with RSI(t) = 36: weak by 27 <= 30, floor 36 > 30, a genuine upward move from the dip.
- The ATR14 window sum is tuned to 33.60 (a multiple of 14 cents), so ATR14 = 2.40. Sizing: cap = floor(10000.00 / 5) = 2000.00; the
  next open is 117.54, 2000.00 / 117.54 = 17.01, and 17 shares cost 1998.18 + 1.00 = 1999.18 <= 2000.00 while 18 shares cost 2115.72 +
  1.00. Levels: stop 117.54 - 4.80 = 112.74, target 117.54 + 12.00 = 129.54.
- Every listed indicator value was additionally recomputed with a separate integer-cents script (not oracle.py) and agrees to four
  decimals: SMA50, volume SMA20, RSI14, ATR14, RSI lag 1 and lag 2.
"""


def make_sem02():
    # 0..34 rise, 35..50 designed window with zero volume, 51..70 flat with range, 71..90 fully flat, 91..110 fall
    n = 111
    t = 50
    sessions = weekdays("2026-01-05", n)
    ev_ = [{"t": t, "path": (F(29), F(31), F(31))}]
    closes = event_closes(n, ev_, tail=[F(0)] * 20 + [F(0)] * 20 + [F(-1, 2)] * 20)
    vols = [F(1000)] * 31 + [F(0)] * 40 + [F(500)] * (n - 71)
    bars = []
    for j, s in enumerate(sessions):
        c = closes[j]
        o = c if j == 0 else closes[j - 1]
        if 71 <= j <= 90:
            bars.append(bar(s, c, c, c, c, vols[j]))
        elif 51 <= j <= 70:
            bars.append(bar(s, c, c + 1, c - 1, c, vols[j]))
        else:
            d = abs(c - o)
            free = F(2) - d
            a = F(math.floor(free * 100 / 2), 100)
            bars.append(bar(s, o, max(o, c) + a, min(o, c) - (free - a), c, vols[j]))
    sel = [13, 14, 18, 19, 20, 48, 49, 50, 63, 64, 70, 71, 83, 84, 90, 91, 100, 110]
    return seed_case(
        "SEM-02", "v1", "Zero and undefined seed inputs: flat, gain-only, loss-only, zero ATR, zero volume mean",
        ["Seed semantics"], bars, sessions,
        "111 sessions in five segments for seed variant 1; volumes are 1000 to index 30, 0 for indices 31 to 70 and 500 "
        "afterwards. Indices 0 to 34 rise by 0.50 per session (every RSI14 "
        "window holds gains only: RSI 100). Indices 35 to 50 are the designed RSI window 29, 31, 31 at 48, 49, 50, "
        "but the 20 volumes ending at index 50 are 0 from index 31, so the volume mean is 0 and the entry is "
        "blocked by the volume clauses alone (volume 0 is not above a mean of 0; the mean is not positive). "
        "Indices 51 to 70 repeat the last close with a 2.00 range: once 14 zero changes fill the window (index 64 "
        "onward) RSI14 is missing with UNDEFINED_FLAT while ATR14 stays 2.00. Indices 71 to 90 have open = high = "
        "low = close: from index 84 the 14 true ranges are all 0, so ATR14 is 0 (zero ATR can only occur with "
        "flat closes, so RSI14 is also UNDEFINED_FLAT there). Indices 91 to 110 fall by 0.50 per session: the RSI14 "
        "window holds losses only (RSI 0), which satisfies weakness but fails the strict current floor 30. "
        "Any missing referenced indicator makes the condition MISSING and the decision SKIPPED "
        "INDICATOR_UNAVAILABLE (OQ-02 2.6: entry requires all referenced indicator values). INSUFFICIENT_HISTORY "
        "appears at index 13 (RSI14, ATR14), 18 (volume mean) and the lagged RSI values.",
        sel, focus_idx=[13, 14, 49, 50, 64, 84, 91])


# signal list positions of make_sem03: index 13 -> 1, 14 -> 2, 15 -> 3, 16 -> 4, 19 -> 7, 48 -> 10, 49 -> 11
SEM03_HAND = {
    "signals.1.indicators.2.missing_reason": ("INSUFFICIENT_HISTORY", "index 13 has only 13 changes"),
    "signals.1.indicators.3.missing_reason": ("INSUFFICIENT_HISTORY", "index 13 has only 13 true ranges"),
    "signals.2.indicators.2.value": ("62.5", "RSI14 at index 14: gains 2.50, losses 1.50"),
    "signals.2.indicators.3.value": ("2.0357", "ATR14 at index 14: 28.5 / 14"),
    "signals.2.indicators.6.missing_reason": ("INSUFFICIENT_HISTORY", "lag 1 needs index 13's RSI"),
    "signals.3.indicators.2.value": ("63.4146", "RSI14 at index 15: gains 2.60, losses 1.50"),
    "signals.3.indicators.6.value": ("62.5", "lag 1 at index 15 is RSI14 at index 14"),
    "signals.3.indicators.7.missing_reason": ("INSUFFICIENT_HISTORY", "lag 2 at index 15 needs index 13"),
    "signals.4.indicators.7.value": ("62.5", "lag 2 at index 16 is RSI14 at index 14"),
    "signals.6.indicators.1.missing_reason": ("INSUFFICIENT_HISTORY", "volume mean at index 18 has 19 values"),
    "signals.7.indicators.1.value": ("1028.5", "20570 / 20 at index 19"),
    "signals.10.indicators.0.missing_reason": ("INSUFFICIENT_HISTORY", "SMA50 at index 48 has 49 closes"),
    "signals.11.indicators.0.value": ("102.43", "5121.5 / 50 at index 49"),
}
SEM03_TEXT = """
The close changes repeat +0.40, -0.20, +0.10, -0.30, +0.50 (period 5, sum +0.50). The range of bar j is 1.50, 2.00, 2.50 for
j mod 3 = 0, 1, 2; every bar opens at the previous close and moves less than its range, so TR(j) = range(j).

- RSI14 at index 14 uses changes c1..c14 = (+.4 -.2 +.1 -.3 +.5) twice then +.4 -.2 +.1 -.3: gains 2 * 1.0 + 0.5 = 2.50,
  losses 2 * 0.5 + 0.5 = 1.50. RSI = 100 * 2.50 / 4.00 = 62.5. At index 13 only 13 changes exist: INSUFFICIENT_HISTORY.
- ATR14 at index 14 averages TR(1..14): j mod 3 = 1 (j = 1, 4, 7, 10, 13) gives five 2.00 = 10.0, j mod 3 = 2 (2, 5, 8, 11, 14)
  five 2.50 = 12.5, j mod 3 = 0 (3, 6, 9, 12) four 1.50 = 6.0. Sum 28.5, ATR = 28.5 / 14 = 2.035714... -> 2.0357.
- RSI14 at index 15 drops c1 (+0.40) and adds c15 = +0.50: gains 2.60, losses 1.50, RSI = 100 * 2.6 / 4.1 = 63.4146. The lagged
  values: lag1 at index 15 = RSI at 14 = 62.5 (first valid lag1; at index 14 it is INSUFFICIENT_HISTORY), lag2 at index 16 =
  RSI at 14 = 62.5 (first valid lag2, the 17th bar; at index 15 it is INSUFFICIENT_HISTORY).
- Volume j = 1000 + 10 * (j mod 7). Indices 0..19 hold two full cycles (sum of j mod 7 = 21 each) plus j mod 7 = 0..5 (sum 15):
  20 * 1000 + 10 * 57 = 20570; mean 1028.5 at index 19 (the 20th bar); index 18 has only 19 values.
- Closes: for j = 5k + r, close = 100 + 0.5k + p(r) with p = 0, .4, .2, .3, 0. Indices 0..49 sum to 10 * 5 * 100 + 2.5 * (0 + 1 + ...
  + 9) + 10 * 0.9 = 5000 + 112.5 + 9 = 5121.5, SMA50 = 5121.5 / 50 = 102.43 at index 49 (the 50th bar); index 48 has 49 closes.
"""


def make_sem03():
    n = 56
    sessions = weekdays("2026-01-05", n)
    pat = [F(40, 100), F(-20, 100), F(10, 100), F(-30, 100), F(50, 100)]
    closes = [F(100)]
    for j in range(1, n):
        closes.append(closes[-1] + pat[(j - 1) % 5])
    rcyc = [F(150, 100), F(200, 100), F(250, 100)]
    rngs = [rcyc[j % 3] for j in range(n)]
    vols = [F(1000 + 10 * (j % 7)) for j in range(n)]
    bars = bars_from_closes(sessions, closes, rngs=rngs, vols=vols)
    sel = [12, 13, 14, 15, 16, 17, 18, 19, 20, 47, 48, 49, 50, 55]
    return seed_case(
        "SEM-03", "v1", "Seed warm-up: first valid session of every indicator", ["Seed semantics"], bars, sessions,
        "56 sessions. Close changes repeat the period-5 pattern +0.40, -0.20, +0.10, -0.30, +0.50 and the ranges "
        "cycle 1.50, 2.00, 2.50 by index mod 3, so every window has a distinct hand-checkable value. Expected "
        "first valid indices (0-based): RSI14 and ATR14 at 14 (the 15th bar: 14 changes need 15 closes), the first "
        "lagged RSI at 15, the second at 16 (the 17th bar), the volume mean at 19 (the 20th bar), SMA50 at 49 (the "
        "50th bar). Index 13 has no RSI14 or ATR14, index 48 has no SMA50. The scored window starts at index 50 "
        "so every listed session before it is NOT_SCORED_YET; the condition is still evaluated and reported.",
        sel, hand=SEM03_HAND, hand_text=SEM03_TEXT, focus_idx=[13, 14, 15, 16, 19, 48, 49])


def make_sem04():
    # Two-sided boundary for the threshold 30 variants.
    n = 144
    sessions = weekdays("2026-01-05", n)
    ta, tc, tb = 56, 96, 136
    ev_ = [{"t": ta, "path": (F(28), F(29), F(30))},
           {"t": tc, "path": (F("30.5"), F("30.5"), F(31))},
           {"t": tb, "path": (F(30), F(31), F(31))}]
    closes = event_closes(n, ev_, gap_rise=F(1))
    vols = seed_volumes(n, {ta: 6000, tc: 6000, tb: 6000})
    bars = bars_from_closes(sessions, closes, vols=vols)
    sel = [ta - 2, ta - 1, ta, tc - 2, tc - 1, tc, tb - 2, tb - 1, tb, tb + 1, n - 1]
    return seed_case(
        "SEM-04", "v1", "Seed exact boundaries for threshold 30: RSI equal to 30 and just above 30",
        ["Seed semantics", "Entry variants"], bars, sessions,
        "144 sessions, seed variant 1 (threshold 30). Three volume-spike sessions, each with a designed RSI14 "
        "path (total movement 10.00 in every window, so RSI = 10 * sum of gains, an exact ratio such as 3:7): "
        "(1) index 56, RSI 28, 29, 30: weakness holds (28 <= 30) but the strict floor RSI(t) > 30 fails at exactly "
        "30, so NO_ENTRY; (2) index 96, RSI 30.5, 30.5, 31: the lagged values are just above the threshold (30.5 > "
        "30), so weakness fails and the decision is NO_ENTRY; (3) index 136, RSI 30, 31, 31: RSI(t-2) is exactly 30, "
        "which satisfies `<= 30`, and the floor holds at 31, so ENTER. All other clauses hold at each of the three "
        "sessions, so only the boundary decides. The closes rise by 1.00 per session between the events so that the "
        "close is back above SMA50 each time, and the spikes are more than 20 sessions apart so each volume mean "
        "excludes the previous spike.",
        sel, hand={
            "signals.2.indicators.7.value": ("28", "RSI(t-2) at index 54"),
            "signals.2.indicators.2.value": ("30", "RSI(t) = 100 * 3.00 / 10.00 exactly"),
            "signals.2.decision": ("NO_ENTRY", "strict floor RSI > 30 fails at exactly 30"),
            "signals.5.indicators.7.value": ("30.5", "RSI(t-2) at index 94"),
            "signals.5.decision": ("NO_ENTRY", "30.5 > 30 and 30.5 > 30: weakness fails"),
            "signals.8.indicators.7.value": ("30", "RSI(t-2) at index 134, exactly 30"),
            "signals.8.decision": ("ENTER", "30 <= 30 satisfies weakness; floor 31 > 30"),
            "signals.8.rank": ("309", "50 * 4.8 + (100 - 31)"),
        }, hand_text=SEM04_TEXT, focus_idx=[ta, tc, tb])


SEM04_TEXT = """
RSI = 100 * G / (G + L) with G + L = 10.00 in every designed window, so RSI = 10 * G, a ratio of integers in cents.

- Index 56 (28, 29, 30): the window at index 56 holds gains 3.00 and losses 7.00 (ratio 3:7, RSI exactly 30). Weakness: RSI(54) =
  28 <= 30 holds. Floor: RSI(56) = 30 > 30 is false. Every other clause holds (close above SMA50, volume 6000 > 1250, ATR 2 > 0,
  mean 1250 > 0), so the condition is FALSE and the decision NO_ENTRY: only the strict floor decides.
- Index 96 (30.5, 30.5, 31): RSI(94) = RSI(95) = 30.5 (gains 3.05, losses 6.95), both above 30, so `RSI(t-2) <= 30 or RSI(t-1) <=
  30` is false: NO_ENTRY. RSI(96) = 31 passes the floor.
- Index 136 (30, 31, 31): RSI(134) = 100 * 3.00 / 10.00 = 30 exactly, `30 <= 30` holds; RSI(136) = 31 > 30 holds: ENTER, rank
  = 50 * (6000 / 1250) + (100 - 31) = 240 + 69 = 309.
"""


def make_sem04b():
    n = 104
    sessions = weekdays("2026-01-05", n)
    ta, tb = 56, 96
    ev_ = [{"t": ta, "path": (F("32.5"), F(33), F(33))}, {"t": tb, "path": (F(32), F(33), F(33))}]
    closes = event_closes(n, ev_, gap_rise=F(1))
    vols = seed_volumes(n, {ta: 6000, tb: 6000})
    bars = bars_from_closes(sessions, closes, vols=vols)
    sel = [ta - 2, ta - 1, ta, tb - 2, tb - 1, tb, tb + 1, n - 1]
    return seed_case(
        "SEM-04b", "v2", "Seed exact boundary for threshold 32: RSI equal to 32 and just above 32",
        ["Seed semantics", "Entry variants"], bars, sessions,
        "104 sessions, seed variant 2 (threshold 32). (1) index 56, RSI 32.5, 33, 33: both lagged values exceed 32, "
        "so weakness fails and the decision is NO_ENTRY; (2) index 96, RSI 32, 33, 33: RSI(t-2) is exactly 32, "
        "which satisfies `<= 32`; the floor holds (33 > 30), so ENTER. Companion of SEM-04, which covers the "
        "threshold 30 boundary and the strict current floor.",
        sel, hand={
            "signals.2.indicators.7.value": ("32.5", "RSI(t-2) at index 54"),
            "signals.2.decision": ("NO_ENTRY", "32.5 > 32 and 33 > 32"),
            "signals.5.indicators.7.value": ("32", "RSI(t-2) at index 94: gains 3.20, losses 6.80 (8:17), exactly 32"),
            "signals.5.decision": ("ENTER", "32 <= 32 satisfies weakness"),
            "signals.5.rank": ("307", "50 * 4.8 + (100 - 33)"),
        }, hand_text="""
RSI = 10 * G with total movement 10.00. Index 96 (32, 33, 33): RSI(94) has gains 3.20 and losses 6.80, the ratio 8:17, so RSI is
exactly 32 and `32 <= 32` holds; RSI(96) = 33 > 30; the other clauses hold, rank = 240 + (100 - 33) = 307: ENTER. Index 56
(32.5, 33, 33): RSI(54) = 32.5 and RSI(55) = 33 both exceed 32: weakness fails, NO_ENTRY.
""", focus_idx=[ta, tb])


def make_sem05():
    n = 64
    t = 56
    sessions = weekdays("2026-01-05", n)
    ev_ = [{"t": t, "path": (F(29), F(31), F(31))}]
    closes = event_closes(n, ev_)
    vols = [F(1000)] * n
    vols[t - 10] = F(2350)
    vols[t] = F(1650)
    bars = bars_from_closes(sessions, closes, vols=vols)
    sel = [t - 10, t - 1, t, t + 1, n - 1]
    return seed_case(
        "SEM-05", "v1", "Seed volume mean includes the signal bar; rank 50 * (volume / mean) + (100 - RSI)",
        ["Seed semantics"], bars, sessions,
        "64 sessions, seed variant 1, RSI path 29, 31, 31 at indices 54, 55, 56 (the ENT-01 window). Volumes are "
        "1000 except 2350 at index 46 and 1650 at the signal index 56. The 20 volumes of indices 37..56 sum to "
        "18 * 1000 + 2350 + 1650 = 22000, so vol_sma20 = 1100 (the mean includes bar t). Ratio 1650 / 1100 = 1.5, "
        "rank = 50 * 1.5 + (100 - 31) = 75 + 69 = 144. Had the mean excluded bar t, it would be 20350 / 19 = "
        "1071.0526..., the ratio 1.5405 and the rank 146.0..., so the exact rank 144 identifies the inclusive "
        "mean. Rank inputs all come from session t.",
        sel, hand={
            "signals.2.indicators.1.value": ("1100", "(18 * 1000 + 2350 + 1650) / 20, bar t included"),
            "signals.2.rank": ("144", "50 * 1.5 + (100 - 31)"),
            "signals.2.decision": ("ENTER", "all clauses hold"),
            "entries.0.rank": ("144", "frozen rank, exact"),
            "entries.0.quantity": ("17", "17 * 116.00 + 1.00 = 1973.00 <= 2000.00"),
        }, hand_text="""
- Volumes of indices 37..56: eighteen 1000s (indices 37..45 and 47..55 are nine plus nine), the spike 2350 at index 46 and 1650 at
  index 56: sum 18000 + 2350 + 1650 = 22000, mean 1100. Ratio 1650 / 1100 = 1.5 exactly. The closes and RSI are those of ENT-01
  (RSI 29, 31, 31; close 116.00): rank = 50 * 1.5 + (100 - 31) = 144. With the mean excluding bar t (20350 / 19) the rank would
  be about 146.0, so the exact value 144 identifies the inclusive mean.
- Volume 1650 > 1100: the volume clause holds (it would hold against either mean). Entry: cap 2000.00, 17 shares at 116.00.
""", focus_idx=[t])


# ---------------------------------------------------------------- ENT and DEF cases


def ent_data(path, n=64, t=56, tail_closes=None):
    sessions = weekdays("2026-01-05", n)
    closes = event_closes(n, [{"t": t, "path": path}])
    vols = seed_volumes(n, {t: 6000})
    bars = bars_from_closes(sessions, closes, vols=vols)
    return sessions, bars, t


def ent_family(base, path, title, notes_common, expect_enter, hand_builder=None):
    """Four cases ENT-0x-v1..v4: identical bars, only the strategy and its hash differ."""
    out = []
    for v in ("v1", "v2", "v3", "v4"):
        sessions, bars, t = ent_data(path)
        n = len(sessions)
        sel = [14, 15, 16, 19, 49, t - 2, t - 1, t, t + 1, n - 1]
        enters = expect_enter[v]
        hand = hand_builder(sessions, sel, t, enters) if hand_builder else {}
        out.append(seed_case(
            "%s-%s" % (base, v), v, "%s, variant %s (%s)" % (title, v, VARIANT_TEXT[v]),
            ["Entry variants", "Definition execution"], bars, sessions,
            notes_common + " This case runs variant %s (%s). Its input differs from the sibling cases only in the "
            "strategy hash; the bars are identical. Expected at the signal session: %s."
            % (v, VARIANT_TEXT[v], "ENTER" if enters else "NO_ENTRY"),
            sel, hand=hand, focus_idx=[t - 2, t - 1, t, t + 1], dataset=base.lower() + "-bars"))
    return out


def ent01_hand(sessions, sel, t, enters):
    p = sig_pos(sel, t, sessions)
    h = {
        "signals.%d.decision" % p: ("ENTER", "weak via RSI(t-2)=29<=thr, floor 31>30, volume 6000>1250"),
        "signals.%d.condition" % p: ("TRUE", "no crossing at t is needed"),
        "signals.%d.rank" % p: ("309", "50*4.8 + (100-31)"),
    }
    for nm, want in (("sma50", "113.6498"), ("vol_sma20", "1250"), ("rsi14", "31"), ("atr14", "2"),
                     ("rsi_lag1", "31"), ("rsi_lag2", "29"), ("weak_threshold", None)):
        if want is not None:
            idx = {"sma50": 0, "vol_sma20": 1, "rsi14": 2, "atr14": 3, "rsi_floor": 4, "weak_threshold": 5,
                   "rsi_lag1": 6, "rsi_lag2": 7}[nm]
            h["signals.%d.indicators.%d.value" % (p, idx)] = (want, "hand sum of closes / RSI windows, see below")
    h["entries.0.cap"] = ("2000.00", "10000.00 / 5 vacant slots")
    h["entries.0.quantity"] = ("17", "17*116 + 1.00 = 1973.00 <= 2000.00; 18*116 + 1.00 = 2089.00 > 2000.00")
    h["fills.0.price"] = ("116.00", "close at t is the next open: 120.00 - 4.00")
    h["fills.0.cash_delta"] = ("-1973.00", "-(17*116.00 + 1.00)")
    return h


ENT01_HAND = """
Window arithmetic, by hand. The closes rise by 0.50 per session to index 40 (close 120.00). The 16 designed
changes c41..c56 are, in order: -0.20, 0, then the 12 fillers -1.15, +0.73, -1.15, +0.73, -1.15, +0.72, -1.15, +0.72,
-1.15, -1.15, 0, 0, then +0.20, 0. The closes from index 41 are 119.80, 119.80, 118.65, 119.38, 118.23, 118.96,
117.81, 118.53, 117.38, 118.10, 116.95, 115.80, 115.80, 115.80, 116.00, 116.00.

- RSI14 at index 54 uses c41..c54: gains 0.73 + 0.73 + 0.72 + 0.72 = 2.90, losses 0.20 + 6 * 1.15 = 7.10. RSI = 100 *
  2.90 / (2.90 + 7.10) = 29.
- Index 55 drops c41 (loss 0.20) and adds +0.20: gains 3.10, losses 6.90, RSI = 31.
- Index 56 drops c42 (0) and adds c56 (0): RSI = 31. So RSI(t-2), RSI(t-1), RSI(t) = 29, 31, 31 and there is no
  upward crossing at t (31 was already above 30 at t-1).
- SMA50 at index 56: indices 7..40 are an arithmetic progression with 34 terms from 103.50 to 120.00, sum 34 *
  111.75 = 3799.50; indices 41..56 sum to 1882.99; total 5682.49; 5682.49 / 50 = 113.6498. Close 116.00 > 113.6498.
- vol_sma20 = (19 * 1000 + 6000) / 20 = 1250; volume 6000 > 1250. ATR14 = 2.00 because every bar has open = previous
  close and range 2.00. Rank = 50 * (6000 / 1250) + (100 - 31) = 50 * 4.8 + 69 = 309.
- Cap = floor(10000.00 / 5) = 2000.00. Entry at the next open 116.00: 17 * 116.00 = 1972.00 plus fee 1.00 = 1973.00;
  18 shares would cost 2088.00 + 1.00 > 2000.00. Levels (ATR 2): stop 112, target 126.
"""


def make_ent01():
    enters = {"v1": True, "v2": True, "v3": True, "v4": True}
    cases = ent_family(
        "ENT-01", (F(29), F(31), F(31)), "RSI 29, 31, 31 at t-2, t-1, t",
        "64 sessions with the designed RSI14 window 29, 31, 31 at indices 54, 55, 56 and a volume spike at "
        "index 56 (6000 against 1000). The current RSI of 31 was already above 30 one session earlier, so there is "
        "no upward crossing at t; the entry holds because RSI(t-2) = 29 satisfies weakness for both thresholds "
        "(29 <= 30 and 29 <= 32). The position then sits quietly (every later bar stays within entry +/- 1.00), so "
        "break-even never triggers and all four variants have the same trade.",
        enters, ent01_hand)
    for c in cases:
        c.hand_text = ENT01_HAND
    return cases


ENT02_HAND = """
Window arithmetic, by hand. The 16 designed changes c41..c56 are 0, 0, then the 12 fillers -1.15, +0.78, -1.15, +0.78,
-1.15, +0.77, -1.15, +0.77, -1.15, -1.15, 0, 0, then 0, 0. Every window of 14 changes ending at index 54, 55 or 56
holds gains 3.10 and losses 6.90: RSI = 100 * 3.10 / 10.00 = 31 at all three sessions (31, 31, 31).

- Threshold 30 (variants 1 and 3): RSI(t-2) = 31 > 30 and RSI(t-1) = 31 > 30, so weakness fails: NO_ENTRY.
- Threshold 32 (variants 2 and 4): 31 <= 32 holds, the floor 31 > 30 holds, the trend and volume clauses are the
  same as in ENT-01: ENTER with rank 309 at the next open.
- Close at t: the changes sum to -3.80 (3.10 - 6.90), so the close is 120.00 - 3.80 = 116.20 and the entry price is
  116.20. Cap 2000.00: 17 * 116.20 = 1975.40, plus fee 1.00 = 1976.40 <= 2000.00; 18 shares would cost 2091.60 + 1.00.
"""


def ent02_hand(sessions, sel, t, enters):
    p = sig_pos(sel, t, sessions)
    h = {"signals.%d.condition" % p: ("TRUE" if enters else "FALSE", "weakness")}
    h["signals.%d.decision" % p] = ("ENTER" if enters else "NO_ENTRY", "threshold decides")
    h["signals.%d.indicators.2.value" % p] = ("31", "RSI(t)")
    h["signals.%d.indicators.6.value" % p] = ("31", "RSI(t-1)")
    h["signals.%d.indicators.7.value" % p] = ("31", "RSI(t-2)")
    if enters:
        h["fills.0.price"] = ("116.20", "120.00 - 3.80")
        h["fills.0.cash_delta"] = ("-1976.40", "-(17*116.20 + 1.00)")
    return h


def make_ent02():
    enters = {"v1": False, "v2": True, "v3": False, "v4": True}
    cases = ent_family(
        "ENT-02", (F(31), F(31), F(31)), "RSI 31, 31, 31 at t-2, t-1, t",
        "64 sessions with the designed RSI14 window 31, 31, 31 at indices 54, 55, 56 and a volume spike at index 56. "
        "Threshold 30 variants cannot enter (31 > 30 at both lags); threshold 32 variants can.",
        enters, ent02_hand)
    for c in cases:
        c.hand_text = ENT02_HAND
    return cases


def make_ent03():
    path = (F(36), F(36), F(36))
    out = []
    for cid, v in (("ENT-03", "v5"), ("ENT-03-v1", "v1"), ("ENT-03-v2", "v2")):
        sessions, bars, t = ent_data(path)
        n = len(sessions)
        sel = [t - 2, t - 1, t, t + 1, n - 1]
        enters = v == "v5"
        p = sig_pos(sel, t, sessions)
        hand = {"signals.%d.decision" % p: ("ENTER" if enters else "NO_ENTRY", "threshold decides"),
                "signals.%d.indicators.2.value" % p: ("36", "RSI(t) with gains 3.60, losses 6.40")}
        out.append(seed_case(
            cid, v, "RSI 36, 36, 36: data-only threshold 40 variant against thresholds 30 and 32 (%s)" % VARIANT_TEXT[v],
            ["Entry variants", "Definition execution"], bars, sessions,
            "64 sessions with the designed RSI14 window 36, 36, 36 (gains 3.60, losses 6.40 in every window) and a "
            "volume spike at index 56. Variant 5 differs from variant 1 only in the data of one constant (40 against "
            "30) and enters; the sibling cases ENT-03-v1 and ENT-03-v2 run the same bars with thresholds 30 and 32 "
            "and do not (36 > 32). This case runs variant %s (%s): %s at the signal session. No code path differs "
            "between the variants." % (v, VARIANT_TEXT[v], "ENTER" if enters else "NO_ENTRY"),
            sel, hand=hand, focus_idx=[t], dataset="ent-03-bars"))
    return out


# DEF families: bars after the signal session are explicit.


def def_data(path, post):
    n = 64
    t = 56
    sessions = weekdays("2026-01-05", n)
    closes = event_closes(n, [{"t": t, "path": path}])
    vols = seed_volumes(n, {t: 6000})
    bars = bars_from_closes(sessions[:t + 1], closes[:t + 1], vols=vols[:t + 1])
    e = closes[t]
    for k, row in enumerate(post):
        o, h, l, c = [e + F(x) for x in row]
        bars.append(bar(sessions[t + 1 + k], o, h, l, c, 1000))
    assert len(bars) == n
    return sessions, bars, t, e


DEF01_POST = [
    (0, 1, -1, 0),          # 57 entry day, quiet
    (0, "2.5", "-0.5", 1),  # 58 high = entry + 2.5 >= entry + ATR: break-even triggers at this close
    ("0.5", 1, "-0.5", 0),  # 59 low = entry - 0.5 <= entry: stops a break-even position at the entry price
    (0, 1, -1, 0),          # 60 quiet
    (0, 11, -1, 9),         # 61 high = entry + 11 >= entry + 10: target for a position still open
    (9, 10, 8, 9),          # 62
    (9, 10, 8, 9),          # 63
]


def make_def01():
    out = []
    for v in ("v1", "v2", "v3", "v4"):
        sessions, bars, t, e = def_data((F(29), F(31), F(31)), DEF01_POST)
        n = len(sessions)
        be = v in ("v3", "v4")
        sel = [t - 2, t - 1, t, t + 1, t + 2, t + 3, t + 4, t + 5, n - 1]
        out.append(seed_case(
            "DEF-01-%s" % v, v, "Definition execution, break-even %s: scheduled stop, activation and exit (%s)"
            % ("on" if be else "off", VARIANT_TEXT[v]),
            ["Definition execution", "Entry and exit phases"], bars, sessions,
            "64 sessions; signal data as ENT-01 (RSI 29, 31, 31, volume spike at index 56), so all four variants enter "
            "at the index 57 open at 116.00 with ATR 2.00: stop 112, target 126, break-even trigger high >= 118. "
            "The bars after the entry are explicit. Index 58 has high 118.50 (>= 118): at its close a break-even "
            "variant fires once and schedules the new stop 116 (the entry price) effective index 59 before the open; "
            "the active stop is still 112 at index 58 even though the bar's low 115.50 is below 116, so a "
            "high-triggered change is not effective in its own session. Index 59 has low 115.50 <= 116: variants "
            "with break-even exit there at the stop 116.00 (a loss of fees only); variants without it keep the "
            "position (stop 112) and reach the target 126 at index 61 (high 127). This case runs variant %s (%s). "
            "On and off differ only through the strategy definition; the bars are identical. Variants 1 and 2 (and "
            "variants 3 and 4) give identical results because both thresholds admit this entry." % (v, VARIANT_TEXT[v]),
            sel, hand=def01_hand(v, be), hand_text=DEF01_TEXT, focus_idx=[t + 1, t + 2, t + 3, t + 4, t + 5],
            dataset="def-01-bars"))
    return out


def def01_hand(v, be):
    if be:
        return {"daily.58.positions.0.stop": ("112", "still the original stop in the trigger session"),
                "daily.58.positions.0.scheduled_stop.level": ("116", "the entry price"),
                "daily.58.positions.0.scheduled_stop.effective_session": ("2026-03-27", "next session"),
                "fills.1.reason": ("STOP", "activated stop 116 touched by low 115.50"),
                "fills.1.price": ("116.00", "stop level"), "fills.1.session": ("2026-03-27", "index 59"),
                "fills.1.cash_delta": ("1971.00", "17 * 116.00 - 1.00"),
                "final.cash_available": ("9998.00", "10000.00 - 1973.00 + 1971.00")}
    return {"daily.59.positions.0.stop": ("112", "no adjustment is defined"),
            "fills.1.reason": ("TARGET", "high 127 >= 126 at index 61"),
            "fills.1.price": ("126.00", "target level"), "fills.1.session": ("2026-03-31", "index 61"),
            "fills.1.cash_delta": ("2141.00", "17 * 126.00 - 1.00"),
            "final.cash_available": ("10168.00", "10000.00 - 1973.00 + 2141.00")}


DEF01_TEXT = """
- Entry as ENT-01: close at index 56 is 116.00, so the next open is 116.00; cap 2000.00; 17 shares cost 1972.00 + 1.00 = 1973.00 (cash
  8027.00). ATR 2.00: stop 112.00, target 126.00, break-even trigger high >= 116.00 + 2.00 = 118.00.
- Index 58 bar (116, 118.5, 115.5, 117): high 118.50 >= 118.00. A break-even variant fires at the close and schedules the new stop 116.00
  (the entry price), effective index 59 before the open; the daily record of index 58 shows stop 112 and the scheduled stop. The same
  bar's low 115.50 is below 116 but above 112, so nothing exits that session: a high-triggered change is not effective at once.
- Index 59 bar (116.5, 117, 115.5, 116): the activated stop 116 is touched (low 115.50 <= 116): STOP at 116.00 (open 116.50 > 116, no
  gap). Proceeds 17 * 116.00 - 1.00 = 1971.00; cash 8027.00 + 1971.00 = 9998.00 (the fixed fees are the whole loss).
- Without break-even the stop stays 112 and index 61 (high 127 >= 126) fills the TARGET at 126.00: proceeds 17 * 126.00 - 1.00 = 2141.00,
  cash 10168.00.
"""


DEF02_POST = [
    (0, 1, -1, 0),                  # 57 entry day
    (0, "2.5", "-0.5", 1),          # 58 break-even trigger (high >= entry + 2)
    (-1, 0, -2, "-1.5"),            # 59 opens below the break-even stop but above the original stop
    ("-1.5", "-0.5", "-2.5", "-1.5"),  # 60 quiet for the original stop 112.20
    ("-1.5", -1, "-4.5", -4),       # 61 low <= entry - 4: original stop
    (-4, -3, -5, -4),               # 62
    (-4, -3, -5, -4),               # 63
]


def make_def02():
    out = []
    for v in ("v1", "v2", "v3", "v4"):
        sessions, bars, t, e = def_data((F(31), F(31), F(31)), DEF02_POST)
        n = len(sessions)
        be = v in ("v3", "v4")
        enters = v in ("v2", "v4")
        sel = [t - 2, t - 1, t, t + 1, t + 2, t + 3, t + 4, t + 5, n - 1]
        pol = make_policy(fixed="1.00", bps="0", slip="50")
        out.append(seed_case(
            "DEF-02-%s" % v, v, "Definition execution with a gap through the scheduled stop (%s)" % VARIANT_TEXT[v],
            ["Definition execution", "Entry and exit phases"], bars, sessions,
            "64 sessions; signal data as ENT-02 (RSI 31, 31, 31), so only the threshold 32 variants (2 and 4) enter, "
            "at the index 57 open at 116.20 (ATR 2.00: stop 112.20, target 126.20, break-even trigger high >= "
            "118.20). Index 58 triggers break-even (high 118.70) for variant 4. Index 59 opens at 115.20, below the "
            "scheduled stop 116.20 (now active) but above the original stop 112.20: variant 4 exits at the open as "
            "GAP_STOP with 50 bps adverse slippage, floor(115.20 * 0.995) = 114.62; variant 2 keeps the position "
            "and its original stop 112.20 is touched at index 61 (low 111.70): STOP fill at 112.20. Variants 1 and "
            "3 never enter. This case runs variant %s (%s): %s."
            % (v, VARIANT_TEXT[v], ("enters" if enters else "does not enter") +
               ((", break-even on" if be else ", break-even off") if enters else "")),
            sel, policy=pol, hand=def02_hand(v), hand_text=DEF02_TEXT,
            focus_idx=[t + 1, t + 2, t + 3, t + 4, t + 5], dataset="def-02-bars"))
    return out


def def02_hand(v):
    if v in ("v1", "v3"):
        return {"final.cash_available": ("10000.00", "threshold 30 never enters (31 > 30 at both lags)")}
    if v == "v4":
        return {"fills.1.reason": ("GAP_STOP", "open 115.20 <= scheduled stop 116.20"),
                "fills.1.price": ("114.62", "floor(115.20 * 0.995) = floor(114.624)"),
                "fills.1.cash_delta": ("1947.54", "17 * 114.62 - 1.00 = 1948.54 - 1.00"),
                "final.cash_available": ("9971.14", "10000.00 - 1976.40 + 1947.54")}
    return {"fills.1.reason": ("STOP", "low 111.70 <= original stop 112.20"),
            "fills.1.price": ("112.20", "stop level"), "fills.1.session": ("2026-03-31", "index 61"),
            "fills.1.cash_delta": ("1906.40", "17 * 112.20 - 1.00"),
            "final.cash_available": ("9930.00", "10000.00 - 1976.40 + 1906.40")}


DEF02_TEXT = """
- Entry as ENT-02 (threshold 32 variants only): close at index 56 is 116.20, 17 shares cost 1975.40 + 1.00 = 1976.40, cash 8023.60. Stop
  112.20, target 126.20, break-even trigger high >= 118.20. Variants 1 and 3 (threshold 30) never enter: cash stays 10000.00.
- Index 58 high 118.70 >= 118.20 triggers break-even (variant 4): scheduled stop 116.20 effective index 59.
- Index 59 opens at 115.20. Variant 4: 115.20 <= 116.20 is a gap through the activated stop: price floor(115.20 * (1 - 50/10000)) =
  floor(114.624) = 114.62; proceeds 17 * 114.62 - 1.00 = 1947.54; cash 8023.60 + 1947.54 = 9971.14. Variant 2: the stop is 112.20, the
  open 115.20 is above it and the low 114.20 does not touch it; the position survives and index 61 (low 111.70 <= 112.20) fills
  STOP at 112.20: proceeds 17 * 112.20 - 1.00 = 1906.40; cash 9930.00.
"""


# ---------------------------------------------------------------- reduced-strategy cases

D = weekdays("2026-01-05", 120)


def FL(p, r=2):
    """Flat bar opening and closing at p."""
    return (p, fr(p) + fr(r) / 2, fr(p) - fr(r) / 2, p)


def rc(cid, title, covers, rows, policy=None, capital="5000.00", skw=None, notes="", hand=None, hand_text="",
       scored=3, actions=(), events=(), focus=None, kind="run", sections=None, omit=(), restore=True,
       sig=None, expect_outcome=None, mutate=None, n_sessions=None, policy_text="", dataset=None, sid=None, version=1):
    n = n_sessions or len(rows)
    sessions = D[:n]
    bars = []
    for s, r in zip(sessions, rows):
        if r is not None:
            bars.append(bar(s, *r))
    strat = reduced_strategy(sid or cid.lower() + "-reduced", version=version, **(skw or {}))
    inp = make_input(sha(strat), bars, sessions, sessions[scored], capital, policy or make_policy(), actions, events,
                     dataset=dataset or cid.lower() + "-bars")
    if mutate:
        mutate(inp, strat)
    return Case(cid, title, covers, strat, inp, notes=notes, hand=hand, hand_text=hand_text,
                focus=focus if focus is not None else [], kind=kind, sections=sections, omit=omit,
                restore=restore, signal_sessions=sig, expect_outcome=expect_outcome, policy_text=policy_text)


P1 = {"fixed": "1.00", "bps": "10"}
HEAD50 = [FL(50)] * 4 + [(50, "51.5", "49.5", 51)]       # indices 0..4, signal at index 4, ATR3 = 2


def make_x01():
    rows = HEAD50 + [FL(50)] * 3
    hand = {
        "entries.0.cap": ("1000.00", "floor(5000.00 / 5)"),
        "entries.0.quantity": ("19", "950.00 + 1.95 = 951.95 <= 1000.00; 20 shares: 1000.00 + 2.00 = 1002.00 > 1000.00"),
        "entries.0.fee": ("1.95", "ceil(1.00 + 950.00 * 10 / 10000)"),
        "fills.0.cash_delta": ("-951.95", "-(950.00 + 1.95)"),
        "cash_ledger.2.available_after": ("4048.05", "5000.00 - 951.95"),
        "daily.5.equity": ("4998.05", "4048.05 + 19 * 50.00"),
        "daily.5.positions.0.stop": ("46", "50 - 2 * 2"),
        "daily.5.positions.0.target": ("60", "50 + 5 * 2"),
        "final.equity": ("4998.05", "no price change"),
    }
    txt = """
- Signal at index 4 (2026-01-09): SMA3 = (50 + 50 + 51) / 3 = 50.3333, close 51 > 50.3333. True ranges of indices 2, 3, 4
  are 2, 2, 2, so ATR3 = 2. Not held, five vacant slots: cap = floor(5000.00 / 5) = 1000.00. Reserve: available
  4000.00, reserved 1000.00.
- Next open (2026-01-12) is 50.00. fee(n) = ceil(1.00 + n * 10 / 10000). Quantity 20: notional 1000.00, fee =
  ceil(1.00 + 1.00) = 2.00, total 1002.00 > 1000.00, rejected. Quantity 19: notional 950.00, fee = ceil(1.00 + 0.95) =
  1.95, total 951.95 <= 1000.00, accepted. The cap is released (available 5000.00) and 951.95 debited: 4048.05.
- Levels: stop 50 - 2 * 2 = 46, target 50 + 5 * 2 = 60. No later bar touches them. Equity 4048.05 + 19 * 50 = 4998.05.
"""
    return rc("X-01", "Next-open entry: cap 1000, fee 1.00 + 10 bps, 19 shares, cash 4048.05",
              ["Cash and quantities", "Entry and exit phases"], rows, make_policy(**P1),
              notes="Eight sessions. Capital 5000.00, five slots, lot 1, fee 1.00 fixed plus 10 bps. A single close "
                    "signal at index 4 reserves the cap, the fill happens at the next open and never at the signal "
                    "close. The fee rounding up (ceil) makes 20 shares unaffordable although 20 * 50.00 = 1000.00 "
                    "equals the cap.", hand=hand, hand_text=txt, focus=[D[4]])


def make_x02(lot, capital, cid):
    rows = [FL(36)] * 4 + [(36, "37.5", "35.5", 37)] + [FL(36)] * 3
    if lot == 10:
        hand = {"entries.0.quantity": ("20", "2.77 lots of 10 round down to 2 lots"),
                "fills.0.cash_delta": ("-721.00", "-(20 * 36.00 + 1.00)"),
                "final.cash_available": ("4279.00", "5000.00 - 721.00")}
        txt = """
- Cap = floor(5000.00 / 5) = 1000.00. Open 36.00, lot 10, fee 1.00 fixed: one lot costs 360.00 + 1.00. 2 lots = 720.00 +
  1.00 = 721.00 <= 1000.00; 3 lots = 1080.00 + 1.00 > 1000.00. 1000.00 / 360.00 = 2.78 lots rounds DOWN to 2 lots (20
  shares), not to the nearest 3. Cash 5000.00 - 721.00 = 4279.00.
"""
    else:
        hand = {"entries.0.quantity": ("200", "2.77 lots of 100 round down to 2 lots"),
                "fills.0.cash_delta": ("-7201.00", "-(200 * 36.00 + 1.00)"),
                "final.cash_available": ("42799.00", "50000.00 - 7201.00")}
        txt = """
- Capital 50000.00, cap = floor(50000.00 / 5) = 10000.00. Open 36.00, lot 100, fee 1.00: 2 lots = 7200.00 + 1.00 =
  7201.00 <= 10000.00; 3 lots = 10800.00 + 1.00 > 10000.00. 10000.00 / 3600.00 = 2.78 lots rounds DOWN to 2 lots (200
  shares). Cash 50000.00 - 7201.00 = 42799.00.
"""
    return rc(cid, "Lot size %d rounds the quantity down" % lot, ["Cash and quantities"], rows,
              make_policy(lot=lot, fixed="1.00", bps="0"), capital=capital,
              notes="Eight sessions at price 36.00 with ATR 2.00. Lot size %d: the quantity is the largest lot multiple "
                    "whose notional plus fee fits the frozen cap; it is never rounded to the nearest lot." % lot,
              hand=hand, hand_text=txt, focus=[D[4]])


def make_x03():
    rows = [FL(49)] * 4 + [(49, "50.5", "48.5", 50)] + [FL(49)] * 3
    hand = {
        "entries.0.cap": ("999.90", "floor(4999.50 / 5)"),
        "entries.0.quantity": ("19", "20 shares: 980.00 + ceil(19.9049) = 999.91 > 999.90"),
        "entries.0.fee": ("19.91", "ceil(19.90 + 931.00 * 0.05 / 10000) = ceil(19.904655)"),
        "fills.0.cash_delta": ("-950.91", "-(931.00 + 19.91)"),
        "final.cash_available": ("4048.59", "4999.50 - 950.91"),
    }
    txt = """
- Capital 4999.50, five slots: cap = floor(999.90) = 999.90. Open 49.00, fixed fee 19.90, fee 0.05 bps.
- 20 shares: notional 980.00, raw fee = 19.90 + 980.00 * 0.05 / 10000 = 19.90 + 0.0049 = 19.9049, ceil to cents =
  19.91, total 999.91 > 999.90. Rejected by one cent. (Rounding to nearest or down would give a fee of 19.90, total
  999.90 <= cap, and wrongly buy 20 shares.)
- 19 shares: notional 931.00, raw fee 19.904655, ceil 19.91, total 950.91 <= 999.90. Accepted.
- Cash: 4999.50 - 999.90 = 3999.60 reserved, released to 4999.50, debit 950.91 gives 4048.59.
"""
    return rc("X-03", "Fee rounds up: one share less when ceil pushes the total over the cap",
              ["Cash and quantities"], rows, make_policy(fixed="19.90", bps="0.05"), capital="4999.50",
              notes="Eight sessions at price 49.00. The fee is rounded up to the money scale, so a total that would "
                    "fit with an unrounded or nearest-rounded fee exceeds the cap by one cent and the quantity "
                    "drops from 20 to 19. X-01 shows the same effect with q=20 costing 1002.00 against a cap of "
                    "1000.00; this case isolates the sub-cent ceil.",
              hand=hand, hand_text=txt, focus=[D[4]])


def make_x04():
    rows = ([FL(85)] * 4 + [(85, "86.5", "84.5", 86)] + [FL(85)]
            + [(85, 85, 83, 83), (83, 83, 81, 81), (81, 81, 79, 79), (79, 79, 77, 77), (77, 77, 75, 75),
               (75, 77, 75, 77)] + [FL(75)] * 2)
    hand = {
        "entries.0.cap": ("80.00", "floor(400.00 / 5)"),
        "entries.0.status": ("SKIPPED", "85.00 + 1.00 > 80.00"),
        "entries.0.reason": ("CAP_BELOW_ONE_LOT", "no whole lot fits"),
        "cash_ledger.1.available_after": ("400.00", "reservation released in full"),
        "entries.1.cap": ("80.00", "the released cash is available again at the next close"),
        "entries.1.quantity": ("1", "75.00 + 1.00 = 76.00 <= 80.00; 2 shares 151.00 > 80.00"),
        "final.cash_available": ("324.00", "400.00 - 76.00"),
    }
    txt = """
- Capital 400.00: cap = floor(400.00 / 5) = 80.00 at both closes. First signal (index 4, close 86 > SMA3 85.3333): open
  85.00, one share costs 85.00 + 1.00 = 86.00 > 80.00, so quantity 0: SKIPPED CAP_BELOW_ONE_LOT. The reservation of
  80.00 is released (available back to 400.00) and nothing else is bought (no backfill).
- Prices then fall by 2 per session to 75 (close below SMA3, no signals). At index 11 the close 77 > SMA3 (77 + 75 +
  77) / 3 = 76.3333: second signal, ATR3 = 2. Available is 400.00 again, so cap = 80.00 (not 64.00, which would be the
  cap had the first reservation not been released). Open 75.00: 75.00 + 1.00 = 76.00 <= 80.00, 2 shares = 151.00 > 80.00:
  quantity 1. Cash 400.00 - 76.00 = 324.00.
"""
    return rc("X-04", "Cap below one lot: skipped, reservation released, no backfill, leftover cash reused",
              ["Cash and quantities"], rows, make_policy(fixed="1.00", bps="0"), capital="400.00",
              notes="Fourteen sessions with initial capital 400.00. The first intent cannot afford one share at the "
                    "open and is skipped with its reservation released; the second signal, at a lower price, finds "
                    "the released cash available and buys one share.",
              hand=hand, hand_text=txt, focus=[D[4], D[11]])


def make_x05():
    rows = HEAD50 + [FL(50), (44.37, 45, 43, 44), FL(44), FL(44)]
    hand = {
        "fills.1.price": ("43.92", "floor(44.37 * 0.99) = floor(43.9263)"),
        "fills.1.reason": ("GAP_STOP", "open 44.37 <= stop 46"),
        "fills.1.notional": ("834.48", "19 * 43.92"),
        "fills.1.fee": ("1.84", "ceil(1.00 + 834.48 * 10 / 10000) = ceil(1.83448)"),
        "fills.1.cash_delta": ("832.64", "834.48 - 1.84"),
        "final.cash_available": ("4880.69", "4048.05 + 832.64"),
        "trades.0.exit_price": ("43.92", "the exit price"),
    }
    txt = """
- Entry as X-01: 19 shares at 50.00, fee 1.95, available 4048.05, stop 46, target 60.
- Index 6 opens at 44.37, below the stop 46 (open <= stop): a gap through the stop. The fill is at the opening price less
  adverse slippage, not at the stop: 44.37 * (1 - 100/10000) = 44.37 * 0.99 = 43.9263, floored to the price scale 2:
  43.92. Notional 19 * 43.92 = 834.48. Fee = ceil(1.00 + 834.48 * 10/10000) = ceil(1.00 + 0.83448) = 1.84. Proceeds
  834.48 - 1.84 = 832.64. Available 4048.05 + 832.64 = 4880.69.
"""
    return rc("X-05", "Gap through the stop: fill at the open less slippage, not at the stop",
              ["Entry and exit phases", "Cash and quantities"], rows, make_policy(fixed="1.00", bps="10", slip="100"),
              notes="Nine sessions. The held position's stop is 46; the next bar opens at 44.37. Slippage is 100 bps on "
                    "gap-through-stop exits; sell prices floor to the price scale.", hand=hand, hand_text=txt,
              focus=[D[4]])


def make_x06():
    rows = HEAD50 + [FL(50), (63, 64, 50, 50), FL(50), FL(50)]
    hand = {
        "fills.1.price": ("60.00", "target level, no slippage"),
        "fills.1.reason": ("GAP_TARGET", "open 63 >= target 60"),
        "fills.1.fee": ("2.14", "ceil(1.00 + 1140.00 * 10 / 10000) = ceil(2.14)"),
        "fills.1.cash_delta": ("1137.86", "1140.00 - 2.14"),
        "final.cash_available": ("5185.91", "4048.05 + 1137.86"),
    }
    txt = """
- Entry as X-01 (19 shares at 50.00, available 4048.05, stop 46, target 60). Index 6 opens at 63, above the target 60:
  gap above target. The fill is at the target level before costs and without slippage even though the policy declares
  100 bps for gap-through-stop exits: price 60.00. Notional 19 * 60.00 = 1140.00. Fee = ceil(1.00 + 1140.00 * 10/10000)
  = ceil(2.14) = 2.14. Proceeds 1137.86. Available 4048.05 + 1137.86 = 5185.91.
- The bar then falls to a close of 50, so no new signal arises at index 6 (close 50 < SMA3 50.3333).
"""
    return rc("X-06", "Gap above the target fills at the target level without slippage",
              ["Entry and exit phases", "Cash and quantities"], rows, make_policy(fixed="1.00", bps="10", slip="100"),
              notes="Nine sessions. The position's target is 60; the next bar opens at 63 and falls to a close of 50.",
              hand=hand, hand_text=txt, focus=[D[4]])


def make_x07():
    rows = HEAD50 + [FL(50), (50, 61, 45, 50), FL(50), FL(50)]
    hand = {
        "fills.1.price": ("46.00", "stop level"),
        "fills.1.reason": ("STOP", "stop takes precedence"),
        "fills.1.ambiguous_bar": ("True", "both touched"),
        "fills.1.fee": ("1.88", "ceil(1.00 + 874.00 * 10 / 10000) = ceil(1.874)"),
        "fills.1.cash_delta": ("872.12", "874.00 - 1.88"),
        "trades.0.ambiguous_bar": ("True", "recorded on the trade"),
        "final.cash_available": ("4920.17", "4048.05 + 872.12"),
    }
    txt = """
- Entry as X-01 (19 shares at 50.00, stop 46, target 60). Index 6 opens at 50 (no gap), low 45 <= 46 touches the stop and
  high 61 >= 60 touches the target. The order is unknown, so the stop takes precedence and the bar is recorded as ambiguous.
  Fill at the stop level 46.00: notional 19 * 46.00 = 874.00, fee = ceil(1.00 + 0.874) = 1.88, proceeds 872.12.
  Available 4048.05 + 872.12 = 4920.17.
"""
    return rc("X-07", "Dual touch: the stop wins and the bar is flagged ambiguous",
              ["Entry and exit phases"], rows, make_policy(**P1),
              notes="Nine sessions. After the X-01 entry, one bar spans both the stop (46) and the target (60) without "
                    "gapping.", hand=hand, hand_text=txt, focus=[D[4]])


def make_x08():
    # four episodes: low == stop, high == target, open == stop (gap), open == target (gap)
    rows = [FL(50)] * 4 + [(50, "51.5", "49.5", 51), FL(50), (50, 51, 46, 48)]               # idx 0..6   A
    rows += [FL(48)] * 3 + [(48, "49.5", "47.5", 49), FL(48), (48, 58, 47, 48)]                  # idx 7..12  B
    rows += [FL(48)] * 3 + [(48, "49.5", "47.5", 49), FL(48), (44, 45, 43, 44)]                  # idx 13..18 C
    rows += [FL(44)] * 3 + [(44, "45.5", "43.5", 45), FL(44), (54, 55, 44, 44), FL(44)]          # idx 19..25 D
    hand = {
        "fills.1.reason": ("STOP", "low 46 == stop 46 touches"),
        "fills.1.price": ("46.00", "stop level"),
        "fills.3.reason": ("TARGET", "high 58 == target 58 touches"),
        "fills.3.price": ("58.00", "target level"),
        "fills.5.reason": ("GAP_STOP", "open 44 == stop 44 is a gap exit"),
        "fills.5.price": ("43.56", "44.00 * 0.99"),
        "fills.7.reason": ("GAP_TARGET", "open 54 == target 54 is a gap exit"),
        "fills.7.price": ("54.00", "target level"),
        "entries.0.quantity": ("19", "cap 1000.00: 950.00 + 1.00"),
        "entries.1.cap": ("984.40", "floor(4922.00 / 5)"),
        "entries.1.quantity": ("20", "960.00 + 1.00 <= 984.40"),
        "entries.2.cap": ("1024.00", "5120.00 / 5"),
        "entries.2.quantity": ("21", "1008.00 + 1.00 <= 1024.00"),
        "entries.3.cap": ("1004.95", "floor(5024.76 / 5)"),
        "entries.3.quantity": ("22", "968.00 + 1.00 <= 1004.95"),
        "final.cash_available": ("5242.76", "see the cash chain"),
    }
    txt = """
Four trades, fee 1.00 fixed, no bps, gap slippage 100 bps. Levels: stop = entry - 2 * 2, target = entry + 5 * 2 (ATR 2
at every signal).

1. A: cap 1000.00, open 50.00, 19 shares (950 + 1 = 951 <= 1000; 20 shares 1001 > 1000). Available 4049.00. Stop 46,
   target 60. Bar index 6: open 50, low exactly 46 = stop: a touch (low <= stop), STOP at 46.00 (no gap: open 50 > 46).
   Proceeds 19 * 46 - 1 = 873.00, available 4922.00.
2. B: cap floor(4922.00 / 5) = 984.40, open 48.00, 20 shares (960 + 1 = 961). Available 3961.00. Stop 44, target 58. Bar
   index 12: open 48, high exactly 58 = target: TARGET at 58.00. Proceeds 20 * 58 - 1 = 1159.00, available 5120.00.
3. C: cap 5120.00 / 5 = 1024.00, open 48.00, 21 shares (1008 + 1 = 1009). Available 4111.00. Stop 44. Bar index 18 opens at
   exactly 44 = stop: open <= stop is a gap exit: price floor(44.00 * 0.99) = 43.56. Proceeds 21 * 43.56 - 1 = 913.76,
   available 5024.76.
4. D: cap floor(5024.76 / 5) = 1004.95, open 44.00, 22 shares (968 + 1 = 969; 23 shares 1013). Available 4055.76. Target
   54. Bar index 24 opens at exactly 54 = target: open >= target is a gap exit at the target level 54.00. Proceeds 22 * 54 -
   1 = 1187.00, available 5242.76.
"""
    return rc("X-08", "Equality boundaries: low = stop, high = target, open = stop, open = target",
              ["Entry and exit phases", "Cash and quantities"], rows, make_policy(fixed="1.00", bps="0", slip="100"),
              notes="Twenty-six sessions, four consecutive trades each ending on an exact equality: a bar whose low "
                    "equals the stop (touch), a bar whose high equals the target (touch), an open equal to the stop "
                    "(gap exit with slippage) and an open equal to the target (gap exit at the target).",
              hand=hand, hand_text=txt, focus=[])


def make_x09(be):
    rows = HEAD50 + [FL(50), (50, 52, "49.5", 51), (50.5, 51, "49.5", "50.2"), (51, 61, "50.5", 59)]
    if be:
        hand = {
            "daily.6.positions.0.scheduled_stop.level": ("50", "entry price"),
            "daily.6.positions.0.scheduled_stop.effective_session": (D[7], "next session"),
            "daily.6.positions.0.stop": ("46", "still the original stop in the trigger session"),
            "fills.1.reason": ("STOP", "activated stop 50 touched by low 49.5"),
            "fills.1.price": ("50.00", "break-even stop at the entry price"),
            "fills.1.session": (D[7], "index 7"),
            "fills.1.cash_delta": ("949.00", "19 * 50.00 - 1.00"),
            "final.cash_available": ("4998.00", "5000.00 - 951.00 + 949.00"),
        }
        txt = """
- Entry as X-01 without bps: cap 1000.00, open 50.00, 19 shares (950 + 1 = 951), available 4049.00, ATR 2, stop 46, target 60.
- Index 6: high 52.00 = entry + ATR (50 + 2): the trigger high >= entry + entry_ATR holds at the close. The stop moves once to
  the entry price 50, effective index 7 before the open. The stop is still 46 for index 6 itself: the bar's low 49.50 is below
  the new level 50 but above 46, and there is no exit (a high-triggered change is never effective in its own session).
- Index 7: BEFORE_OPEN activates stop 50. Open 50.50 > 50 (no gap), low 49.50 <= 50: STOP at 50.00. Proceeds 19 * 50.00 - 1.00
  = 949.00, available 4049.00 + 949.00 = 4998.00 (the round trip costs the two fixed fees).
"""
    else:
        hand = {
            "daily.6.positions.0.stop": ("46", "no adjustment defined"),
            "fills.1.reason": ("TARGET", "high 61 >= 60 at index 8"),
            "fills.1.session": (D[8], "index 8"),
            "fills.1.cash_delta": ("1139.00", "19 * 60.00 - 1.00"),
            "final.cash_available": ("5188.00", "4049.00 + 1139.00"),
        }
        txt = """
- Entry as X-01 without bps: 19 shares at 50.00, available 4049.00, stop 46, target 60. No stop adjustment is defined.
- Index 7: low 49.50 > 46, nothing happens. Index 8: high 61 >= 60 and low 50.50 > 46: TARGET at 60.00. Proceeds 19 * 60.00 -
  1.00 = 1139.00, available 5188.00.
"""
    return rc("X-09%s" % ("b" if be else "a"),
              "Break-even %s on identical bars: %s" % ("on" if be else "off",
                                                          "scheduled stop 50, exit at 50.00" if be else "target at 60.00"),
              ["Entry and exit phases", "Definition execution"], rows, make_policy(fixed="1.00", bps="0"),
              skw={"break_even": be}, sid="x-09-reduced", version=2 if be else 1, dataset="x-09-bars",
              notes="Nine sessions. The entry is at 50.00 with ATR 2 (stop 46, target 60, break-even trigger high >= 52). "
                    "Index 6 reaches 52.00, index 7 dips to 49.50 and index 8 rallies through the target. The bars are "
                    "identical to the sibling case X-09%s; only the strategy hash and the strategy differ."
                    % ("a" if be else "b"),
              hand=hand, hand_text=txt, focus=[D[4]])


def make_x10():
    rows = HEAD50 + [FL(50), FL(50), (50, 61, 50, 60), (58, 59, 57, 58), (58, 59, 57, 58)]
    hand = {
        "fills.1.reason": ("TARGET", "high 61 >= target 60"),
        "fills.1.price": ("60.00", "target level"),
        "entries.1.cap": ("1037.60", "floor(5188.00 / 5): proceeds already in cash at the close"),
        "entries.1.quantity": ("17", "17 * 58.00 + 1.00 = 987.00 <= 1037.60; 18 shares 1045.00"),
        "fills.2.session": (D[8], "re-entry at the NEXT session's open"),
        "fills.2.price": ("58.00", "the next open, not the close 60 and not the exit price"),
        "daily.8.positions.0.stop": ("48", "58 - 2 * 5, ATR from the signal session index 7"),
        "daily.8.positions.0.target": ("83", "58 + 5 * 5"),
        "final.cash_available": ("4201.00", "5188.00 - 987.00"),
    }
    txt = """
- First trade: cap 1000.00, open 50.00, 19 shares, available 4049.00. Index 7: bar (50, 61, 50, 60). The target 60 is touched
  (high 61): TARGET at 60.00, proceeds 19 * 60.00 - 1.00 = 1139.00, available 5188.00.
- The same close (index 7) is a fresh decision: SMA3 = (50 + 50 + 60) / 3 = 53.3333 < close 60, so the condition is TRUE and
  the instrument is no longer held. True ranges of indices 5, 6, 7 are 2, 2, 11 (high - low = 11, |61 - 50| = 11), so ATR3 =
  15 / 3 = 5. Cap = floor(5188.00 / 5) = 1037.60. This is reserved at the close, not filled at it.
- Next open (index 8) is 58.00: 17 shares (986.00 + 1.00 = 987.00 <= 1037.60; 18 shares 1044.00 + 1.00 > 1037.60). Levels from
  the signal-session ATR 5: stop 58 - 10 = 48, target 58 + 25 = 83. Available 5188.00 - 987.00 = 4201.00.
"""
    return rc("X-10", "Exit, then a fresh close signal, then re-entry at the next open",
              ["Entry and exit phases", "Cash and quantities"], rows, make_policy(fixed="1.00", bps="0"),
              notes="Ten sessions. The first position hits its target during index 7; the close of index 7 produces a "
                    "new entry decision that uses the cash from the exit; the new position is filled at the open of "
                    "index 8 at 58.00, which differs from both the exit price and the signal close.",
              hand=hand, hand_text=txt, focus=[D[7]])


def make_x11():
    rows = HEAD50 + [(50, 53, 45, 52), FL(51), FL(51)]
    hand = {
        "entries.0.cap": ("1000.00", "cash at the first close: 5000.00 / 5"),
        "entries.0.quantity": ("19", "950.00 + 1.00 <= 1000.00"),
        "fills.1.reason": ("STOP", "newly filled position protected in its own session: low 45 <= 46"),
        "fills.1.price": ("46.00", "stop level"),
        "fills.1.cash_delta": ("873.00", "19 * 46.00 - 1.00"),
        "entries.1.cap": ("984.40", "floor((5000.00 - 951.00 + 873.00 = 4922.00) / 5)"),
        "entries.1.quantity": ("19", "19 * 51 + 1 = 970.00 <= 984.40; 20 shares 1021.00"),
        "daily.5.cash_reserved": ("984.40", "second reservation at the close of index 5"),
        "daily.5.equity": ("4922.00", "5000.00 - 2 * 1.00 fees - 19 * 4.00 loss = 4922.00"),
    }
    txt = """
- Signal at index 4: cap floor(5000.00 / 5) = 1000.00, frozen at the close. Open 50.00: 19 shares (950.00 + 1.00). The opening
  entry is sized from this cap alone: it cannot use cash from the exit that happens later in the same session.
- Index 5 bar (50, 53, 45, 52): the new position is protected during its own session; low 45 <= stop 46 and high 53 < target
  60, so STOP at 46.00 with proceeds 19 * 46.00 - 1.00 = 873.00. Available 4049.00 + 873.00 = 4922.00.
- The close of index 5 is a fresh decision (SMA3 = (50 + 51 + 52) / 3 = 51 < 52; true ranges 2, 2, 8 give ATR3 = 4). The new
  cap uses the cash available at that close: floor(4922.00 / 5) = 984.40. Next open 51.00: 19 shares cost 969.00 + 1.00 = 970.00.
"""
    return rc("X-11", "An intraday exit does not fund an opening entry; the next cap uses the cash at the next close",
              ["Entry and exit phases", "Cash and quantities"], rows, make_policy(fixed="1.00", bps="0"),
              notes="Eight sessions. The opening entry is filled with the cap frozen at the previous close; the "
                    "position is stopped out intraday in the same session; the proceeds first appear in the cash "
                    "that the next close reserves.", hand=hand, hand_text=txt, focus=[D[4], D[5]])


# Off-grid levels. In X-01 to X-11 every stop and target is on the price grid, so the rounding of a touched level was never
# pinned. Here the signal bar's true range is chosen so that ATR3 has no finite decimal form (the true-range sum is not a
# multiple of 3 cents): stop = entry - 2 * ATR3 and target = entry + 5 * ATR3 then fall between two grid prices. The
# position keeps the exact level (a bar that stops short of it does not touch it); a touched level fills at the level
# floored to the price scale (declared policy: sale levels round down; OQ-02 section 2.5 fills at the level).


def make_x12():
    rows = [FL(50)] * 4 + [(50, "52.2", "49.5", 51), FL(50), (50, "61.16", "49.5", 60), (60, "61.17", 59, 61)]
    hand = {
        "entries.0.quantity": ("19", "950.00 + 1.95 = 951.95 <= 1000.00; 20 shares 1000.00 + 2.00 > 1000.00"),
        "fills.1.session": (D[7], "index 7: the bar of index 6 stops 0.0067 short of the target"),
        "fills.1.reason": ("TARGET", "high 61.17 >= 367/6"),
        "fills.1.price": ("61.16", "floor(367/6) = floor(61.1666...) to the price scale 2"),
        "fills.1.notional": ("1162.04", "19 * 61.16"),
        "fills.1.fee": ("2.17", "ceil(1.00 + 1162.04 * 10 / 10000) = ceil(2.16204)"),
        "fills.1.cash_delta": ("1159.87", "1162.04 - 2.17"),
        "trades.0.exit_price": ("61.16", "the exit price"),
        "final.cash_available": ("5207.92", "4048.05 + 1159.87"),
        "final.equity": ("5207.92", "nothing held"),
    }
    txt = """
- Signal at index 4 (2026-01-09): close 51 > SMA3 = (50 + 50 + 51) / 3 = 151/3. True ranges of indices 2, 3, 4: 2, 2 and
  max(52.2 - 49.5, 52.2 - 50, 50 - 49.5) = max(2.7, 2.2, 0.5) = 2.7, sum 6.7, so ATR3 = 6.7 / 3 = 67/30 = 2.2333..., which has
  no finite decimal form.
- Entry as X-01: cap floor(5000.00 / 5) = 1000.00, open 50.00, 19 shares, fee 1.95, available 4048.05.
- Levels: stop = 50 - 2 * 67/30 = 683/15 = 45.5333...; target = 50 + 5 * 67/30 = 367/6 = 61.1666... Neither is a price on the grid
  of 0.01. The expectation does not state these two levels in the daily positions (no finite decimal form); it states the fills.
- Index 6 (50, 61.16, 49.5, 60): high 61.16 < 367/6 = 61.1666..., so the target is not touched. A level rounded to the grid
  before the test (floor 61.16) would be touched here, so the exact level is what is compared.
- Index 7 (60, 61.17, 59, 61): open 60 is below the target (no gap), low 59 is above the stop, high 61.17 >= 61.1666...: TARGET.
  The fill is at the level, floored to the price scale: floor(61.1666...) = 61.16. Rounding to nearest or up would give 61.17.
  Notional 19 * 61.16 = 1162.04. Fee = ceil(1.00 + 1162.04 * 10 / 10000) = ceil(1.00 + 1.16204) = 2.17. Proceeds 1162.04 - 2.17 =
  1159.87. Available 4048.05 + 1159.87 = 5207.92. The policy's 100 bps of slippage applies to a gap through a stop only, so it
  is not applied to this intraday fill.
- Index 7 is the last session: no next open, so the close creates no entry intent.
"""
    return rc("X-12", "Intraday target touch at an off-grid level fills at the level floored to the price scale",
              ["Entry and exit phases", "Cash and quantities"], rows, make_policy(fixed="1.00", bps="10", slip="100"),
              notes="Eight sessions. ATR3 is 67/30 at the signal, so the target is 367/6 = 61.1666... and the stop 683/15. "
                    "One bar falls 0.0067 short of the target and is not a touch; the next bar touches it and the "
                    "fill is the target floored to the price scale, 61.16 (a nearest or upward rounding would give 61.17).",
              hand=hand, hand_text=txt, focus=[D[4]])


def make_x13():
    rows = [FL(50)] * 4 + [(50, 52, "49.6", 51), FL(50), (63, 64, 50, 50), FL(50), FL(50)]
    hand = {
        "entries.0.quantity": ("19", "950.00 + 1.95 = 951.95 <= 1000.00; 20 shares 1000.00 + 2.00 > 1000.00"),
        "fills.1.session": (D[6], "index 6: the open gaps above the target"),
        "fills.1.reason": ("GAP_TARGET", "open 63 >= 182/3"),
        "fills.1.price": ("60.66", "floor(182/3) = floor(60.6666...) to the price scale 2; not the open 63, no slippage"),
        "fills.1.notional": ("1152.54", "19 * 60.66"),
        "fills.1.fee": ("2.16", "ceil(1.00 + 1152.54 * 10 / 10000) = ceil(2.15254)"),
        "fills.1.cash_delta": ("1150.38", "1152.54 - 2.16"),
        "trades.0.exit_price": ("60.66", "the exit price"),
        "final.cash_available": ("5198.43", "4048.05 + 1150.38"),
    }
    txt = """
- Signal at index 4: close 51 > SMA3 = 151/3. True ranges of indices 2, 3, 4: 2, 2 and max(52 - 49.6, 52 - 50, 50 - 49.6) =
  max(2.4, 2.0, 0.4) = 2.4, sum 6.4, so ATR3 = 6.4 / 3 = 32/15 = 2.1333...
- Entry as X-01: 19 shares at 50.00, fee 1.95, available 4048.05.
- Levels: stop = 50 - 2 * 32/15 = 686/15 = 45.7333...; target = 50 + 5 * 32/15 = 182/3 = 60.6666...
- Index 6 opens at 63, which is above the target 182/3: gap above the target. Per OQ-02 section 2.5 the fill is at the target
  level before costs, not at the open and not with the 100 bps gap slippage of the policy. The level is not on the price grid, so it is
  floored to the price scale: floor(60.6666...) = 60.66 (rounding to nearest or up would give 60.67). Notional 19 * 60.66 = 1152.54.
  Fee = ceil(1.00 + 1152.54 * 10 / 10000) = ceil(1.00 + 1.15254) = 2.16. Proceeds 1152.54 - 2.16 = 1150.38. Available 4048.05 +
  1150.38 = 5198.43.
- The bar closes at 50 (below SMA3), so no new signal arises.
"""
    return rc("X-13", "Gap above an off-grid target fills at the target floored to the price scale, without slippage",
              ["Entry and exit phases", "Cash and quantities"], rows, make_policy(fixed="1.00", bps="10", slip="100"),
              notes="Nine sessions. ATR3 is 32/15 at the signal, so the target is 182/3 = 60.6666... The next bar opens "
                    "at 63. The exit is a gap exit at the target level, floored to the price scale (60.66), before costs "
                    "and without the slippage that the policy declares for gaps through a stop.",
              hand=hand, hand_text=txt, focus=[D[4]])


def make_x14():
    rows = [FL(50)] * 4 + [(50, 52, "49.5", 51), FL(50), (50, 51, "45.67", 48), (48, 49, "45.66", 47), FL(47)]
    hand = {
        "entries.0.quantity": ("19", "950.00 + 1.95 = 951.95 <= 1000.00; 20 shares 1000.00 + 2.00 > 1000.00"),
        "fills.1.session": (D[7], "index 7: the bar of index 6 stops 0.0033 above the stop"),
        "fills.1.reason": ("STOP", "low 45.66 <= 137/3"),
        "fills.1.price": ("45.66", "floor(137/3) = floor(45.6666...) to the price scale 2"),
        "fills.1.notional": ("867.54", "19 * 45.66"),
        "fills.1.fee": ("1.87", "ceil(1.00 + 867.54 * 10 / 10000) = ceil(1.86754)"),
        "fills.1.cash_delta": ("865.67", "867.54 - 1.87"),
        "trades.0.exit_price": ("45.66", "the exit price"),
        "final.cash_available": ("4913.72", "4048.05 + 865.67"),
    }
    txt = """
- Signal at index 4: close 51 > SMA3 = 151/3. True ranges of indices 2, 3, 4: 2, 2 and max(52 - 49.5, 52 - 50, 50 - 49.5) =
  max(2.5, 2.0, 0.5) = 2.5, sum 6.5, so ATR3 = 6.5 / 3 = 13/6 = 2.1666...
- Entry as X-01: 19 shares at 50.00, fee 1.95, available 4048.05.
- Levels: stop = 50 - 2 * 13/6 = 137/3 = 45.6666...; target = 50 + 5 * 13/6 = 365/6 = 60.8333...
- Index 6 (50, 51, 45.67, 48): low 45.67 > 137/3 = 45.6666..., so the stop is not touched. A level rounded to nearest before the
  test (45.67) would be touched here, so the exact level is what is compared. High 51 is far below the target.
- Index 7 (48, 49, 45.66, 47): open 48 is above the stop (no gap), low 45.66 <= 45.6666...: STOP. The fill is at the level, floored
  to the price scale: floor(45.6666...) = 45.66 (rounding to nearest or up would give 45.67). Notional 19 * 45.66 = 867.54. Fee =
  ceil(1.00 + 867.54 * 10 / 10000) = ceil(1.00 + 0.86754) = 1.87. Proceeds 867.54 - 1.87 = 865.67. Available 4048.05 + 865.67 =
  4913.72. The high 49 does not touch the target, so the bar is not ambiguous. No slippage applies to an intraday fill.
- Later closes (48, 47, 47) stay below their SMA3, so no new signal arises.
"""
    return rc("X-14", "Intraday stop touch at an off-grid level fills at the level floored to the price scale",
              ["Entry and exit phases", "Cash and quantities"], rows, make_policy(fixed="1.00", bps="10", slip="100"),
              notes="Nine sessions. ATR3 is 13/6 at the signal, so the stop is 137/3 = 45.6666... and the target 365/6. "
                    "One bar stays 0.0033 above the stop and is not a touch; the next bar touches it and the fill is "
                    "the stop floored to the price scale, 45.66 (a nearest or upward rounding would give 45.67).",
              hand=hand, hand_text=txt, focus=[D[4]])


# ---------------------------------------------------------------- corporate-action cases (ATR 4 at price 100)

Z = {"fixed": "0", "bps": "0"}          # zero-cost policy used to reproduce the OQ-06 numbers
H100 = [FL(100, 4)] * 4 + [(100, 103, 99, 101)]


def make_c01a():
    rows = H100 + [FL(100, 4), (100, 104, 99, 102), (51, 52, "50.5", "51.5"), ("51.5", "52.5", 51, 52)]
    hand = {
        "entries.0.quantity": ("10", "cap 1000.00 / 100.00, zero costs"),
        "daily.6.positions.0.quantity": ("10", "before the split"),
        "daily.6.positions.0.entry_price": ("100", "fill at the open"),
        "daily.6.positions.0.stop": ("92", "100 - 2 * 4"),
        "daily.6.positions.0.target": ("120", "100 + 5 * 4"),
        "daily.6.positions.0.snapshots.0.value": ("4", "ATR at the signal session"),
        "daily.6.positions.0.scheduled_stop.level": ("100", "break-even level, trigger high 104 >= 100 + 4"),
        "daily.6.positions.0.scheduled_stop.effective_session": (D[7], "next session = the ex-date"),
        "daily.7.positions.0.quantity": ("20", "10 * 2"),
        "daily.7.positions.0.entry_price": ("50", "100 / 2"),
        "daily.7.positions.0.stop": ("50", "scheduled 100 / 2, activated after the split on the new basis"),
        "daily.7.positions.0.target": ("60", "120 / 2"),
        "daily.7.positions.0.snapshots.0.value": ("2", "4 / 2"),
        "corporate_actions.0.applied_at.phase": ("BEFORE_OPEN", "applied once at the ex-date"),
        "daily.7.equity": ("5030.00", "4000.00 + 20 * 51.50"),
    }
    txt = """
- Index 4 signal: SMA3 = (100 + 100 + 101) / 3 = 100.3333 < 101, ATR3 = (4 + 4 + 4) / 3 = 4. Cap = 5000.00 / 5 = 1000.00. Zero
  costs, lot 1: open 100.00 buys 1000.00 / 100.00 = 10 shares. Stop 100 - 2 * 4 = 92, target 100 + 5 * 4 = 120.
- Index 6 bar high 104 >= entry 100 + ATR 4: break-even fires at the close; the scheduled stop 100 is effective at index 7. The
  daily record of index 6 shows quantity 10, entry 100, stop 92, target 120, ATR 4, scheduled stop 100 (effective 2026-01-14).
- Index 7 BEFORE_OPEN, 2-for-1 split (r = 2, applied exactly once): quantity 10 * 2 = 20, entry 100 / 2 = 50, ATR 4 / 2 = 2,
  stop 92 / 2 = 46, target 120 / 2 = 60, scheduled stop 100 / 2 = 50. The scheduled stop then activates on the new basis, so
  the active stop of index 7 is 50 (the converted original stop 46 is replaced). C-01c shows the same conversion with the
  stop 46 and the scheduled stop 50 visible together.
- Raw bar index 7 (51, 52, 50.5, 51.5): open 51 > stop 50 (no gap), low 50.5 > 50, high 52 < 60. Close 51.5: positions
  20 * 51.50 = 1030.00, equity 4000.00 + 1030.00 = 5030.00.
"""
    return rc("C-01a", "2-for-1 split on a held position with a scheduled stop (10 sh @ 100 become 20 sh @ 50)",
              ["Split across an ex-date"], rows, make_policy(**Z), skw={"break_even": True},
              actions=[split_action("SPLIT-2-1", D[7], 2, 1)],
              notes="Nine sessions at ATR 4, zero costs, whole lots. The position (10 shares at 100, stop 92, target 120, "
                    "ATR 4) schedules its break-even stop 100 at the close of index 6; a 2-for-1 split is effective at "
                    "the next session. All quantities, prices, snapshots and the scheduled level convert once.",
              hand=hand, hand_text=txt, focus=[D[4]])


def make_c01c():
    rows = H100 + [FL(100, 4), (100, 103, 99, 101), (51, "52.5", "50.5", "51.5"), ("51.5", 52, 51, "51.5")]
    hand = {
        "daily.6.positions.0.stop": ("92", "no trigger yet: high 103 < 104"),
        "daily.7.positions.0.quantity": ("20", "10 * 2"),
        "daily.7.positions.0.entry_price": ("50", "100 / 2"),
        "daily.7.positions.0.stop": ("46", "92 / 2"),
        "daily.7.positions.0.target": ("60", "120 / 2"),
        "daily.7.positions.0.snapshots.0.value": ("2", "4 / 2"),
        "daily.7.positions.0.scheduled_stop.level": ("50", "trigger on the raw post-split bar: high 52.5 >= 50 + 2"),
        "daily.7.positions.0.scheduled_stop.effective_session": (D[8], "next session"),
    }
    txt = """
- Same entry as C-01a: 10 shares at 100, stop 92, target 120, ATR 4. Index 6 high is 103 < 104, so nothing is scheduled.
- Index 7 BEFORE_OPEN, 2-for-1 split: 20 shares, entry 50, ATR 2, stop 92 / 2 = 46, target 120 / 2 = 60. No scheduled stop exists
  to convert, so the active stop stays 46.
- Index 7 raw bar (51, 52.5, 50.5, 51.5): high 52.5 >= entry 50 + ATR 2 = 52: break-even fires on the post-split basis at the close;
  the scheduled stop is the new entry price 50, effective index 8. The record of index 7 shows quantity 20, entry 50, stop
  46, target 60, ATR 2 and scheduled stop 50 together, the combination stated in OQ-06.
"""
    return rc("C-01c", "2-for-1 split: stop 46, target 60, ATR 2 and scheduled stop 50 visible together",
              ["Split across an ex-date"], rows, make_policy(**Z), skw={"break_even": True},
              actions=[split_action("SPLIT-2-1", D[7], 2, 1)],
              notes="Nine sessions. As C-01a, but the break-even trigger fires on the ex-date bar (post-split basis), "
                    "so the converted stop 46 and target 60 are visible next to the new scheduled stop 50.",
              hand=hand, hand_text=txt, focus=[D[4]])


def make_c01b():
    rows = H100 + [(50, 52, 48, 50)] * 3
    hand = {
        "entries.0.rank": ("1", "frozen rank"),
        "entries.0.cap": ("1000.00", "frozen cap"),
        "entries.0.quantity": ("20", "1000.00 / raw open 50.00, zero costs"),
        "fills.0.price": ("50.00", "raw open on the post-split basis"),
        "daily.4.cash_reserved": ("1000.00", "reserved at the signal close"),
        "daily.5.positions.0.snapshots.0.value": ("2", "signal ATR 4 / 2"),
        "daily.5.positions.0.stop": ("46", "50 - 2 * 2"),
        "daily.5.positions.0.target": ("60", "50 + 5 * 2"),
        "daily.5.equity": ("5000.00", "4000.00 + 20 * 50.00"),
    }
    txt = """
- Index 4 signal: ATR3 = 4, rank 1, cap = floor(5000.00 / 5) = 1000.00 (reserved: available 4000.00, reserved 1000.00).
- Index 5 is the ex-date of a 2-for-1 split. BEFORE_OPEN converts the pending snapshot: entry_ATR 4 / 2 = 2; the cap 1000.00 and
  the rank 1 are unchanged.
- Raw open 50.00: with zero costs and lot 1, 1000.00 / 50.00 = 20 shares. Levels from the converted snapshot: stop 50 - 2 * 2 =
  46, target 50 + 5 * 2 = 60. Equity at the close (50): 4000.00 + 20 * 50.00 = 5000.00.
"""
    return rc("C-01b", "Split on a pending entry: cap 1000 buys 20 shares at raw open 50, ATR 4 becomes 2",
              ["Split across an ex-date"], rows, make_policy(**Z), actions=[split_action("SPLIT-2-1", D[5], 2, 1)],
              notes="Eight sessions. The close of index 4 reserves 1000.00; the 2-for-1 split is effective at index 5, "
                    "before the intended fill. The entry is sized from the frozen cap at the new raw open.",
              hand=hand, hand_text=txt, focus=[D[4], D[5]])


def make_c02():
    rows = [FL(142, 4)] * 4 + [(142, 145, 141, 143), FL(142, 4), FL(142, 4), (95, 97, 93, 95), (95, 97, 93, 95)]
    return rc("C-02", "Fractional entitlement: 3-for-2 split on 7 shares is INSUFFICIENT",
              ["Split across an ex-date", "Invalid inputs"], rows, make_policy(fixed="1.00", bps="0"),
              actions=[split_action("SPLIT-3-2", D[7], 3, 2)], kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Nine sessions. The entry buys 7 shares at 142.00 (cap 1000.00: 994.00 + 1.00 = 995.00; 8 shares cost "
                    "1136.00 + 1.00). At the ex-date of a 3-for-2 split, 7 * 3 / 2 = 10.5 shares: a fractional "
                    "entitlement with no declared cash-in-lieu. The run stops at BEFORE_OPEN of the ex-date with "
                    "INSUFFICIENT FRACTIONAL_ENTITLEMENT; the action is not recorded as applied and the journal keeps "
                    "everything through the close of index 6.",
              hand={"fills.0.quantity": ("7", "7 * 142.00 + 1.00 = 995.00 <= 1000.00"),
                    "outcome.at.phase": ("BEFORE_OPEN", "the failing event")},
              hand_text="- Cap 1000.00, open 142.00, fee 1.00: 7 shares = 994.00 + 1.00 = 995.00 <= 1000.00; 8 shares = 1136.00 + "
                        "1.00 > 1000.00. The split multiplies 7 by 3/2 = 10.5, which is not a whole share, so the evidence is "
                        "insufficient; nothing is rounded.\n",
              focus=[D[4]])


def make_c03():
    rows = HEAD50 + [FL(50), (49, 50, 48, 49), (49, 50, 48, 49), (49, 50, 48, 49)]
    hand = {
        "daily.5.cash_available": ("4000.00", "5000.00 - 20 * 50.00"),
        "daily.6.receivables": ("20.00", "20 shares * 1.00"),
        "daily.6.cash_available": ("4000.00", "cash unchanged until payment"),
        "daily.6.positions_value": ("980.00", "20 * 49.00"),
        "daily.6.equity": ("5000.00", "4000.00 + 20.00 + 980.00 = the pre-ex-date equity"),
        "daily.6.positions.0.stop": ("46", "raw level unchanged"),
        "daily.6.positions.0.target": ("60", "raw level unchanged"),
        "daily.7.cash_available": ("4020.00", "paid at BEFORE_OPEN of index 7"),
        "daily.7.receivables": ("0.00", "paid"),
        "daily.7.equity": ("5000.00", "4020.00 + 980.00"),
        "cash_ledger.3.kind": ("DIVIDEND_RECEIVABLE", "ex-date"),
        "cash_ledger.3.amount": ("20.00", "receivable"),
        "cash_ledger.4.kind": ("DIVIDEND_PAYMENT", "payment"),
    }
    txt = """
- Entry: cap 1000.00, open 50.00, zero costs: 20 shares, available 4000.00, equity at the close 4000.00 + 20 * 50 = 5000.00. Stop 46,
  target 60.
- Index 6 is the ex-date of a 1.00 per share dividend (no withholding), payable at BEFORE_OPEN of index 7. Entitled quantity (held at
  the start of BEFORE_OPEN) 20: receivable = floor(20 * 1.00 * (1 - 0)) = 20.00. The raw price falls 50 to 49 (close 49). Equity at
  index 6: available 4000.00 + receivable 20.00 + 20 * 49.00 = 980.00 = 5000.00, unchanged. Available cash is still 4000.00.
- Index 7 BEFORE_OPEN pays the receivable: available 4020.00, receivable 0.00. Equity 4020.00 + 980.00 = 5000.00. Stop 46 and target
  60 never change (the dividend does not touch raw price levels or the quantity).
"""
    return rc("C-03", "Cash dividend: receivable 20 on the ex-date, equity unchanged, cash +20 at payment",
              ["Cash dividend"], rows, make_policy(**Z),
              actions=[dividend_action("DIV-1", D[6], "1.00", D[7], "BEFORE_OPEN")],
              notes="Nine sessions. 20 shares are held over the ex-date of a 1.00 dividend payable at the next BEFORE_OPEN; "
                    "the raw price moves from 50 to 49.", hand=hand, hand_text=txt, focus=[D[4]])


def make_c04():
    rows = HEAD50 + [FL(50)] * 4
    hand = {
        "fills.0.session": (D[5], "the entry fills at the open of the ex-date"),
        "daily.5.receivables": ("0.00", "an ex-date buyer is not entitled"),
        "final.receivables": ("0.00", "still none"),
        "final.cash_available": ("4000.00", "no dividend cash"),
    }
    txt = """
- The signal at index 4 reserves 1000.00; the entry fills at the OPEN of index 5, which is the ex-date of a 1.00 dividend. The
  entitled quantity is the quantity held at the start of BEFORE_OPEN of the ex-date: 0 (the entry fills later, at OPEN). Receivable =
  floor(0 * 1.00) = 0.00: no receivable and no ledger line. The action is still recorded as applied at BEFORE_OPEN of index 5.
- Available stays 4000.00 (5000.00 - 20 * 50.00) at every later close, equity 5000.00.
"""
    return rc("C-04", "Ex-date buyer receives no dividend entitlement",
              ["Cash dividend"], rows, make_policy(**Z),
              actions=[dividend_action("DIV-1", D[5], "1.00", D[6], "BEFORE_OPEN")],
              notes="Nine sessions (nine bars: indices 0 to 8). The intent from the close of index 4 fills at the open of the "
                    "ex-date, so the buyer holds nothing at the entitlement boundary.", hand=hand, hand_text=txt,
              focus=[D[4]], n_sessions=9)


C04_ROWS = HEAD50 + [FL(50), (50, 60, 49, 59), ("52.2", 54, 50, 52)]


def make_c04_timing(phase_case, pay_session, pay_phase, qty, cap, final_avail, why):
    rows = C04_ROWS
    hand = {
        "cash_ledger.3.kind": ("DIVIDEND_RECEIVABLE", "ex-date index 6"),
        "entries.1.cap": (cap, why),
        "entries.1.quantity": (str(qty), "largest whole share count with notional <= cap at open 52.20"),
        "final.cash_available": (final_avail, "see the chain below"),
    }
    txt_map = {
        "C-04a": """
- 20 shares bought at 50.00 (available 4000.00). Index 6 (ex-date, 1.00 per share, payment at BEFORE_OPEN of the same session,
  after the actions are applied): receivable 20.00 created and paid in the same event, available 4020.00. The bar (50, 60, 49, 59)
  touches the target 60 (high == target): TARGET at 60.00, +1200.00, available 5220.00. The close is a fresh signal (SMA3 =
  (51 + 50 + 59) / 3 = 53.3333; ATR3 = (2 + 2 + 11) / 3 = 5): cap = floor(5220.00 / 5) = 1044.00.
- Index 7 open 52.20: 20 shares cost 20 * 52.20 = 1044.00 <= 1044.00 (zero costs): quantity 20. Available 5220.00 - 1044.00 = 4176.00.
""",
        "C-04b": """
- Same bars as C-04a. The payment is due at OPEN of index 7. At the close of index 6 the receivable is still unpaid: available is
  4000.00 + 1200.00 = 5200.00, cap = floor(5200.00 / 5) = 1040.00 (the dividend is not cash yet). Reserved: available 4160.00.
- Index 7 OPEN: first the payment (start of the handler): available 4180.00, receivable 0. Then the entry from the frozen cap 1040.00:
  20 shares cost 1044.00 > 1040.00, so quantity 19 (19 * 52.20 = 991.80). The payment did not enlarge the frozen cap. Release 1040.00
  (5220.00), debit 991.80: available 4228.20.
""",
        "C-04c": """
- Same bars as C-04a. The payment is due at AFTER_CLOSE of index 6, applied at the start of that handler, before the close signal
  sizes its cap. Available before the close: 4000.00 + 1200.00 = 5200.00; payment +20.00 gives 5220.00; cap = floor(5220.00 / 5) = 1044.00.
- Index 7 open 52.20: 20 shares cost 1044.00 <= 1044.00: quantity 20. Available 5220.00 - 1044.00 = 4176.00. The paid dividend enlarged the
  cap computed at that close (compare C-04b, where the payment comes after the cap is frozen).
""",
    }
    notes = {
        "C-04a": "Payment at BEFORE_OPEN of the ex-date itself: the receivable is created and paid in one event.",
        "C-04b": "Payment at OPEN of the next session: after the close froze the cap, so the payment cannot enlarge it.",
        "C-04c": "Payment at AFTER_CLOSE of the ex-date: applied at the start of the handler, before the cap is computed.",
    }[phase_case]
    return rc(phase_case, "Dividend payment timing: %s of session %s" % (pay_phase, pay_session[-5:]),
              ["Cash dividend", "Cash and quantities"], rows, make_policy(**Z),
              actions=[dividend_action("DIV-1", D[6], "1.00", pay_session, pay_phase)],
              notes="Eight sessions. 20 shares are held over the ex-date (index 6), when the target is also hit and the "
                    "close raises a new entry signal. " + notes, hand=hand, hand_text=txt_map[phase_case],
              focus=[D[6]], dataset="c-04-timing-bars")


def make_c05():
    rows = H100 + [FL(100, 4), (100, 103, 99, 101), (51, 52, "50.5", "51.5"), ("51.5", "52.5", 51, 52)]
    hand = {
        "daily.6.receivables": ("0.00", "before the ex-date"),
        "daily.7.receivables": ("10.00", "10 pre-split shares * 1.00, not 20 post-split shares"),
        "daily.7.positions.0.quantity": ("20", "10 * 2"),
        "daily.7.cash_available": ("4000.00", "dividend unpaid"),
        "daily.7.equity": ("5040.00", "4000.00 + 10.00 + 20 * 51.50"),
        "daily.8.cash_available": ("4010.00", "paid at BEFORE_OPEN of index 8"),
        "corporate_actions.0.action_id": ("ACT-1-SPLIT", "input order"),
        "corporate_actions.1.action_id": ("ACT-2-DIV", "input order"),
    }
    txt = """
- 10 shares at 100.00 held (available 4000.00). Index 7 BEFORE_OPEN carries two actions on the same ex-date: the 2-for-1 split and a
  1.00 per share dividend. The dividend entitlement uses the quantity held at the start of BEFORE_OPEN, before the split: 10 shares *
  1.00 = 10.00 (not 20.00). After the split: 20 shares at 50, stop 46, target 60, ATR 2.
- Index 7 close 51.5: positions 20 * 51.50 = 1030.00, receivable 10.00, available 4000.00: equity 5040.00. Index 8 BEFORE_OPEN pays
  10.00: available 4010.00; close 52: equity 4010.00 + 1040.00 = 5050.00.
"""
    return rc("C-05", "Split and dividend on the same day: entitlement on the pre-split quantity",
              ["Split across an ex-date", "Cash dividend"], rows, make_policy(**Z),
              actions=[split_action("ACT-1-SPLIT", D[7], 2, 1),
                       dividend_action("ACT-2-DIV", D[7], "1.00", D[8], "BEFORE_OPEN")],
              notes="Nine sessions. A 2-for-1 split and a 1.00 dividend share the ex-date of index 7.", hand=hand,
              hand_text=txt, focus=[D[4]])


def make_c06():
    rows = HEAD50 + [FL(50)] * 4
    return rc("C-06", "Special distribution is an unsupported corporate action",
              ["Invalid inputs", "Unplanned non-trading events"], rows, make_policy(**P1),
              actions=[special_action("SD-1", D[6])], kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Nine sessions (bars for indices 0 to 8). The position bought at index 5 is held when a special "
                    "distribution becomes effective at index 6. Its semantics are not supported, so the run stops at "
                    "BEFORE_OPEN of index 6 with INSUFFICIENT UNSUPPORTED_CORPORATE_ACTION. The journal keeps everything "
                    "through the close of index 5 and nothing is invented or rounded.", focus=[D[4]], n_sessions=9)


def make_c07():
    def late(inp, strat):
        inp["instruments"][0]["corporate_actions"][0]["available_at"] = D[6] + "T14:31:00Z"
    rows = HEAD50 + [FL(50)] * 4
    return rc("C-07", "A split available after the session open is FUTURE_DATA",
              ["Invalid inputs", "Split across an ex-date"], rows, make_policy(**P1),
              actions=[split_action("SPLIT-2-1", D[6], 2, 1)], mutate=late, kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Nine sessions. A 2-for-1 split is effective at index 6 but its availability time is one minute "
                    "after that session's open (14:31 against 14:30). Applying it at BEFORE_OPEN would use data that "
                    "was not yet known, so the run fails with FAILED FUTURE_DATA at BEFORE_OPEN of index 6; the "
                    "journal keeps everything through the close of index 5.", focus=[D[4]], n_sessions=9)


# ---------------------------------------------------------------- invalid inputs and unplanned events


def make_i01():
    def late(inp, strat):
        inp["instruments"][0]["bars"][4]["available_at"] = D[5] + "T15:30:00Z"
    rows = HEAD50 + [FL(50)] * 3
    return rc("I-01", "Future data: a bar used by a decision becomes available after the next open",
              ["Invalid inputs"], rows, make_policy(**P1), mutate=late, kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Eight sessions as X-01, except that the bar of index 4 (the signal session) has available_at 15:30 on "
                    "the next day, one hour after the next open at 14:30. The decision at the close of index 4 would "
                    "use a bar that is not known before the intended fill, which would be a retroactive fill. The run "
                    "fails with FAILED FUTURE_DATA at AFTER_CLOSE of index 4 and keeps the journal through the close of "
                    "index 3 (signals and daily records for indices 0 to 3; no entry, no reservation).",
              focus=[D[3]])


def make_i02():
    rows = HEAD50 + [None, FL(50), FL(50)]
    return rc("I-02", "Missing required bar without a confirmed halt is INSUFFICIENT",
              ["Invalid inputs", "Unplanned non-trading events"], rows, make_policy(**P1), kind="partial",
              n_sessions=8, sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Eight calendar sessions; the bar of index 5 is absent and no unplanned event explains it. An absent bar "
                    "alone does not establish a non-trading session, so the run stops at BEFORE_OPEN of index 5 with "
                    "INSUFFICIENT MISSING_REQUIRED_BAR. The reservation made at the close of index 4 is part of the "
                    "partial journal (entry status RESERVED, ledger RESERVE 1000.00, cash reserved 1000.00 in the "
                    "daily record of index 4). Nothing is forward-filled and no price is invented.",
              focus=[D[4]])


def make_i03():
    rows = HEAD50 + [FL(50)] * 3
    return rc("I-03", "Invalid level: a non-positive stop fails the run without a fill",
              ["Invalid inputs"], rows, make_policy(**P1), skw={"stop_mult": 30}, kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Eight sessions as X-01 but the stop is entry - 30 * ATR. At the open of index 5 the entry price is 50.00 and "
                    "the signal ATR is 2, so the stop is 50 - 60 = -10, which violates 0 < stop < entry < target. The run "
                    "fails with FAILED INVALID_LEVEL at OPEN of index 5 before any fill: the journal keeps only the "
                    "reservation made at the close of index 4 (entry RESERVED, one RESERVE line) and no fill.",
              focus=[D[4]])


def make_i04a():
    def mut(inp, strat):
        strat["definition"]["indicators"][0]["expr"] = ex("ema", [bf("CLOSE")], window=3)
        inp["strategy_hash"] = sha(strat)
    rows = HEAD50 + [FL(50)] * 3
    return rc("I-04a", "Unsupported operator id is rejected before evaluation", ["Invalid inputs",
              "Definition execution"], rows, make_policy(**P1), mutate=mut, kind="reject",
              expect_outcome={"status": "FAILED", "code": "UNSUPPORTED_OPERATOR"},
              notes="The strategy is schema-valid: `operator:ema@1` matches the operator reference pattern. The operator set "
                    "daily-long-only-seed@1 has no exponential mean (and Wilder-style smoothing must not be hidden "
                    "under another identifier), so the shared validator rejects it with UNSUPPORTED_OPERATOR before any "
                    "bar is read. No journal is produced.")


def make_i04b():
    def mut(inp, strat):
        strat["definition"]["entry"]["condition"] = ex("gt", [bf("CLOSE"), ex("sma", [bf("VOLUME")], window=3)])
        inp["strategy_hash"] = sha(strat)
    rows = HEAD50 + [FL(50)] * 3
    return rc("I-04b", "Operator unit mismatch is rejected before evaluation", ["Invalid inputs",
              "Definition execution"], rows, make_policy(**P1), mutate=mut, kind="reject",
              expect_outcome={"status": "FAILED", "code": "OPERATOR_UNIT_MISMATCH"},
              notes="The strategy is schema-valid, but its entry condition compares a PRICE (the close) with a SHARES "
                    "quantity (a mean of volume). Comparison operands must carry the same unit, so the shared validator "
                    "rejects it with OPERATOR_UNIT_MISMATCH before evaluation. No journal is produced.")


def make_i05(suffix, title, code, mutate_fn, note):
    rows = HEAD50 + [FL(50)] * 3
    return rc("I-05" + suffix, title, ["Invalid inputs"], rows, make_policy(**P1), mutate=mutate_fn, kind="reject",
              expect_outcome={"status": "FAILED", "code": code}, notes=note)


def mut_scale(inp, strat):
    inp["instruments"][0]["bars"][2]["open"] = "50.001"


def mut_hl(inp, strat):
    inp["instruments"][0]["bars"][2]["high"] = "48.5"


def mut_cal(inp, strat):
    c = inp["calendar"]["sessions"]
    c[2], c[3] = c[3], c[2]


def make_i06():
    rows = HEAD50 + [None]
    return rc("I-06", "Confirmed halt: the pending entry expires at the open and its reservation is released",
              ["Unplanned non-trading events"], rows, make_policy(**P1), n_sessions=6,
              events=[halt_event("HALT-1", D[5])],
              hand={"entries.0.status": ("EXPIRED", "confirmed halt at the intended open"),
                    "entries.0.reason": ("EXPIRED_NON_TRADING", "non-trading session"),
                    "cash_ledger.1.kind": ("RELEASE", "reservation released"),
                    "cash_ledger.1.available_after": ("5000.00", "all cash available again"),
                    "final.equity": ("5000.00", "no position, no fee")},
              hand_text="- The signal at index 4 reserves floor(5000.00 / 5) = 1000.00 (available 4000.00). Index 5 is a confirmed halt "
                        "(available 13:30, before the 14:30 open): no bar is needed and none is supplied. At OPEN the intent expires "
                        "(EXPIRED, EXPIRED_NON_TRADING) and the reservation is released: available 5000.00, no fill, no fee. The session has "
                        "no signal (a non-trading instrument cannot create one) and a daily record with cash 5000.00 only.\n",
              notes="Six calendar sessions; index 5 is the last. A CONFIRMED_HALT effective at index 5 became available before its open "
                    "and there is no bar for index 5. The intent reserved at the close of index 4 cannot fill; it expires at the "
                    "intended opening phase and the reservation is released. The instrument stays in the run.",
              focus=[D[4]])


def make_i07():
    rows = HEAD50 + [FL(50), FL(50), FL(50), None, FL(50)]
    return rc("I-07", "Confirmed halt while holding: valuation is unsupported and the evidence is INSUFFICIENT",
              ["Unplanned non-trading events"], rows, make_policy(**P1), n_sessions=10,
              events=[halt_event("HALT-1", D[8])], kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Ten calendar sessions. The position bought at the open of index 5 is held when a CONFIRMED_HALT takes effect at "
                    "index 8 (no bar). There is no gap exit, touch test or close to value it with, and no liquidation price is "
                    "invented. The run stops at AFTER_CLOSE of index 8 with INSUFFICIENT UNSUPPORTED_VALUATION; the "
                    "journal keeps everything through the close of index 7, including the open position's fill.",
              focus=[D[4]])


def make_i08():
    def mut(inp, strat):
        other = copy.deepcopy(strat)
        other["version"] = 2
        inp["strategy_hash"] = sha(other)
    rows = HEAD50 + [FL(50)] * 3
    return rc("I-08", "Hash mismatch between input and strategy", ["Invalid inputs", "Shared payloads"], rows,
              make_policy(**P1), mutate=mut, kind="reject",
              expect_outcome={"status": "FAILED", "code": "IDENTITY_MISMATCH"},
              notes="The input binds the hash of a different strategy artefact (the same artefact with version 2). The strategy "
                    "file's own hash differs, so the identity check fails with IDENTITY_MISMATCH before any evaluation.")


def make_i09():
    rows = HEAD50 + [FL(50)]
    return rc("I-09", "A bar supplied for a session with a confirmed halt is contradictory input",
              ["Unplanned non-trading events", "Invalid inputs"], rows, make_policy(**P1), n_sessions=6,
              events=[halt_event("HALT-1", D[5])], kind="reject",
              expect_outcome={"status": "FAILED", "code": "INVALID_INPUT"},
              notes="Six calendar sessions. A CONFIRMED_HALT effective at index 5 became available at 13:30, before the 14:30 open, "
                    "so the instrument is known to be non-trading for that session. The input nevertheless supplies a bar for "
                    "index 5. A confirmed non-trading instrument can create no signal and no fill, and evidence that a bar "
                    "exists contradicts the halt. The input is rejected as INVALID_INPUT before any evaluation; no session "
                    "is processed and no journal is produced. (A halt that became available after the open does not confirm "
                    "the halt and is not contradicted by a bar.)")


def make_i10():
    def mut(inp, strat):
        inp["windows"]["information_cutoff"] = D[7] + "T22:00:00Z"
        inp["instruments"][0]["bars"][7]["available_at"] = D[7] + "T22:30:00Z"
    rows = HEAD50 + [FL(50)] * 3
    return rc("I-10", "Final-session bar available after the information cutoff is FUTURE_DATA",
              ["Invalid inputs"], rows, make_policy(**P1), mutate=mut, kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Eight sessions as X-01. The information cutoff is 22:00 on the last session (index 7) and the bar of that "
                    "session becomes available at 22:30, thirty minutes after the cutoff. There is no next session, so no "
                    "next open bounds the decision: the cutoff is the only deadline, and it must still apply. The close "
                    "mark and the final valuation would use data that was not available at the cutoff, so the run fails "
                    "with FAILED FUTURE_DATA at AFTER_CLOSE of index 7 and keeps the journal through the close of index 6 "
                    "(the position bought at the open of index 5 is open and valued at its index 6 close).",
              focus=[D[4]])


def make_i11():
    def mut(inp, strat):
        inp["windows"]["information_cutoff"] = D[4] + "T21:30:00Z"
        inp["instruments"][0]["bars"][4]["available_at"] = D[4] + "T22:00:00Z"
    rows = HEAD50 + [FL(50)] * 3
    return rc("I-11", "An information cutoff before the next open binds the decision",
              ["Invalid inputs"], rows, make_policy(**P1), mutate=mut, kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Eight sessions as X-01. The bar of index 4 (the signal session) becomes available at 22:00 on its own day, "
                    "well before the next open (14:30 on the next day), so a deadline of the next open alone would accept it. "
                    "The information cutoff is 21:30 on that day, earlier than the bar's availability. The deadline of a "
                    "decision is the earlier of the next open and the cutoff, so the run fails with FAILED FUTURE_DATA at "
                    "AFTER_CLOSE of index 4 and keeps the journal through the close of index 3.",
              focus=[D[3]])


def make_c08():
    def mut(inp, strat):
        inp["windows"]["information_cutoff"] = D[5] + "T22:00:00Z"
        inp["instruments"][0]["corporate_actions"][0]["available_at"] = D[5] + "T23:00:00Z"
    rows = HEAD50 + [FL(50)] * 4
    return rc("C-08", "A split available after the information cutoff is FUTURE_DATA even before its open",
              ["Invalid inputs", "Split across an ex-date"], rows, make_policy(**P1),
              actions=[split_action("SPLIT-2-1", D[6], 2, 1)], mutate=mut, kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes="Nine sessions. A 2-for-1 split is effective at index 6 and becomes available at 23:00 on the previous day, "
                    "before that session's open, so the open alone would accept it. The information cutoff is 22:00 on "
                    "that previous day, one hour earlier. The deadline for an action is the earlier of the session open and "
                    "the cutoff, so the split is future data: the run fails with FAILED FUTURE_DATA at BEFORE_OPEN of index "
                    "6 and keeps the journal through the close of index 5.", focus=[D[4]], n_sessions=9)


# ---------------------------------------------------------------- local replay (R-01)


def make_r01():
    rows = (H100 + [FL(100, 4), (100, 104, 99, 102), (101, 102, "99.5", "100.5"), FL(100, 4), FL(100, 4), FL(100, 4),
                    (100, 103, 99, 101), FL(100, 4), (100, 121, 99, 105), (52, 54, 51, 53), (53, 55, 52, 54),
                    (54, 57, 53, 56), (56, 58, 54, 57), (57, 58, 55, 56), (56, 57, 55, 56)])
    pol = make_policy(fixed="1.00", bps="10", slip="50", wh="1000")
    return rc("R-01", "Rich replay: three trades, a break-even stop, a 2-for-1 split on a pending entry and a taxed dividend",
              ["Local replay", "Split across an ex-date", "Cash dividend", "Entry and exit phases", "Shared payloads"],
              rows, pol, capital="10000.00", skw={"break_even": True},
              actions=[split_action("SPLIT-2-1", D[14], 2, 1),
                       dividend_action("DIV-1", D[17], "0.333", D[18], "OPEN")],
              notes="Twenty sessions with costs 1.00 fixed + 10 bps, 50 bps gap slippage and 10 percent dividend withholding. "
                    "Trade 1 (index 5) schedules a break-even stop at the close of index 6 and is stopped at the entry price "
                    "at index 7. Trade 2 (index 12) hits its target at index 13, whose close raises a new entry (ATR 10) that is "
                    "pending across the 2-for-1 split of index 14: the snapshot becomes 5, the cap and rank stay fixed, the "
                    "raw open is 52.00 and trade 3 is sized from the cap. Trade 3 fires its break-even rule at the close of "
                    "index 16 (scheduled stop effective at index 17), goes ex-dividend at index 17 (0.333 per share, "
                    "withholding 1000 bps, floor to cents, payable at OPEN of index 18) and stays open at the end. The "
                    "replay harness restores from every cut point, including cuts inside the pending-entry window, "
                    "with a scheduled stop, with a receivable outstanding and after the split was applied at BEFORE_OPEN, "
                    "and compares the result to this uninterrupted derivation.",
              hand=R01_HAND, hand_text=R01_TEXT,
              focus=[D[13], D[14], D[16], D[17]], policy_text="withholding 1000 bps = 10 percent.")


R01_HAND = {
    "entries.0.cap": ("2000.00", "floor(10000.00 / 5)"),
    "entries.0.quantity": ("19", "19 * 100 + ceil(1.00 + 1.90) = 1902.90 <= 2000.00; 20 shares 2000.00 + 3.00 > 2000.00"),
    "fills.1.reason": ("STOP", "break-even stop 100 touched at index 7"),
    "fills.1.cash_delta": ("1897.10", "1900.00 - ceil(1.00 + 1.90) = 1900.00 - 2.90"),
    "entries.1.cap": ("1998.84", "floor(9994.20 / 5)"),
    "fills.3.reason": ("TARGET", "high 121 >= 120 at index 13"),
    "fills.3.cash_delta": ("2276.72", "2280.00 - ceil(1.00 + 2.28) = 2280.00 - 3.28"),
    "entries.2.cap": ("2073.60", "floor(10368.02 / 5), frozen across the split"),
    "entries.2.quantity": ("39", "39 * 52.00 + ceil(1.00 + 2.028) = 2031.03 <= 2073.60; 40 shares 2080.00 > 2073.60"),
    "fills.4.cash_delta": ("-2031.03", "-(2028.00 + 3.03)"),
    "daily.14.positions.0.snapshots.0.value": ("5", "signal ATR 10 / 2"),
    "daily.14.positions.0.stop": ("42", "52 - 2 * 5"),
    "daily.14.positions.0.target": ("77", "52 + 5 * 5"),
    "daily.16.positions.0.scheduled_stop.level": ("52", "break-even at the close of index 16"),
    "daily.17.receivables": ("11.68", "floor(39 * 0.333 * 0.9) = floor(11.6883)"),
    "daily.17.positions.0.stop": ("52", "scheduled stop activated at BEFORE_OPEN of index 17"),
    "daily.18.cash_available": ("8348.67", "8336.99 + 11.68 paid at OPEN of index 18"),
    "final.equity": ("10532.67", "8348.67 + 39 * 56.00"),
}

R01_TEXT = """
Trade 1. Signal at index 4: ATR 4, cap = floor(10000.00 / 5) = 2000.00. Open 100.00, fee(n) = ceil(1.00 + n * 10/10000): 20 shares cost
2000.00 + 3.00 > 2000.00; 19 shares cost 1900.00 + ceil(2.90) = 1902.90. Cash 8097.10. Index 6 high 104 >= 100 + 4: scheduled stop 100,
effective index 7. Index 7 opens at 101 (above 100), low 99.50 touches 100: STOP at 100.00, proceeds 1900.00 - 2.90 = 1897.10, cash 9994.20.

Trade 2. Signal at index 11: cap = floor(9994.20 / 5) = 1998.84; 19 shares again (1902.90). Cash 8091.30. Index 13 high 121 >= 120: TARGET
at 120.00, proceeds 2280.00 - ceil(1.00 + 2.28) = 2276.72, cash 10368.02. The close of index 13 is a new signal (SMA3 = (101 + 100 + 105) / 3 = 102
< 105; true ranges 4, 4, 22 give ATR 10): cap = floor(10368.02 / 5) = floor(2073.604) = 2073.60.

Trade 3. Index 14 is the ex-date of a 2-for-1 split: the pending snapshot becomes 10 / 2 = 5; cap 2073.60 and rank 1 are unchanged. Raw
open 52.00: 39 shares (2028.00 + ceil(1.00 + 2.028) = 2031.03 <= 2073.60; 40 shares 2080.00 > cap). Stop 52 - 10 = 42, target 52 + 25 = 77.
Cash 10368.02 - 2031.03 = 8336.99. Index 16 high 57 >= 52 + 5: scheduled stop 52, effective index 17. Index 17 is ex-dividend 0.333 per
share with 10 percent withholding: receivable floor(39 * 0.333 * 0.9) = floor(11.6883) = 11.68, paid at OPEN of index 18: cash 8348.67. The
position stays open: 39 * 56.00 = 2184.00, final equity 10532.67.
"""


# ---------------------------------------------------------------- grid ties (G-xx)
#
# A grid tie is a stop, target, trigger, signal comparison or split-converted level whose exact value is a price on the
# grid although an intermediate value has no finite decimal form (ATR3 = x / 3, SMA3 = sum / 3, a level divided by a
# split ratio). Every comparison and every fill below uses the exact value: the oracle never rounds an intermediate.
# A computation that rounds the intermediate to finitely many digits lands one unit of its last digit away from the
# grid price, below or above it according to the repeating digit (0.2233... rounds down, 0.2266... rounds up), and can
# then decide a touch, a gap, a trigger or a level check the wrong way, or floor a fill to the grid price below.
# A comparison is only misjudged in one of the two directions: a target test (high >= level) misses when the rounded
# level lies above the exact one and fills one tick low when it lies below; a stop test (low <= level) misses when the
# rounded level lies below the exact one. The families therefore have a case per direction.

G_POLICY = make_policy(fixed="1.00", bps="0", slip="100")
G_ZERO = make_policy(fixed="0", bps="0", slip="100")


def P(v):
    """A price with exactly two decimals."""
    return fmt(F(v), 2)


def trunc4(v):
    """The first four decimals of a non-terminating value, followed by an ellipsis."""
    return fmt(floor_to(v, 4), 4) + "..."


def g_head(x):
    """Rows 0 to 4. Four flat bars (5, 5.10, 4.90, 5) of true range 0.20 and a signal bar (5, high, 4.90, 5.05) whose true
    range makes the three true ranges of indices 2, 3, 4 add up to exactly x, so that ATR3 = x / 3."""
    a = F(x) - F(1, 2)
    assert a >= 0 and (a * 100).denominator == 1
    return [FL(5, "0.2")] * 4 + [(5, 5 + a, "4.9", "5.05")]


def g_dir(x):
    """Where ATR3 = x / 3 falls when rounded to finitely many digits: below its exact value when the cent remainder of
    x / 3 is 1 (0.2233...), above it when the remainder is 2 (0.2266...)."""
    r = int(F(x) * 100) % 3
    assert r in (1, 2)
    return "below" if r == 1 else "above"


def g_steps_1_4(x):
    """Numbered steps 1 to 4 shared by G-01 to G-06b: the ATR3 window, the signal, the entry and the two exact levels."""
    x = F(x)
    a = x - F(1, 2)
    hi, tr4, s, t = 5 + a, a + F(1, 10), 5 - x, 5 + x
    d = g_dir(x)
    return (
        f"1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (5, 5.10, 4.90, 5) after a close of 5: max(0.20, 0.10, 0.10) = "
        f"0.20 each. Index 4 is (5, {P(hi)}, 4.90, 5.05) after a close of 5: max({P(hi)} - 4.90, {P(hi)} - 5, 5 - 4.90) = "
        f"max({P(tr4)}, {P(a)}, 0.10) = {P(tr4)}. The sum is 0.20 + 0.20 + {P(tr4)} = {P(x)}.\n"
        f"2. ATR3 = {P(x)} / 3 = {int(x * 100)}/300 = {trunc4(x / 3)} It has no finite decimal form, because {int(x * 100)} cents "
        f"is not a multiple of 3 cents. The close 5.05 is above SMA3 = (5 + 5 + 5.05) / 3 = 5.0166..., so the close of index 4 "
        f"creates an entry intent: cap = floor(5000.00 / 5) = 1000.00, reserved.\n"
        f"3. Entry. Index 5 opens at 5.00 and the fee is 1.00 per fill. 200 shares cost 1000.00 + 1.00 = 1001.00 > 1000.00; 199 "
        f"shares cost 995.00 + 1.00 = 996.00 <= 1000.00. Quantity 199; available 5000.00 - 996.00 = 4004.00.\n"
        f"4. Levels. Stop = 5 - 3 * ({P(x)} / 3) = 5 - {P(x)} = {P(s)}. Target = 5 + 3 * ({P(x)} / 3) = 5 + {P(x)} = {P(t)}. The "
        f"multiplier 3 cancels the divisor 3, so both levels are exact prices on the grid although ATR3 is not. An ATR3 rounded "
        f"to finitely many digits lies {d} its exact value, so a level computed from it lies {'above' if d == 'below' else 'below'} "
        f"the exact stop and {d} the exact target, by about one unit of its last digit. The expectation states both exact levels "
        f"in the daily positions and omits the ATR snapshot (no finite decimal form).\n")


def g_hand(x, final_cash, notional, delta):
    """Hand-derived values shared by G-01 to G-06b (steps 1 to 4 of the text and the exit step of each case)."""
    x = F(x)
    return {
        "entries.0.cap": ("1000.00", "floor(5000.00 / 5)"),
        "entries.0.quantity": ("199", "200 shares 1001.00 > 1000.00; 199 shares 996.00"),
        "cash_ledger.0.amount": ("1000.00", "the reserved cap"),
        "daily.5.cash_available": ("4004.00", "5000.00 - 996.00"),
        "daily.5.positions.0.stop": (fmt_exact(5 - x), "5 - 3 * (%s / 3)" % fmt_exact(x)),
        "daily.5.positions.0.target": (fmt_exact(5 + x), "5 + 3 * (%s / 3)" % fmt_exact(x)),
        "fills.1.notional": (notional, "199 * the exit price"),
        "fills.1.fee": ("1.00", "fixed fee"),
        "fills.1.cash_delta": (delta, "notional - 1.00"),
        "final.cash_available": (final_cash, "4004.00 + the proceeds"),
    }


def g_case(cid, title, x, rows, text, what, final_cash, notional, delta, extra_hand):
    """G-01 to G-06b: one tie bar after an entry at 5.00 with ATR3 = x / 3 and stop and target 3 * ATR3 away."""
    hand = g_hand(x, final_cash, notional, delta)
    hand.update(extra_hand)
    notes = (f"{len(rows)} sessions. Indices 0 to 3 are flat bars; the signal bar (index 4) makes the true-range sum {P(x)}, so ATR3 "
             f"= {P(x)} / 3 has no finite decimal form while 3 * ATR3 = {P(x)} is a price on the grid. {what}")
    return rc(cid, title, ["Entry and exit phases", "Cash and quantities"], rows, G_POLICY,
              skw={"stop_mult": 3, "target_mult": 3}, notes=notes, hand=hand, hand_text=g_steps_1_4(x) + text, focus=[D[4]])


def make_g01():
    x = F("0.67")
    rows = g_head(x) + [FL(5, "0.2"), (5, "5.66", "4.9", 5), (5, "5.67", "4.9", 5), FL(5, "0.2")]
    text = (
        "5. Index 6 (5, 5.66, 4.90, 5): high 5.66 < 5.67, one tick below the target: no touch. The low 4.90 stays above the stop "
        "4.33.\n"
        "6. Index 7 (5, 5.67, 4.90, 5): the open 5.00 is below the target (no gap) and the low 4.90 is above the stop. The high "
        "5.67 >= 5.67 by equality: the target is touched. The fill is the level floored to the price scale: floor(5.67) = 5.67, "
        "before costs and without slippage (the policy's 100 bps apply to a gap through a stop only). Notional 199 * 5.67 = "
        "1128.33; fee 1.00; proceeds 1127.33; available 4004.00 + 1127.33 = 5131.33.\n"
        "7. The closes of indices 7 and 8 equal SMA3 = 5.00 (not above it), so no new entry arises. The run ends with no "
        "position.\n")
    hand = {"fills.1.session": (D[7], "index 7"), "fills.1.reason": ("TARGET", "high 5.67 >= target 5.67"),
            "fills.1.price": ("5.67", "floor(5.67), not 5.66"), "trades.0.exit_price": ("5.67", "the exit price")}
    return g_case("G-01", "Grid tie: intraday target touch at 5.67 = 5 + 3 * 0.67/3 fills at 5.67 (ATR3 rounds below)", x, rows,
                  text,
                  "One bar stops one tick below the target 5.67 and is no touch; the next bar's high equals it and the target fills at "
                  "5.67. A target computed from a rounded ATR3 lies one unit of the last digit below 5.67, so its floor is 5.66.",
                  "5131.33", "1128.33", "1127.33", hand)


def make_g02():
    x = F("0.68")
    rows = g_head(x) + [FL(5, "0.2"), (5, "5.67", "4.9", 5), (5, "5.68", "4.9", 5), FL(5, "0.2")]
    text = (
        "5. Index 6 (5, 5.67, 4.90, 5): high 5.67 < 5.68, one tick below the target: no touch. The low 4.90 stays above the stop "
        "4.32.\n"
        "6. Index 7 (5, 5.68, 4.90, 5): the open 5.00 is below the target (no gap) and the low 4.90 is above the stop. The high "
        "5.68 >= 5.68 by equality: the target is touched. The fill is floor(5.68) = 5.68, before costs and without slippage. "
        "Notional 199 * 5.68 = 1130.32; fee 1.00; proceeds 1129.32; available 4004.00 + 1129.32 = 5133.32.\n"
        "7. The closes of indices 7 and 8 equal SMA3 = 5.00 (not above it), so no new entry arises. The run ends with no "
        "position.\n")
    hand = {"fills.1.session": (D[7], "index 7"), "fills.1.reason": ("TARGET", "high 5.68 >= target 5.68"),
            "fills.1.price": ("5.68", "floor(5.68)"), "trades.0.exit_price": ("5.68", "the exit price")}
    return g_case("G-02", "Grid tie: intraday target touch at 5.68 = 5 + 3 * 0.68/3 fills at 5.68 (ATR3 rounds above)", x, rows,
                  text,
                  "One bar stops one tick below the target 5.68 and is no touch; the next bar's high equals it and the target fills at "
                  "5.68. A target computed from a rounded ATR3 lies one unit of the last digit above 5.68, so a high of exactly 5.68 "
                  "would miss it and the position would stay open.",
                  "5133.32", "1130.32", "1129.32", hand)


def make_g03():
    x = F("0.68")
    rows = g_head(x) + [FL(5, "0.2"), ("4.4", "4.4", "4.33", "4.35"), ("4.35", "4.45", "4.32", "4.4")]
    text = (
        "5. Index 6 (4.40, 4.40, 4.33, 4.35): the open 4.40 is above the stop 4.32 (no gap); the low 4.33 > 4.32, one tick above "
        "the stop: no touch.\n"
        "6. Index 7 (4.35, 4.45, 4.32, 4.40): the open 4.35 is above the stop (no gap). The low 4.32 <= 4.32 by equality: the "
        "stop is touched; the high 4.45 is below the target 5.68, so the bar is not ambiguous. The fill is the level floored to "
        "the price scale: floor(4.32) = 4.32, before costs and without slippage (touched, not gapped). Notional 199 * 4.32 = "
        "859.68; fee 1.00; proceeds 858.68; available 4004.00 + 858.68 = 4862.68.\n"
        "7. Index 7 is the last session, so its close creates no entry intent.\n")
    hand = {"fills.1.session": (D[7], "index 7"), "fills.1.reason": ("STOP", "low 4.32 <= stop 4.32"),
            "fills.1.price": ("4.32", "floor(4.32)"), "trades.0.exit_price": ("4.32", "the exit price")}
    return g_case("G-03", "Grid tie: intraday stop touch at 4.32 = 5 - 3 * 0.68/3 fills at 4.32 (stop from a rounded ATR3 lies below)",
                  x, rows, text,
                  "One bar keeps its low one tick above the stop 4.32 and is no touch; the next bar's low equals it and the stop fills "
                  "at 4.32. A stop computed from a rounded ATR3 lies one unit of the last digit below 4.32, so a low of exactly "
                  "4.32 would miss it.",
                  "4862.68", "859.68", "858.68", hand)


def make_g04():
    x = F("0.67")
    rows = g_head(x) + [FL(5, "0.2"), ("4.4", "4.4", "4.34", "4.35"), ("4.35", "4.45", "4.33", "4.4")]
    text = (
        "5. Index 6 (4.40, 4.40, 4.34, 4.35): the open 4.40 is above the stop 4.33 (no gap); the low 4.34 > 4.33, one tick above "
        "the stop: no touch.\n"
        "6. Index 7 (4.35, 4.45, 4.33, 4.40): the open 4.35 is above the stop (no gap). The low 4.33 <= 4.33 by equality: the "
        "stop is touched; the high 4.45 is below the target 5.67, so the bar is not ambiguous. The fill is floor(4.33) = 4.33, "
        "before costs and without slippage. Notional 199 * 4.33 = 861.67; fee 1.00; proceeds 860.67; available 4004.00 + "
        "860.67 = 4864.67.\n"
        "7. Index 7 is the last session, so its close creates no entry intent.\n")
    hand = {"fills.1.session": (D[7], "index 7"), "fills.1.reason": ("STOP", "low 4.33 <= stop 4.33"),
            "fills.1.price": ("4.33", "floor(4.33)"), "trades.0.exit_price": ("4.33", "the exit price")}
    return g_case("G-04", "Grid tie: intraday stop touch at 4.33 = 5 - 3 * 0.67/3 fills at 4.33 (stop from a rounded ATR3 lies above)",
                  x, rows, text,
                  "The mirror of G-03. A stop computed from a rounded ATR3 lies one unit of the last digit above 4.33; no price on the "
                  "grid lies between the two, so the touch and the floored fill are the same either way and only the stored level "
                  "differs. The case pins the exact level and the other direction.",
                  "4864.67", "861.67", "860.67", hand)


def make_g05(sfx, x, below, tie, final_cash, notional, delta, what):
    """Gap above the target: index 6 opens one tick below the target (no gap), index 7 opens exactly at it."""
    x = F(x)
    rows = g_head(x) + [FL(5, "0.2"), (below, below, "5.6", "5.65"), (tie, F(tie) + F("0.03"), "5", "5"), FL(5, "0.2")]
    text = (
        f"5. Index 6 ({below}, {below}, 5.60, 5.65): the open {below} < the target {tie} (one tick below): no gap; the high {below} < "
        f"{tie}: no touch. The position is held. The close 5.65 is above SMA3 = (5.05 + 5 + 5.65) / 3 = 5.2333..., which creates no "
        f"intent because the instrument is held.\n"
        f"6. Index 7 opens at {tie} >= the target {tie} by equality: a gap above the target, GAP_TARGET at OPEN. The fill is at the "
        f"target level floored to the price scale, floor({tie}) = {tie}, before costs and without slippage (the policy's 100 bps "
        f"apply to a gap through a stop only). Notional 199 * {tie} = {notional}; fee 1.00; proceeds {delta}; available 4004.00 + "
        f"{delta} = {final_cash}.\n"
        f"7. The close of index 7 is 5.00, below SMA3 = (5 + 5.65 + 5) / 3 = 5.2166..., and so are the later closes: no new entry. "
        f"The run ends with no position.\n")
    hand = {"fills.1.session": (D[7], "index 7"), "fills.1.reason": ("GAP_TARGET", "open == target"),
            "fills.1.phase": ("OPEN", "a gap exit happens at the open"), "fills.1.price": (tie, f"floor({tie})"),
            "trades.0.exit_price": (tie, "the exit price")}
    return g_case("G-05" + sfx, f"Grid tie: gap above the target, the open {tie} equals the target 5 + 3 * {P(x)}/3 exactly", x, rows,
                  text, what, final_cash, notional, delta, hand)


def make_g06(sfx, x, stop, above, slipped, final_cash, notional, delta, what):
    """Gap through the stop: index 6 stays one tick above the stop, index 7 opens exactly at it."""
    x = F(x)
    rows = g_head(x) + [FL(5, "0.2"), ("4.4", "4.4", above, "4.35"), (stop, "4.4", "4.3", "4.35"), ("4.35", "4.4", "4.3", "4.35")]
    text = (
        f"5. Index 6 (4.40, 4.40, {above}, 4.35): the open 4.40 is above the stop {stop} (no gap); the low {above} > {stop}, one tick "
        f"above the stop: no touch.\n"
        f"6. Index 7 opens at {stop} <= the stop {stop} by equality: a gap through the stop, GAP_STOP at OPEN. The fill is the open "
        f"less slippage, floored to the price scale: {stop} * (1 - 100/10000) = {stop} * 0.99 = {fmt_exact(F(stop) * F('0.99'))}, "
        f"floored to 2 decimals = {slipped}. It is neither the stop level nor the nearest price. Notional 199 * {slipped} = "
        f"{notional}; fee 1.00; proceeds {delta}; available 4004.00 + {delta} = {final_cash}.\n"
        f"7. The closes of indices 7 and 8 (4.35) are not above SMA3, so no new entry arises. The run ends with no position.\n")
    hand = {"fills.1.session": (D[7], "index 7"), "fills.1.reason": ("GAP_STOP", "open == stop"),
            "fills.1.phase": ("OPEN", "a gap exit happens at the open"), "fills.1.price": (slipped, f"floor({stop} * 0.99)"),
            "trades.0.exit_price": (slipped, "the exit price")}
    return g_case("G-06" + sfx, f"Grid tie: gap through the stop, the open {stop} equals the stop 5 - 3 * {P(x)}/3 exactly, slippage applies",
                  x, rows, text, what, final_cash, notional, delta, hand)


def make_g07(sfx, price, rng, hi, lo, close, flat_txt, sig_txt, total, atr_frac, atr_dec, qty, size_txt, rounded_txt, title):
    """ATR6 = total / 6 with a stop 6 * ATR6 below the entry price: the exact stop is 0, so the level is invalid."""
    p = P(price)
    rows = [FL(price, rng)] * 7 + [(price, hi, lo, close)] + [FL(price, rng)] * 2
    text = (
        f"1. ATR6 window, indices 2 to 7 (six bars). {flat_txt} {sig_txt} The sum is {total}.\n"
        f"2. ATR6 = {total} / 6 = {atr_frac} = {atr_dec} It has no finite decimal form. The close {close} is above SMA3 = ({p} + {p} "
        f"+ {close}) / 3, so the close of index 7 creates an entry intent: cap = floor(5000.00 / 5) = 1000.00, reserved (available "
        f"4000.00, reserved 1000.00).\n"
        f"3. Index 8 opens at {p}. Sizing with the fee of 1.00 per fill: {size_txt} Sizing succeeds, so the levels are validated.\n"
        f"4. Levels. Stop = {p} - 6 * ATR6 = {p} - 6 * {atr_frac} = {p} - {total} = 0 exactly; target = {p} + 2 * ATR6 is above the "
        f"entry. The rule 0 < stop < entry < target fails because the stop is not above 0: the run ends with FAILED INVALID_LEVEL "
        f"at OPEN of index 8. The whole OPEN event is rolled back (the declared policy for an invalid level): there is no BUY fill, the reservation made "
        f"at the close of index 7 stays in the journal (entry RESERVED, one RESERVE line of 1000.00, cash reserved 1000.00) and "
        f"index 9 is never processed.\n"
        f"5. {rounded_txt}\n")
    hand = {"outcome.status": ("FAILED", "the level check fails"), "outcome.code": ("INVALID_LEVEL", "the stop 0 is not above 0"),
            "outcome.at.session": (D[8], "the entry session"), "outcome.at.phase": ("OPEN", "the entry fill"),
            "signals.7.decision": ("ENTER", "close above SMA3"), "entries.0.status": ("RESERVED", "never filled"),
            "entries.0.cap": ("1000.00", "floor(5000.00 / 5)"), "cash_ledger.0.kind": ("RESERVE", "the only journal line"),
            "daily.7.cash_reserved": ("1000.00", "reserved at the close of index 7"),
            "daily.7.cash_available": ("4000.00", "5000.00 - 1000.00")}
    return rc("G-07" + sfx, title, ["Invalid inputs", "Entry and exit phases"], rows, G_POLICY,
              skw={"atr_w": 6, "stop_mult": 6, "target_mult": 2}, kind="partial",
              sections=("signals", "entries", "fills", "cash_ledger", "daily", "corporate_actions"),
              notes=f"{len(rows)} sessions at price {p}. The ATR6 window of the signal bar has true-range sum {total}, so ATR6 = "
                    f"{atr_frac} has no finite decimal form while the stop 6 * ATR6 below the entry price {p} is exactly 0, which "
                    f"breaks 0 < stop. The run must fail with INVALID_LEVEL at the entry open, and nothing is filled.",
              hand=hand, hand_text=text, focus=[D[7]])


def make_g08(sfx, x, tick_below, level, compare_to):
    """Break-even trigger high >= entry + 3 * ATR3 with ATR3 = x / 3: the trigger level is the grid price 5 + x."""
    x = F(x)
    s_off, t_off = 5 - 2 * x / 3, 5 + 5 * x / 3
    d = g_dir(x)
    rows = g_head(x) + [(5, tick_below, "4.9", 5), (5, level, "4.9", 5), ("5.2", "5.3", "4.95", 5), FL(5, "0.2")]
    text = (
        f"1. ATR3 window as in {compare_to}: the true ranges of indices 2, 3, 4 are 0.20, 0.20 and {P(x - F('0.4'))}, so the sum "
        f"is {P(x)} and ATR3 = {P(x)} / 3 (no finite decimal form). The close 5.05 is above SMA3 = 5.0166..., so the close of "
        f"index 4 creates an entry intent (cap 1000.00). Index 5 opens at 5.00: quantity 199 (996.00 with the fee), available "
        f"4004.00.\n"
        f"2. Levels. Stop = 5 - 2 * ({P(x)} / 3) = {fmt_dec(s_off)} = {trunc4(s_off)} and target = 5 + 5 * ({P(x)} / 3) = "
        f"{fmt_dec(t_off)} = {trunc4(t_off)}; both are off the grid, so the expectation omits them. The break-even rule fires when "
        f"high >= entry + 3 * entry_atr = 5 + 3 * ({P(x)} / 3) = 5 + {P(x)} = {level}, an exact price on the grid, and then moves "
        f"the stop to the entry price 5.00 effective at the next session.\n"
        f"3. Index 5 (5, {tick_below}, 4.90, 5), the entry session: the high {tick_below} < {level}, one tick below the trigger: no "
        f"trigger. The low 4.90 is above the stop and the high is below the target.\n"
        f"4. Index 6 (5, {level}, 4.90, 5): the high {level} >= {level} by equality: the trigger holds at the close and the stop "
        f"is scheduled once, at the level 5.00 (the entry price), effective at index 7 ({D[7]}). The stop in force during index 6 is "
        f"still the original one, so the daily record of index 6 shows the scheduled stop 5 effective {D[7]}.\n"
        f"5. Index 7 (5.20, 5.30, 4.95, 5): BEFORE_OPEN activates the stop 5.00. The open 5.20 is above 5.00 (no gap); the low "
        f"4.95 <= 5.00: STOP at floor(5.00) = 5.00, before costs. Notional 199 * 5.00 = 995.00; fee 1.00; proceeds 994.00; "
        f"available 4004.00 + 994.00 = 4998.00.\n"
        f"6. The close of index 7 equals SMA3 = 5.00 (not above it), so no new entry arises. The run ends with no position.\n")
    hand = {"entries.0.quantity": ("199", "996.00 with the fee"),
            "daily.5.cash_available": ("4004.00", "5000.00 - 996.00"),
            "daily.6.positions.0.scheduled_stop.level": ("5", "the entry price"),
            "daily.6.positions.0.scheduled_stop.effective_session": (D[7], "next session"),
            "fills.1.session": (D[7], "index 7"),
            "fills.1.reason": ("STOP", "the activated stop 5.00 is touched by the low 4.95"),
            "fills.1.price": ("5.00", "floor(5.00)"), "fills.1.cash_delta": ("994.00", "995.00 - 1.00"),
            "final.cash_available": ("4998.00", "4004.00 + 994.00")}
    if d == "above":
        why = (f"a trigger level computed from it lies one unit of the last digit above {level}, so a high of exactly {level} would "
               f"miss the trigger and the position would keep its old stop.")
    else:
        why = (f"a trigger level computed from it lies one unit of the last digit below {level}, so the bar at {level} is a trigger "
               f"either way and a rounded computation still decides this case correctly. The case pins the other direction.")
    return rc("G-08" + sfx, f"Grid tie: break-even trigger high >= 5 + 3 * ATR3 fires at exactly {level} (ATR3 = {P(x)}/3)",
              ["Entry and exit phases", "Definition execution"], rows, G_POLICY,
              skw={"break_even": True, "be_mult": 3, "stop_mult": 2, "target_mult": 5}, version=2,
              notes=f"{len(rows)} sessions. The break-even trigger of this variant is high >= entry_price + 3 * entry_atr, so with "
                    f"ATR3 = {P(x)}/3 the trigger level is the grid price {level} although ATR3 has no finite decimal form. One bar "
                    f"stays one tick below it (no trigger) and the next bar's high equals it (trigger). A rounded ATR3 lies {d} its "
                    f"exact value: {why}",
              hand=hand, hand_text=text, focus=[D[4], D[6]])


def make_g09(sfx, title, rows, op, k, closes_txt, mean, rounded_txt, entry, qty, fits, cash, final_equity, after_txt):
    """Entry condition op(3 * SMA3(close), k) where the sum of the three closes at index 4 equals k exactly."""
    cond = ex(op, [ex("mul", [cst(3, "RATIO"), ref("sma3")]), cst(k, "PRICE")])
    cmp_txt = {"gte": ">=", "lte": "<="}[op]
    cost = F(qty) * F(entry) + 1
    text = (
        f"1. The entry condition is 3 * SMA3(close) {cmp_txt} {k}. SMA3 is the mean of the last three closes, so 3 * SMA3 is their "
        f"sum.\n"
        f"2. {closes_txt}\n"
        f"3. At index 4 the three closes (indices 2, 3, 4) sum to {k} exactly. Their mean is {mean}, which has no finite decimal "
        f"form, and 3 * mean = {k} exactly, so {k} {cmp_txt} {k} holds by equality: the condition is TRUE and the close of index 4 "
        f"creates an entry intent (cap = floor(5000.00 / 5) = 1000.00). {rounded_txt}\n"
        f"4. Entry. Index 5 opens at {entry}. Quantity {qty} ({fits}). Available 5000.00 - {P(cost)} = {cash}.\n"
        f"5. ATR3 = (0.20 + 0.20 + 0.20) / 3 = 0.20 exactly. Stop = {entry} - 2 * 0.20 = {P(F(entry) - F('0.4'))}; target = {entry} "
        f"+ 5 * 0.20 = {P(F(entry) + 1)}. No later bar touches them.\n"
        f"6. {after_txt}\n")
    hand = {"signals.4.condition": ("TRUE", f"the sum equals {k}"), "signals.4.decision": ("ENTER", "condition TRUE, not held"),
            "entries.0.cap": ("1000.00", "floor(5000.00 / 5)"), "entries.0.quantity": (str(qty), fits),
            "fills.0.price": (entry, "the open of index 5"), "daily.5.cash_available": (cash, "5000.00 - the entry cost"),
            "final.equity": (final_equity, "see step 6")}
    return rc("G-09" + sfx, title, ["Entry variants", "Entry and exit phases"], rows, G_POLICY,
              skw={"condition": cond,
                   "hypothesis": "Reduced fixture strategy: enter when three times the short mean %s a price level."
                                 % ("reaches" if op == "gte" else "falls to")},
              notes=f"{len(rows)} sessions. The entry condition is {op}(3 * SMA3(close), {k}). The three closes of the signal "
                    f"session sum to {k}, so SMA3 = {mean} has no finite decimal form while 3 * SMA3 = {k} is a price on the grid. "
                    f"{rounded_txt}",
              hand=hand, hand_text=text, focus=[D[3], D[4]])


def make_g09a():
    rows = [FL(2, "0.2")] * 4 + [(2, "2.1", "1.9", "2.01"), FL(2, "0.2"), FL(2, "0.2"), FL(2, "0.2")]
    return make_g09(
        "a", "Grid tie: entry signal 3 * SMA3 >= 6.01 holds at the exact sum 6.01 (SMA3 rounds below)", rows, "gte", "6.01",
        "Closes by index: 2.00, 2.00, 2.00, 2.00, 2.01, 2.00, 2.00, 2.00. At index 3 the last three closes (indices 1, 2, 3) sum "
        "to 6.00, so 3 * SMA3 = 6.00 < 6.01: FALSE, no entry.",
        "601/300 = 2.0033...",
        "A mean rounded to finitely many digits lies below 601/300 (its digits end in 3), so 3 times it is below 6.01 and a "
        "comparison made after the rounding would say false and miss the entry.",
        "2.00", 499, "500 shares: 1000.00 + 1.00 = 1001.00 > 1000.00; 499 shares: 998.00 + 1.00 = 999.00 <= 1000.00", "4001.00",
        "4999.00",
        "Indices 5 and 6 sum to 6.01 again (2.00 + 2.01 + 2.00 and 2.01 + 2.00 + 2.00): the condition is TRUE while the instrument "
        "is held (SKIPPED, HELD). Index 7 sums to 6.00: FALSE. The position is open at the end and is valued at the last close "
        "2.00: 4001.00 + 499 * 2.00 = 4001.00 + 998.00 = 4999.00.")


def make_g09b():
    rows = [FL(2, "0.2")] * 4 + [(2, "2.1", "1.9", "2.02"), FL(2, "0.2"), FL(2, "0.2"), FL(2, "0.2")]
    return make_g09(
        "b", "Grid tie: entry signal 3 * SMA3 >= 6.02 holds at the exact sum 6.02 (SMA3 rounds above)", rows, "gte", "6.02",
        "Closes by index: 2.00, 2.00, 2.00, 2.00, 2.02, 2.00, 2.00, 2.00. At index 3 the last three closes sum to 6.00, so "
        "3 * SMA3 = 6.00 < 6.02: FALSE, no entry.",
        "602/300 = 2.0066...",
        "A mean rounded to finitely many digits lies above 602/300 (its digits end in 7), so 3 times it is above 6.02 and a "
        "greater-or-equal comparison still holds: a >= test is not misjudged in this direction (G-09c uses <=). The case pins the "
        "entry at the exact sum in the other direction.",
        "2.00", 499, "500 shares: 1000.00 + 1.00 = 1001.00 > 1000.00; 499 shares: 998.00 + 1.00 = 999.00 <= 1000.00", "4001.00",
        "4999.00",
        "Indices 5 and 6 sum to 6.02 again: TRUE while held (SKIPPED, HELD). Index 7 sums to 6.00: FALSE. The position is open at "
        "the end and is valued at the last close 2.00: 4001.00 + 499 * 2.00 = 4999.00.")


def make_g09c():
    rows = [FL("2.05", "0.2")] * 4 + [("2.05", "2.1", "1.9", "1.92"), ("1.95", "2.15", "1.85", "2.1"), ("2.1", "2.2", "2", "2.1"),
                                      ("2.1", "2.2", "2", "2.1")]
    return make_g09(
        "c", "Grid tie: entry signal 3 * SMA3 <= 6.02 holds at the exact sum 6.02 (SMA3 rounds above)", rows, "lte", "6.02",
        "Closes by index: 2.05, 2.05, 2.05, 2.05, 1.92, 2.10, 2.10, 2.10. At index 3 the last three closes sum to 6.15, so "
        "3 * SMA3 = 6.15 > 6.02: FALSE, no entry. The ATR3 window holds the flat bars (2.05, 2.15, 1.95, 2.05) with true range 0.20 "
        "and the signal bar (2.05, 2.10, 1.90, 1.92) with true range max(0.20, 0.05, 0.15) = 0.20.",
        "602/300 = 2.0066...",
        "A mean rounded to finitely many digits lies above 602/300, so 3 times it is above 6.02 and a less-or-equal comparison made "
        "after the rounding would say false and miss the entry.",
        "1.95", 512, "513 shares: 1000.35 + 1.00 > 1000.00; 512 shares: 998.40 + 1.00 = 999.40 <= 1000.00", "4000.60", "5075.80",
        "Index 5 sums to 2.05 + 1.92 + 2.10 = 6.07 > 6.02: FALSE, and later sums are larger. The position is open at the end and is "
        "valued at the last close 2.10: 4000.60 + 512 * 2.10 = 4000.60 + 1075.20 = 5075.80.")


def make_g10(cid, fnew, fold, tie):
    """A fnew-for-fold split at index 6 and its reverse at index 8 around levels 4.78 and 5.66 (ATR3 = 0.22 is exact)."""
    r, rr = F(fnew, fold), F(fold, fnew)
    qm = 200 * r
    assert qm.denominator == 1 and qm * rr == 200
    qm = int(qm)
    rs = f"{fnew}/{fold}" if fold != 1 else f"{fnew}"
    rrs = f"{fold}/{fnew}"
    rp = f"({rs})" if fold != 1 else rs
    rrp = f"({rrs})"
    px = "1.67" if fnew == 3 else "1.43"
    post = [(px, F(px) + F("0.08"), F(px) - F("0.05"), px), (px, F(px) + F("0.08"), F(px) - F("0.05"), F(px) - F("0.01"))]
    s0, t0, e0, a0 = F("4.78"), F("5.66"), F(5), F("0.22")
    rows = g_head(F("0.66")) + [FL(5, "0.2")] + post + [FL(5, "0.2"), (5, "5.65", "4.79", 5)]
    rows += [(5, "5.1", "4.78", "4.85")] if tie == "stop" else [(5, "5.66", "4.9", 5)]
    rows += [FL(5, "0.2")]
    sp1, sp2 = f"SPLIT-{fnew}-{fold}", f"SPLIT-{fold}-{fnew}"
    text = (
        f"1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (5, 5.10, 4.90, 5): true range 0.20 each. Index 4 is (5, 5.16, 4.90, "
        f"5.05): max(0.26, 0.16, 0.10) = 0.26. The sum is 0.66 and ATR3 = 0.66 / 3 = 0.22 exactly, so nothing is off the grid before "
        f"the first split. The close 5.05 is above SMA3 = 5.0166...: entry intent with cap floor(5000.00 / 5) = 1000.00.\n"
        f"2. Entry. Index 5 opens at 5.00 with zero fees: 200 shares cost 1000.00 <= 1000.00. Quantity 200, available 4000.00. "
        f"Stop = 5 - 1 * 0.22 = 4.78 and target = 5 + 3 * 0.22 = 5.66, both exact prices on the grid.\n"
        f"3. Index 6 is the ex-date of {sp1} ({fnew}-for-{fold}, ratio r = {rs}). Quantity 200 * {rp} = {qm} (a whole number). Every "
        f"price-unit value is divided by r: entry 5 / {rp} = {fmt_dec(e0 / r)}, stop 4.78 / {rp} = {fmt_dec(s0 / r)} = "
        f"{trunc4(s0 / r)}, target 5.66 / {rp} = {fmt_dec(t0 / r)} = {trunc4(t0 / r)}, ATR snapshot 0.22 / {rp} = "
        f"{fmt_dec(a0 / r)}. None of them has a finite decimal form. The raw bars of indices 6 and 7 trade near {px}, between "
        f"the stop and the target: no gap and no touch.\n"
        f"4. Index 8 is the ex-date of {sp2} ({fold}-for-{fnew}, ratio r' = {rrs}). Quantity {qm} * {rrp} = 200 (whole). Every "
        f"price-unit value is divided by r', that is multiplied by {fmt_dec(r)}: stop {fmt_dec(s0 / r)} * {fmt_dec(r)} = 4.78, target "
        f"{fmt_dec(t0 / r)} * {fmt_dec(r)} = 5.66, entry {fmt_dec(e0 / r)} * {fmt_dec(r)} = 5, snapshot {fmt_dec(a0 / r)} * "
        f"{fmt_dec(r)} = 0.22. A division and a multiplication by the same ratio are exact inverses in rational arithmetic, so every "
        f"value returns to the exact value it had before the first split. Bar 8 (5, 5.10, 4.90, 5) touches neither level.\n"
        f"5. Index 9 (5, 5.65, 4.79, 5): the high 5.65 < 5.66 and the low 4.79 > 4.78, one tick inside each level: no touch.\n")
    if tie == "stop":
        text += (
            "6. Index 10 (5, 5.10, 4.78, 4.85): the open 5.00 is above the stop (no gap). The low 4.78 <= 4.78 by equality: the stop "
            "is touched (the high 5.10 is below the target 5.66). The fill is floor(4.78) = 4.78, before costs and without "
            "slippage. Notional 200 * 4.78 = 956.00; fee 0.00; proceeds 956.00; available 4000.00 + 956.00 = 4956.00.\n")
        hand_t = {"fills.1.reason": ("STOP", "low 4.78 <= stop 4.78"), "fills.1.price": ("4.78", "floor(4.78)"),
                  "fills.1.notional": ("956.00", "200 * 4.78"), "final.cash_available": ("4956.00", "4000.00 + 956.00")}
        what = ("The stop is touched at exactly 4.78 after a split and its reverse. A stop that was divided and multiplied again with "
                "finitely many digits can come back one unit of the last digit below 4.78, and a low of exactly 4.78 would then "
                "miss it.")
        level = "4.78"
    else:
        text += (
            "6. Index 10 (5, 5.66, 4.90, 5): the open 5.00 is below the target (no gap) and the low 4.90 is above the stop. The high "
            "5.66 >= 5.66 by equality: the target is touched. The fill is floor(5.66) = 5.66, before costs. Notional 200 * 5.66 = "
            "1132.00; fee 0.00; proceeds 1132.00; available 4000.00 + 1132.00 = 5132.00.\n")
        hand_t = {"fills.1.reason": ("TARGET", "high 5.66 >= target 5.66"), "fills.1.price": ("5.66", "floor(5.66)"),
                  "fills.1.notional": ("1132.00", "200 * 5.66"), "final.cash_available": ("5132.00", "4000.00 + 1132.00")}
        what = ("The target is touched at exactly 5.66 after a split and its reverse. A target that was divided and multiplied again "
                "with finitely many digits can come back one unit of the last digit above 5.66 (a high of exactly 5.66 would miss "
                "it) or below it (the floored fill would be 5.65).")
        level = "5.66"
    text += ("7. Index 11 is a flat bar and the last session, so no new position is opened. The run ends with no position; the closed "
             "trade states the restored quantity 200 and the entry price 5.00.\n")
    hand = {"entries.0.quantity": ("200", "1000.00 / 5.00, zero fees"), "daily.5.cash_available": ("4000.00", "5000.00 - 1000.00"),
            "daily.5.positions.0.stop": ("4.78", "5 - 0.22"), "daily.5.positions.0.target": ("5.66", "5 + 3 * 0.22"),
            "daily.6.positions.0.quantity": (str(qm), f"200 * {rp}"),
            "daily.7.positions.0.quantity": (str(qm), "unchanged"),
            "daily.8.positions.0.quantity": ("200", f"{qm} * {rrp}"),
            "daily.8.positions.0.entry_price": ("5", "restored exactly"),
            "daily.8.positions.0.stop": ("4.78", "restored exactly"), "daily.8.positions.0.target": ("5.66", "restored exactly"),
            "daily.8.positions.0.snapshots.0.value": ("0.22", "restored exactly"),
            "daily.9.positions.0.stop": ("4.78", "still exact"), "daily.9.positions.0.target": ("5.66", "still exact"),
            "corporate_actions.0.action_id": (sp1, "input order"), "corporate_actions.1.action_id": (sp2, "input order"),
            "fills.1.session": (D[10], "index 10"), "fills.1.quantity": ("200", "restored quantity"),
            "trades.0.quantity": ("200", "restored quantity"), "trades.0.entry_price": ("5.00", "restored entry price")}
    hand.update(hand_t)
    return rc(cid, f"Grid tie: {tie} touched at exactly {level} after a {fnew}-for-{fold} split and its reverse (exact round trip)",
              ["Split across an ex-date", "Entry and exit phases"], rows, G_ZERO, skw={"stop_mult": 1, "target_mult": 3},
              actions=[split_action(sp1, D[6], fnew, fold), split_action(sp2, D[8], fold, fnew)],
              notes=f"{len(rows)} sessions with zero fees. ATR3 = 0.22 is exact, so the stop 4.78 and the target 5.66 are on the grid "
                    f"before the splits. A {fnew}-for-{fold} split at index 6 and its reverse at index 8 convert the quantity (200, "
                    f"{qm}, 200 shares) and divide then multiply every level by {rs}, which leaves no finite decimal form in "
                    f"between; the levels must come back exactly. {what}",
              hand=hand, hand_text=text, focus=[D[4], D[6], D[8], D[10]],
              policy_text="the fixed fee is 0, so quantity and cash are whole numbers.")


def build_grid_ties():
    make_g01()
    make_g02()
    make_g03()
    make_g04()
    make_g05("a", "0.67", "5.66", "5.67", "5131.33", "1128.33", "1127.33",
             "Index 6 opens one tick below the target 5.67 (no gap) and index 7 opens exactly at it. A target computed from a rounded "
             "ATR3 lies one unit of the last digit below 5.67: the open still gaps through it but the floored fill would be 5.66.")
    make_g05("b", "0.68", "5.67", "5.68", "5133.32", "1130.32", "1129.32",
             "Index 6 opens one tick below the target 5.68 (no gap) and index 7 opens exactly at it. A target computed from a rounded "
             "ATR3 lies one unit of the last digit above 5.68: the open would not count as a gap and the exit would be a later "
             "touch (or none).")
    make_g06("", "0.68", "4.32", "4.33", "4.27", "4852.73", "849.73", "848.73",
             "Index 6 stays one tick above the stop 4.32 and index 7 opens exactly at it. A stop computed from a rounded ATR3 lies one "
             "unit of the last digit below 4.32: the open would not count as a gap and the exit would be a later touch filled "
             "at 4.31.")
    make_g06("b", "0.67", "4.33", "4.34", "4.28", "4854.72", "851.72", "850.72",
             "The mirror of G-06. A stop computed from a rounded ATR3 lies one unit of the last digit above 4.33; the open is a gap "
             "either way and the fill is the same, so only the stored level differs. The case pins the other direction.")
    make_g07("a", 5, "0.8", "5.5", "4.5", "5.05",
             "Indices 2 to 6 are (5, 5.40, 4.60, 5) after a close of 5: max(0.80, 0.40, 0.40) = 0.80 each, 4.00 in total.",
             "Index 7 is (5, 5.50, 4.50, 5.05) after a close of 5: max(1.00, 0.50, 0.50) = 1.00.", "5.00", "5/6", "0.8333...", 199,
             "200 shares cost 1000.00 + 1.00 = 1001.00 > 1000.00; 199 shares cost 995.00 + 1.00 = 996.00 <= 1000.00, so the quantity "
             "is 199.",
             "ATR6 rounded to finitely many digits is below 5/6 (0.8333...), so 6 * ATR6 is below 5 and a stop computed from it is a "
             "small positive number: a level check applied to that number would accept it. The exact stop is 0 and must be rejected.",
             "Grid tie: a stop of exactly 0 = 5 - 6 * 5/6 is an invalid level (ATR6 rounds below)")
    make_g07("b", 7, "1.0", "8", "6", "7.05",
             "Indices 2 to 6 are (7, 7.50, 6.50, 7) after a close of 7: max(1.00, 0.50, 0.50) = 1.00 each, 5.00 in total.",
             "Index 7 is (7, 8.00, 6.00, 7.05) after a close of 7: max(2.00, 1.00, 1.00) = 2.00.", "7.00", "7/6", "1.1666...", 142,
             "143 shares cost 1001.00 + 1.00 > 1000.00; 142 shares cost 994.00 + 1.00 = 995.00 <= 1000.00, so the quantity is 142.",
             "ATR6 rounded to finitely many digits is above 7/6 (1.1666... rounds up), so 6 * ATR6 is above 7 and a stop computed from "
             "it is a small negative number, which a level check rejects as well. A rounded computation reaches the same outcome in "
             "this direction; the case pins that the exact stop 0 is rejected here too.",
             "Grid tie: a stop of exactly 0 = 7 - 6 * 7/6 is an invalid level (ATR6 rounds above)")
    make_g08("a", "0.68", "5.67", "5.68", "G-02")
    make_g08("b", "0.67", "5.66", "5.67", "G-01")
    make_g09a()
    make_g09b()
    make_g09c()
    make_g10("G-10", 3, 1, "stop")
    make_g10("G-10b", 3, 1, "target")
    make_g10("G-11", 7, 2, "stop")
    make_g10("G-11b", 7, 2, "target")


# ---------------------------------------------------------------- protocol payloads


def write_protocol_payloads():
    base = json.load(open(os.path.join(S0, "cases", "F0-smoke", "input.json"), encoding="utf-8"))
    out = []
    a = copy.deepcopy(base)
    a["instruments"][0]["unplanned_events"] = [{"event_id": "E-1", "kind": "HALT_RUMOUR", "effective_session": "2026-01-12",
                                                 "available_at": "2026-01-12T13:30:00Z"}]
    out.append(("invalid/input.unplanned-event-kind-unknown.json", a, "SCHEMA_VIOLATION"))
    b = copy.deepcopy(base)
    b["instruments"][0]["corporate_actions"] = [{"kind": "SPLIT", "action_id": "SPLIT-1", "effective_session": "2026-01-13",
                                                  "available_at": "2026-01-13T06:00:00Z", "ratio_new": 2, "ratio_old": 0}]
    out.append(("invalid/input.split-ratio-zero.json", b, "SCHEMA_VIOLATION"))
    c = copy.deepcopy(base)
    c["instruments"][0]["corporate_actions"] = [{"kind": "CASH_DIVIDEND", "action_id": "DIV-1", "effective_session": "2026-01-13",
                                                  "available_at": "2026-01-13T06:00:00Z", "amount_per_share": "1.00",
                                                  "payment_session": "2026-01-14", "payment_phase": "NEXT_MORNING"}]
    out.append(("invalid/input.dividend-phase-unknown.json", c, "SCHEMA_VIOLATION"))
    entries = []
    for rel, obj, code in out:
        write_json(os.path.join(PROTO, rel), obj, 200)
        entries.append({"path": "protocol/" + rel, "contract": "evaluation-input", "expect": "schema_invalid", "code": code})
    return entries


def protocol_entries():
    e = []

    def add(path, contract, expect, code=None, strat=None):
        o = {"path": path, "contract": contract, "expect": expect}
        if code:
            o["code"] = code
        if strat:
            o["with_strategy"] = strat
        e.append(o)

    c = "s0/cases/"
    add(c + "I-04a/strategy.json", "strategy-artefact", "semantic_invalid", "UNSUPPORTED_OPERATOR")
    add(c + "I-04b/strategy.json", "strategy-artefact", "semantic_invalid", "OPERATOR_UNIT_MISMATCH")
    add(c + "I-05a/input.json", "evaluation-input", "semantic_invalid", "INVALID_DECIMAL", c + "I-05a/strategy.json")
    add(c + "I-05b/input.json", "evaluation-input", "semantic_invalid", "INVALID_INPUT", c + "I-05b/strategy.json")
    add(c + "I-05c/input.json", "evaluation-input", "semantic_invalid", "INVALID_INPUT", c + "I-05c/strategy.json")
    add(c + "I-08/input.json", "evaluation-input", "semantic_invalid", "IDENTITY_MISMATCH", c + "I-08/strategy.json")
    add(c + "X-01/strategy.json", "strategy-artefact", "valid")
    add(c + "X-01/input.json", "evaluation-input", "valid", None, c + "X-01/strategy.json")
    add(c + "C-06/input.json", "evaluation-input", "valid", None, c + "C-06/strategy.json")
    add(c + "R-01/input.json", "evaluation-input", "valid", None, c + "R-01/strategy.json")
    add(c + "SEM-01/input.json", "evaluation-input", "valid", None, "s0/strategies/seed-1-rsi30-breakeven-off.json")
    add(c + "ENT-03/input.json", "evaluation-input", "valid", None, "s0/strategies/seed-5-rsi40-breakeven-off-data-only.json")
    return e


# ---------------------------------------------------------------- main


def build_all():
    make_sem01_case = make_sem01()
    for fn in (make_sem02, make_sem03, make_sem04, make_sem04b, make_sem05):
        fn()
    make_ent01()
    make_ent02()
    make_ent03()
    make_def01()
    make_def02()
    make_x01()
    make_x02(10, "5000.00", "X-02a")
    make_x02(100, "50000.00", "X-02b")
    make_x03()
    make_x04()
    make_x05()
    make_x06()
    make_x07()
    make_x08()
    make_x09(False)
    make_x09(True)
    make_x10()
    make_x11()
    make_x12()
    make_x13()
    make_x14()
    make_c01a()
    make_c01b()
    make_c01c()
    make_c02()
    make_c03()
    make_c04()
    make_c04_timing("C-04a", D[6], "BEFORE_OPEN", 20, "1044.00", "4176.00",
                    "payment at BEFORE_OPEN of the ex-date is already cash at the close: floor(5220.00 / 5)")
    make_c04_timing("C-04b", D[7], "OPEN", 19, "1040.00", "4228.20",
                    "the payment is after the close: floor(5200.00 / 5), later payment cannot enlarge it")
    make_c04_timing("C-04c", D[6], "AFTER_CLOSE", 20, "1044.00", "4176.00",
                    "payment at AFTER_CLOSE is applied before the cap: floor(5220.00 / 5)")
    make_c05()
    make_c06()
    make_c07()
    make_c08()
    make_i01()
    make_i02()
    make_i03()
    make_i04a()
    make_i04b()
    make_i05("a", "Excess price scale is rejected as an invalid decimal", "INVALID_DECIMAL", mut_scale,
             "A bar's open is 50.001 while the policy price scale is 2. The decimal string matches the grammar but exceeds "
             "the declared scale; preparation rejects it with INVALID_DECIMAL instead of rounding it.")
    make_i05("b", "High below low is rejected as invalid input", "INVALID_INPUT", mut_hl,
             "A bar's high (48.5) is below its low (49): an impossible bar. Preparation rejects it with INVALID_INPUT.")
    make_i05("c", "A calendar that is not ascending is rejected as invalid input", "INVALID_INPUT", mut_cal,
             "Two calendar sessions are swapped, so the calendar is not strictly ascending. Alignment is by session, "
             "never by row number; preparation rejects the calendar with INVALID_INPUT.")
    make_i06()
    make_i07()
    make_i08()
    make_i09()
    make_i10()
    make_i11()
    make_r01()
    build_grid_ties()
    return make_sem01_case


def main():
    me = os.path.abspath(__file__)
    oracle_sha = file_sha256_hex(me)
    build_all()
    ids = [c.id for c in CASE_LIST]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    for c in CASE_LIST:
        emit(c, oracle_sha)
    # coverage
    path = os.path.join(S0, "coverage.json")
    with open(path, encoding="utf-8") as fh:
        cov = json.load(fh)
    rows = {}
    for r in ROWS:
        keep = [x for x in cov["rows"].get(r, []) if x == "F0-smoke"]
        rows[r] = keep + [c.id for c in CASE_LIST if r in c.covers]
        assert rows[r], "uncovered row " + r
    cov["rows"] = rows
    write_text(path, json.dumps(cov, indent=2, ensure_ascii=False) + "\n")
    # protocol
    new_entries = write_protocol_payloads() + protocol_entries()
    mpath = os.path.join(PROTO, "manifest.json")
    with open(mpath, encoding="utf-8") as fh:
        man = json.load(fh)
    mine = set(e["path"] for e in new_entries)
    man["entries"] = [e for e in man["entries"] if e["path"] not in mine] + new_entries
    write_text(mpath, json.dumps(man, indent=2, ensure_ascii=False) + "\n")
    print("oracle sha256 %s: wrote %d cases, %d protocol entries" % (oracle_sha, len(CASE_LIST), len(new_entries)))


if __name__ == "__main__":
    main()
