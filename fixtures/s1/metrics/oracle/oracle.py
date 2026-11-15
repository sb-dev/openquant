#!/usr/bin/env python3
"""Independent derivation of the S1 derived-evidence fixtures (metrics, benchmark, gates).

Run it as `python3 -I oracle.py` from any directory. It reads the S0 fixtures
(`fixtures/s0/cases`), which were derived without the Rust engine, and writes the case
directories under `fixtures/s1/metrics/cases`. Verification never runs it: the Rust tests read the
written files and check only `origin.oracle_sha256` against the hash of this file, so a change to
this script without regenerated expectations fails.

Everything here uses Python's `fractions.Fraction`: no float, no rounding before the end. The
one rounding is `fixed()`, which rounds half to even through `round()` of a `Fraction`. No line
of this file reads Rust code or the output of a Rust program. The method it implements is the
text of `packages/quant-core/src/method.txt`, written from OQ-02 sections 3.1, 3.2 and 3.6; the
expected values of the main cases are also derived by hand in each `derivation.md` and asserted in
`HAND` below, so a mistake common to the script and to the Rust code would still be caught by a
hand derivation.
"""

import copy
import hashlib
import json
import math
import pathlib
import sys
from fractions import Fraction

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
S0 = ROOT.parent.parent / "s0" / "cases"
CASES = ROOT / "cases"
ORACLE_SHA256 = hashlib.sha256((HERE / "oracle.py").read_bytes()).hexdigest()
LIMITATION = (
    "S1 reports no uncertainty statistic: OQ-02 section 3.6 gives no method for one stock. "
    "Development, validation and holdout returns are shown side by side instead."
)


# --------------------------------------------------------------------------------------------
# Exact helpers
# --------------------------------------------------------------------------------------------


def q(text):
    return Fraction(text)


def fixed(value, scale):
    """Round half to even once and write `scale` fractional digits. Never `-0.00`."""
    n = round(value * 10**scale)
    sign = "-" if n < 0 else ""
    digits = str(abs(n)).rjust(scale + 1, "0")
    if scale == 0:
        return sign + digits
    return sign + digits[:-scale] + "." + digits[-scale:]


def floor_to(value, scale):
    return Fraction(math.floor(value * 10**scale), 10**scale)


def ceil_to(value, scale):
    return Fraction(math.ceil(value * 10**scale), 10**scale)


def lowest(value):
    return str(value.numerator) if value.denominator == 1 else f"{value.numerator}/{value.denominator}"


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def read(path):
    return json.loads(pathlib.Path(path).read_text())


def origin(note):
    return {"kind": "oracle", "oracle": "oracle.py", "oracle_sha256": ORACLE_SHA256, "note": note}


# --------------------------------------------------------------------------------------------
# The series figures (OQ-02 section 3.6)
# --------------------------------------------------------------------------------------------


def series_figures(initial, equities, positions):
    """Net return, drawdown from a running peak that starts at `initial`, worst session
    return and exposure of the scored series."""
    peak = initial
    drawdown = Fraction(0)
    previous = initial
    steps = []
    shares = []
    peaks = []
    for equity, value in zip(equities, positions):
        assert equity > 0
        peak = max(peak, equity)
        peaks.append(peak)
        drawdown = max(drawdown, (peak - equity) / peak)
        steps.append(equity / previous)
        shares.append(value / equity)
        previous = equity
    return {
        "net_return": equities[-1] / initial - 1,
        "max_drawdown": drawdown,
        "worst_session_return": min(steps) - 1,
        "exposure": sum(shares) / len(shares),
        "steps": steps,
        "shares": shares,
        "peaks": peaks,
    }


# --------------------------------------------------------------------------------------------
# The benchmark (OQ-02 section 3.6; decision D4)
# --------------------------------------------------------------------------------------------


def policy_numbers(inp):
    policy = inp["policy"]
    model = policy["cost_model"]
    return {
        "money_scale": policy["money_scale"],
        "quantity_scale": policy["quantity_scale"],
        "lot": q(policy["lot_size"]),
        "fixed": q(model["fixed_fee_per_fill"]),
        "bps": q(model["fee_bps"]),
        "withholding": q(policy["corporate_actions"]["withholding_bps"]),
    }


def fee(pn, notional):
    return ceil_to(pn["fixed"] + notional * pn["bps"] / 10000, pn["money_scale"])


def largest_quantity(pn, capital, open_price):
    """The largest lot multiple whose notional plus fee fits the capital, by bisection over
    the number of lots (the fee is monotone in the quantity)."""
    lot = pn["lot"]

    def fits(lots):
        notional = lots * lot * open_price
        return notional + fee(pn, notional) <= capital

    if not fits(1):
        return Fraction(0)
    low, high = 1, 2
    while fits(high):
        low, high = high, high * 2
    while high - low > 1:
        mid = (low + high) // 2
        if fits(mid):
            low = mid
        else:
            high = mid
    return low * lot


def benchmark(inp):
    """Buy-and-hold of the run: `{"status": "COMPUTED", ...}` or `{"status": "INSUFFICIENT", ...}`."""
    pn = policy_numbers(inp)
    sessions = [s["session"] for s in inp["calendar"]["sessions"]]
    bars = {b["session"]: b for b in inp["instruments"][0]["bars"]}
    actions = inp["instruments"][0]["corporate_actions"]
    start = sessions.index(inp["windows"]["scored_start"])
    end = sessions.index(inp["windows"]["scored_end"])
    capital = q(inp["initial_capital"])
    buy = next((i for i in range(start, end + 1) if sessions[i] in bars), None)
    if buy is None:
        return {"status": "INSUFFICIENT", "reason": "no session of the scored window has a bar"}
    open_price = q(bars[sessions[buy]]["open"])
    quantity = largest_quantity(pn, capital, open_price)
    if quantity <= 0:
        return {
            "status": "INSUFFICIENT",
            "reason": "no whole lot is affordable at the first fillable open",
        }
    bought = quantity
    notional = quantity * open_price
    cash = capital - notional - fee(pn, notional)
    entitlements = Fraction(0)
    equities = [capital] * (buy - start)
    for i in range(buy, end + 1):
        date = sessions[i]
        if i > buy:
            held_before = quantity
            for action in actions:
                if action["effective_session"] != date:
                    continue
                if action["kind"] == "SPLIT":
                    scaled = quantity * action["ratio_new"] / action["ratio_old"]
                    if scaled.denominator != 1:
                        return {
                            "status": "INSUFFICIENT",
                            "reason": f"split {action['action_id']} on {date} leaves a fractional share count",
                            "includes": [action["action_id"], date, "fractional"],
                        }
                    quantity = scaled
                elif action["kind"] == "CASH_DIVIDEND":
                    gross = held_before * q(action["amount_per_share"])
                    entitlements += floor_to(gross * (1 - pn["withholding"] / 10000), pn["money_scale"])
                else:
                    return {
                        "status": "INSUFFICIENT",
                        "reason": f"corporate action {action['action_id']} on {date} is not supported",
                        "includes": [action["action_id"], date, "not supported"],
                    }
        if date not in bars:
            return {
                "status": "INSUFFICIENT",
                "reason": f"no bar to value the position at {date}",
                "includes": [date, "no bar to value the position"],
            }
        equities.append(cash + entitlements + quantity * q(bars[date]["close"]))
    result = series_figures(capital, equities, [Fraction(0)] * len(equities))
    return {
        "status": "COMPUTED",
        "entry_session": sessions[buy],
        "quantity": bought,
        "equities": equities,
        "net_return": result["net_return"],
        "max_drawdown": result["max_drawdown"],
        "cash_after_buy": capital - notional - fee(pn, notional),
    }


# --------------------------------------------------------------------------------------------
# Metrics of one S0 case (the journal comes from the S0 expected file)
# --------------------------------------------------------------------------------------------


def s0_case(case_id):
    base = S0 / case_id
    case = read(base / "case.json")
    return {
        "id": case_id,
        "case": case,
        "strategy": base / case["strategy"],
        "input": read(base / case["input"]),
        "expected": read(base / case["expected"]),
    }


def metrics_for(inp, journal, scale):
    """The metrics of a completed S0 case, as the expected files state them."""
    pn = policy_numbers(inp)
    sessions = [s["session"] for s in inp["calendar"]["sessions"]]
    scored_start = inp["windows"]["scored_start"]
    scored_end = inp["windows"]["scored_end"]
    initial = q(inp["initial_capital"])
    daily = [d for d in journal["daily"] if scored_start <= d["session"] <= scored_end]
    equities = [q(d["equity"]) for d in daily]
    values = [q(d["positions_value"]) for d in daily]
    figures = series_figures(initial, equities, values)
    bars = {b["session"]: b for b in inp["instruments"][0]["bars"]}
    fills = [f for f in journal["fills"] if scored_start <= f["session"] <= scored_end]
    notional = sum((q(f["notional"]) for f in fills), Fraction(0))
    fees = sum((q(f["fee"]) for f in fills), Fraction(0))
    slippage = sum(
        (
            q(f["quantity"]) * (q(bars[f["session"]]["open"]) - q(f["price"]))
            for f in fills
            if f["reason"] == "GAP_STOP"
        ),
        Fraction(0),
    )
    trades = [
        t
        for t in journal["trades"]
        if t["exit_reason"] != "OPEN_AT_END" and scored_start <= t.get("exit_session", "") <= scored_end
    ]
    held = benchmark(inp)
    strategy = {
        "net_return": fixed(figures["net_return"], scale),
        "max_drawdown": fixed(figures["max_drawdown"], scale),
        "worst_session_return": fixed(figures["worst_session_return"], scale),
        "turnover": fixed(notional / initial, scale),
        "trade_count": len(trades),
        "scored_session_count": len(daily),
        "fees": fixed(fees, pn["money_scale"]),
        "gap_slippage": fixed(slippage, pn["money_scale"]),
        "total_cost": fixed(fees + slippage, pn["money_scale"]),
        "exposure": fixed(figures["exposure"], scale),
    }
    if held["status"] == "COMPUTED":
        buy_and_hold = {
            "status": "COMPUTED",
            "entry_session": held["entry_session"],
            "quantity": fixed(held["quantity"], pn["quantity_scale"]),
            "net_return": fixed(held["net_return"], scale),
            "max_drawdown": fixed(held["max_drawdown"], scale),
            "excess_return": fixed(figures["net_return"] - held["net_return"], scale),
        }
    else:
        buy_and_hold = {"status": "INSUFFICIENT", "reason_includes": held.get("includes", [held["reason"]])}
    return {
        "window": {"start": daily[0]["session"], "end": daily[-1]["session"]},
        "strategy": strategy,
        "benchmarks": {
            "buy_and_hold": buy_and_hold,
            "cash": {"net_return": fixed(Fraction(0), scale), "excess_return": fixed(figures["net_return"], scale)},
        },
        "_series": {"equity": equities, "positions_value": values, "figures": figures, "initial": initial, "held": held},
        "_totals": {"notional": notional, "fees": fees, "slippage": slippage, "trades": len(trades)},
    }


def public(metrics):
    return {k: v for k, v in metrics.items() if not k.startswith("_")}


# --------------------------------------------------------------------------------------------
# Case writers
# --------------------------------------------------------------------------------------------

CONTEXT = {"run_id": "run-s1-fixture", "window": "DEVELOPMENT", "scenario": "BASE", "currency": "USD", "metric_scale": 6}


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(" --- " for _ in headers) + "|"]
    out += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(out)


def write_metrics_case(case_id, title, s0_id, covers, scale=6, hand=None, notes=""):
    source = s0_case(s0_id)
    outcome = source["expected"]["expect"]["outcome"]
    context = dict(CONTEXT, metric_scale=scale)
    case = {
        "id": case_id,
        "title": title,
        "kind": "metrics",
        "source": f"s0:{s0_id}",
        "covers": covers,
        "context": context,
        "expected": "expected.json",
        "derivation": "derivation.md",
    }
    folder = CASES / case_id
    if outcome["status"] != "COMPLETED":
        expect = {"outcome": outcome["status"], "code": outcome.get("code"), "refusal": "NOT_COMPLETED"}
        write(folder / "case.json", case)
        write(folder / "expected.json", {"schema": "s1-metrics-expected/1", "case": case_id, "origin": origin("A run that did not complete has no metrics."), "expect": expect})
        (folder / "derivation.md").write_text(
            f"# {case_id}: {title}\n\nOrigin: derived by `fixtures/s1/metrics/oracle/oracle.py` from the S0 case `{s0_id}`.\n\n"
            f"The S0 case ends with status {outcome['status']} and code {outcome.get('code')}. Metrics exist only for a `COMPLETED` outcome "
            "(OQ-02 section 3.6), so the expected result is a typed refusal and no metrics document.\n"
        )
        return None
    result = metrics_for(source["input"], source["expected"]["expect"], scale)
    case["scored_check"] = "the engine's daily equity and positions value equal the S0 expectation"
    expect = public(result)
    expect["outcome"] = "COMPLETED"
    expect["series"] = {
        "equity": [fixed(v, source["input"]["policy"]["money_scale"]) for v in result["_series"]["equity"]],
        "positions_value": [fixed(v, source["input"]["policy"]["money_scale"]) for v in result["_series"]["positions_value"]],
    }
    write(folder / "case.json", case)
    write(folder / "expected.json", {"schema": "s1-metrics-expected/1", "case": case_id, "origin": origin("Derived from the S0 journal of the case with exact rational arithmetic."), "expect": expect})
    (folder / "derivation.md").write_text(metrics_derivation(case_id, title, s0_id, source, result, scale, notes))
    if hand:
        hand(result)
    return result


def metrics_derivation(case_id, title, s0_id, source, result, scale, notes):
    inp = source["input"]
    series = result["_series"]
    figures = series["figures"]
    pn = policy_numbers(inp)
    lines = [f"# {case_id}: {title}", ""]
    lines.append(
        f"Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the independently derived journal of the S0 case `{s0_id}` "
        "(`fixtures/s0/cases`, derived without the Rust engine) and its input. Exact rational arithmetic; one half-even rounding "
        f"at the end, ratios to {scale} digits and money to {pn['money_scale']}. Covers: " + "; ".join(source["case"].get("covers", [])) + "."
    )
    if notes:
        lines += ["", notes]
    lines += ["", "## Inputs", ""]
    cost = inp["policy"]["cost_model"]
    lines.append(
        f"- Initial capital E0 = {inp['initial_capital']}; fixed fee {cost['fixed_fee_per_fill']}, fee {cost['fee_bps']} bps, gap-exit slippage "
        f"{cost['gap_exit_slippage_bps']} bps; withholding {inp['policy']['corporate_actions']['withholding_bps']} bps."
    )
    lines.append(f"- Scored sessions: {result['window']['start']} to {result['window']['end']} ({len(series['equity'])} sessions).")
    lines += ["", "## Scored series", ""]
    rows = []
    previous = series["initial"]
    shown = range(len(series["equity"]))
    if len(series["equity"]) > 24:
        shown = list(range(6)) + [i for i, s in enumerate(figures["steps"]) if s != 1][:16]
    sessions = [d["session"] for d in source["expected"]["expect"]["daily"] if result["window"]["start"] <= d["session"] <= result["window"]["end"]]
    for i in shown:
        e = series["equity"][i]
        rows.append((i + 1, sessions[i], fixed(e, 2), fixed(series["positions_value"][i], 2), lowest(figures["steps"][i]), lowest(figures["peaks"][i]), lowest(figures["shares"][i])))
    lines.append(table(["t", "Session", "Equity E(t)", "Positions value", "E(t)/E(t-1)", "Peak P(t)", "Positions / equity"], rows))
    if len(shown) < len(series["equity"]):
        lines.append("")
        lines.append(f"(Rows with a change of equity only; {len(series['equity'])} sessions in all.)")
    initial = series["initial"]
    lines += ["", "## Steps", ""]
    steps = [
        f"net_return = E(n) / E0 - 1 = {lowest(series['equity'][-1])} / {lowest(initial)} - 1 = {lowest(figures['net_return'])} -> {fixed(figures['net_return'], scale)}.",
        f"max_drawdown = max over t of (P(t) - E(t)) / P(t), where P(t) is the highest equity up to t and the series starts at E0: {lowest(figures['max_drawdown'])} -> {fixed(figures['max_drawdown'], scale)}.",
        f"worst_session_return = min of E(t)/E(t-1) minus 1 = {lowest(figures['worst_session_return'])} -> {fixed(figures['worst_session_return'], scale)}.",
        f"turnover = sum of fill notional / E0 = {lowest(result['_totals']['notional'])} / {lowest(initial)} -> {result['strategy']['turnover']}.",
        f"trade_count = {result['strategy']['trade_count']}, the trades closed in the scored period (an open position at the end is not counted); scored_session_count = {result['strategy']['scored_session_count']}.",
        f"execution cost: fees {result['strategy']['fees']} (sum of the fill fees), gap slippage {result['strategy']['gap_slippage']} (quantity times open minus fill price of each GAP_STOP fill), total {result['strategy']['total_cost']}.",
        f"exposure = mean of positions value / equity over the scored sessions = {lowest(figures['exposure'])} -> {fixed(figures['exposure'], scale)}.",
    ]
    held = series["held"]
    if held["status"] == "COMPUTED":
        steps.append(
            f"buy-and-hold buys {fixed(held['quantity'], pn['quantity_scale'])} shares at the open of {held['entry_session']} (cash after the buy {fixed(held['cash_after_buy'], pn['money_scale'])}); "
            f"net return {lowest(held['net_return'])} -> {result['benchmarks']['buy_and_hold']['net_return']}, max drawdown -> {result['benchmarks']['buy_and_hold']['max_drawdown']}; "
            f"excess = {lowest(figures['net_return'])} - {lowest(held['net_return'])} -> {result['benchmarks']['buy_and_hold']['excess_return']}."
        )
    else:
        steps.append(f"buy-and-hold is unavailable: {held['reason']}.")
    steps.append(f"cash benchmark: net_return {fixed(Fraction(0), scale)}, excess_return equals the strategy net_return {fixed(figures['net_return'], scale)}.")
    lines += [f"{i + 1}. {s}" for i, s in enumerate(steps)]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------------------------
# Hand derivations: values derived on paper, asserted against the script
# --------------------------------------------------------------------------------------------


def hand_x09a(result):
    # X-09a: E0 5000.00. Scored closes: 5000.00 5000.00 4999.00 5018.00 5002.80 5188.00.
    # Fills: buy 19 at 50.00 (950.00, fee 1.00) and sell 19 at 60.00 (1140.00, fee 1.00).
    s = result["strategy"]
    assert s["net_return"] == fixed(Fraction(5188, 5000) - 1, 6) == "0.037600"
    # Peak 5018.00, trough 5002.80: (5018 - 5002.8) / 5018 = 15.2 / 5018 = 0.0030290...
    assert s["max_drawdown"] == fixed(Fraction(152, 10) / 5018, 6) == "0.003029"
    assert s["worst_session_return"] == "-0.003029"
    assert s["turnover"] == fixed(Fraction(950 + 1140, 5000), 6) == "0.418000"
    assert (s["fees"], s["gap_slippage"], s["total_cost"]) == ("2.00", "0.00", "2.00")
    assert (s["trade_count"], s["scored_session_count"]) == (1, 6)
    exposure = (Fraction(950, 4999) + Fraction(969, 5018) + Fraction(9538, 10) / Fraction(50028, 10)) / 6
    assert s["exposure"] == fixed(exposure, 6)
    # Buy and hold: 99 shares at 50 (4950.00 + fee 1.00, cash 49.00); closes 50 51 50 51 50.2 59.
    # Final equity 49 + 99 * 59 = 5890.00; peak 5098.00 (99 * 51 + 49), trough 4999.00.
    bh = result["benchmarks"]["buy_and_hold"]
    assert bh["quantity"] == "99" and bh["entry_session"] == "2026-01-08"
    assert bh["net_return"] == fixed(Fraction(5890, 5000) - 1, 6) == "0.178000"
    assert bh["max_drawdown"] == fixed(Fraction(5098 - 4999, 5098), 6) == "0.019419"
    assert bh["excess_return"] == fixed(Fraction(188, 5000) - Fraction(890, 5000), 6) == "-0.140400"


def hand_x09b(result):
    # X-09b: the same entry; the stop sells 19 at 50.00 on 01-14. Closes 5000 5000 4999 5018 4998 4998.
    s = result["strategy"]
    assert s["net_return"] == fixed(Fraction(4998, 5000) - 1, 6) == "-0.000400"
    # 20 / 5018 = 0.0039856...: the sixth digit rounds up.
    assert s["max_drawdown"] == fixed(Fraction(5018 - 4998, 5018), 6) == "0.003986"
    assert s["worst_session_return"] == fixed(Fraction(4998, 5018) - 1, 6) == "-0.003986"
    assert s["turnover"] == fixed(Fraction(1900, 5000), 6) == "0.380000"
    assert s["exposure"] == fixed((Fraction(950, 4999) + Fraction(969, 5018)) / 6, 6)


def hand_x05(result):
    # X-05: fee 1.00 + 10 bps, slippage 100 bps. Buy 19 at 50.00 (950.00, fee 1.00 + 0.95 = 1.95).
    # On 01-13 the open 44.37 gaps through the stop: fill floor(44.37 * 0.99) = 43.92; notional
    # 19 * 43.92 = 834.48, fee ceil(1.00 + 0.83448) = 1.84. Gap slippage 19 * (44.37 - 43.92) = 8.55.
    s = result["strategy"]
    assert s["fees"] == "3.79" and s["gap_slippage"] == "8.55" and s["total_cost"] == "12.34"
    assert s["trade_count"] == 1
    assert s["net_return"] == fixed(Fraction(488069, 100) / 5000 - 1, 6)  # 4880.69 final equity


def hand_x08(result):
    # X-08: four trades with fee 1.00 each side (8 fills = 8.00) and slippage 100 bps. The GAP_STOP
    # fill is 21 shares at 43.56 after an open of 44.00: 21 * (44.00 - 43.56) = 9.24.
    s = result["strategy"]
    assert s["fees"] == "8.00" and s["gap_slippage"] == "9.24" and s["total_cost"] == "17.24"
    assert s["trade_count"] == 4


def hand_r01(result):
    # R-01: E0 10000.00, five fills: 1900 + 1900 + 1900 + 2280 + 2028 = 10008.00 of notional.
    s = result["strategy"]
    assert s["turnover"] == fixed(Fraction(10008, 10000), 6) == "1.000800"
    assert s["trade_count"] == 2
    # Fees: 2.90 + 2.90 + 2.90 + 3.28 + 3.03 = 15.01.
    assert s["fees"] == "15.01"
    assert s["net_return"] == fixed(Fraction(1053267, 100) / 10000 - 1, 6)  # final equity 10532.67


def hand_f0(result):
    s = result["strategy"]
    assert s["trade_count"] == 1


def build_metrics_cases():
    write_metrics_case("M-01", "A winning run: one TARGET trade under a fixed fee", "X-09a", ["winning run", "fees", "drawdown", "exposure", "buy-and-hold"], hand=hand_x09a)
    write_metrics_case("M-02", "A losing run: one STOP trade, whose loss is also the worst session and the drawdown", "X-09b", ["losing run", "negative return"], hand=hand_x09b)
    write_metrics_case("M-03", "A split and a dividend inside the holding period, three trades, costs and withholding", "R-01", ["split", "dividend", "costs", "turnover over several round trips"], hand=hand_r01)
    write_metrics_case("M-04", "Four closed trades: STOP, TARGET, GAP_STOP and GAP_TARGET", "X-08", ["gap slippage", "fixed fees summed", "trade count"], hand=hand_x08)
    write_metrics_case("M-05", "A gap-through-stop exit with a fee in basis points", "X-05", ["gap slippage reconstructed against the open", "fee rounding up"], hand=hand_x05)
    write_metrics_case("M-06", "A dividend entitled in the run and paid inside it; the position is open at the end", "C-03", ["dividend receivable", "open position at the end", "trade not counted"])
    write_metrics_case("M-07", "A split and a dividend on the same ex-date; the dividend uses the quantity before the split", "C-05", ["split and dividend on one day"])
    write_metrics_case("M-08", "A dividend paid at the ex-date before the open, a closed trade and a re-entry", "C-04a", ["dividend payment", "re-entry", "open position at the end"])
    write_metrics_case("M-09", "The lead's hand-derived smoke case", "F0-smoke", ["smoke case derived by hand", "open position at the end"], hand=hand_f0)
    write_metrics_case("M-10", "A run that never trades: every figure is zero and the benchmark is computed", "ENT-02-v1", ["no trade", "zero turnover", "zero exposure"])
    write_metrics_case("M-11", "A long run: 94 scored sessions, one position opened late and never closed", "SEM-04", ["exposure over many sessions", "open position at the end"])
    write_metrics_case("M-12", "A fixed fee of 19.90 and 0.05 bps on a capital of 4999.50", "X-03", ["fee rounding", "non-round capital"])
    write_metrics_case("M-13", "A gap-stop exit in a 64-session run", "DEF-02-v4", ["gap slippage in a long run"])
    write_metrics_case("M-14", "Ratio scale 12", "R-01", ["metric_scale 12"], scale=12)
    write_metrics_case("M-15", "Ratio scale 0: every ratio rounds to a whole number and never to -0", "X-08", ["metric_scale 0"], scale=0)
    write_metrics_case("M-16", "An INSUFFICIENT outcome has no metrics", "C-02", ["INSUFFICIENT outcome"])
    write_metrics_case("M-17", "A FAILED outcome (INVALID_LEVEL) has no metrics", "G-07a", ["FAILED outcome"])
    write_metrics_case("M-18", "An INSUFFICIENT outcome (unsupported valuation) has no metrics", "I-07", ["INSUFFICIENT outcome", "halt"])

# --------------------------------------------------------------------------------------------
# Series cases: the figures of a hand-written equity series (no engine)
# --------------------------------------------------------------------------------------------


def write_series_case(case_id, title, initial, points, scale, covers, notes):
    figures = series_figures(q(initial), [q(e) for e, _ in points], [q(v) for _, v in points])
    expect = {
        "net_return": fixed(figures["net_return"], scale),
        "max_drawdown": fixed(figures["max_drawdown"], scale),
        "worst_session_return": fixed(figures["worst_session_return"], scale),
        "exposure": fixed(figures["exposure"], scale),
    }
    folder = CASES / case_id
    write(folder / "case.json", {"id": case_id, "title": title, "kind": "series", "covers": covers, "series": "series.json", "expected": "expected.json", "derivation": "derivation.md"})
    write(folder / "series.json", {"initial_capital": initial, "metric_scale": scale, "points": [{"equity": e, "positions_value": v} for e, v in points]})
    write(folder / "expected.json", {"schema": "s1-metrics-expected/1", "case": case_id, "origin": origin("Derived from the series with exact rational arithmetic."), "expect": expect})
    if len(points) <= 12:
        rows = [(i + 1, e, v, lowest(figures["steps"][i]), lowest(figures["peaks"][i]), lowest(figures["shares"][i])) for i, (e, v) in enumerate(points)]
        grid = table(["t", "Equity", "Positions value", "E(t)/E(t-1)", "Peak P(t)", "Positions / equity"], rows)
    else:
        grid = f"{len(points)} sessions, generated by the script's linear congruential generator; see `series.json`."
    text = [
        f"# {case_id}: {title}",
        "",
        f"Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic; the series is written for this case and no engine runs it. {notes}",
        "",
        f"Initial capital E0 = {initial}; metric scale {scale}.",
        "",
        grid,
        "",
        "## Results",
        "",
        f"1. net_return = E(n)/E0 - 1 = {lowest(figures['net_return'])} -> {expect['net_return']}.",
        f"2. max_drawdown = {lowest(figures['max_drawdown'])} -> {expect['max_drawdown']}.",
        f"3. worst_session_return = {lowest(figures['worst_session_return'])} -> {expect['worst_session_return']}.",
        f"4. exposure = {lowest(figures['exposure'])} -> {expect['exposure']}.",
    ]
    (folder / "derivation.md").write_text("\n".join(text) + "\n")
    return expect, figures


def lcg_series(seed, count, initial_cents):
    """A deterministic pseudo-random walk in whole cents, so the case needs no random module."""
    state = seed
    equity = initial_cents
    points = []
    for _ in range(count):
        state = (state * 6364136223846793005 + 1442695040888963407) % 2**64
        delta = (state >> 33) % 641 - 320
        equity = max(equity + delta * 7, 100)
        state = (state * 6364136223846793005 + 1442695040888963407) % 2**64
        share = (state >> 33) % 17
        value = equity * share // 16
        points.append((fixed(Fraction(equity, 100), 2), fixed(Fraction(value, 100), 2)))
    return points


def build_series_cases():
    # Equal peaks, equal troughs and equal-depth drawdowns from different peaks.
    expect, _ = write_series_case(
        "S-01", "Drawdown ties: an equal peak, an equal trough and an equal depth from a different peak",
        "100", [("110", "0"), ("99", "0"), ("110", "0"), ("99", "0"), ("120", "0"), ("108", "0"), ("120", "0")], 6,
        ["drawdown ties"],
        "Peaks 110, 110 and 120; troughs 99, 99 and 108. Each fall is a tenth of its peak: 11/110, 11/110, 12/120.",
    )
    assert expect["max_drawdown"] == "0.100000"  # hand: 11/110 = 12/120 = 1/10
    expect, _ = write_series_case("S-02", "A flat series: no return, no drawdown, no move", "100", [("100", "0"), ("100", "0"), ("100", "0")], 6, ["flat series"], "Nothing moves, so every ratio is zero.")
    assert expect == {"net_return": "0.000000", "max_drawdown": "0.000000", "worst_session_return": "0.000000", "exposure": "0.000000"}
    expect, _ = write_series_case("S-03", "The first scored session loses: the drawdown peak is the initial capital", "100", [("90", "0"), ("95", "0"), ("99", "0")], 6, ["first-session loss", "peak includes E0"], "The series itself never falls after its first value, yet the fall from E0 = 100 to 90 is a drawdown of 1/10.")
    assert expect["max_drawdown"] == "0.100000" and expect["worst_session_return"] == "-0.100000"
    expect, _ = write_series_case("S-04", "Every session rises: the worst session return is positive", "100", [("101", "0"), ("103", "0"), ("106", "0")], 6, ["positive worst session"], "Steps 101/100, 103/101 and 106/103; the smallest is 101/100.")
    assert expect["worst_session_return"] == "0.010000" and expect["max_drawdown"] == "0.000000"
    expect, _ = write_series_case("S-05", "Exposure as a mean of 1/3, 1/6 and 1/7", "300", [("300", "100"), ("600", "100"), ("700", "100")], 6, ["non-terminating exposure"], "Hand: (1/3 + 1/6 + 1/7) / 3 = (14 + 7 + 6) / 126 = 3/14 = 0.2142857...")
    assert expect["exposure"] == "0.214286"
    for case_id, final, want, note in [
        ("S-06a", "10000015", "0.000002", "The net return is 15/10000000 = 0.0000015, a tie between 0.000001 and 0.000002: the even digit 2."),
        ("S-06b", "10000025", "0.000002", "0.0000025 is a tie between 0.000002 and 0.000003: the even digit 2."),
        ("S-06c", "9999985", "-0.000002", "The negative twin of S-06a: -0.0000015 rounds to -0.000002."),
        ("S-06d", "10000005", "0.000000", "0.0000005 is a tie between 0.000000 and 0.000001: the even digit 0."),
        ("S-06e", "9999995", "0.000000", "The negative twin -0.0000005 rounds to zero and is written without a sign."),
    ]:
        expect, _ = write_series_case(case_id, "Half-even rounding at a tie of the sixth digit", "10000000", [(final, "0")], 6, ["half-even tie"], note)
        assert expect["net_return"] == want, (case_id, expect)
    expect, _ = write_series_case("S-07a", "Ratio scale 12", "3", [("4", "1")], 12, ["scale 12"], "Net return 4/3 - 1 = 1/3 = 0.333333333333...; exposure 1/4.")
    assert expect["net_return"] == "0.333333333333" and expect["exposure"] == "0.250000000000"
    expect, _ = write_series_case("S-07b", "Ratio scale 0", "3", [("4", "1")], 0, ["scale 0"], "Net return 1/3 rounds to 0; exposure 1/4 rounds to 0.")
    assert expect["net_return"] == "0" and expect["exposure"] == "0"
    points = lcg_series(20260101, 250, 10_000_000)
    expect, figures = write_series_case("S-08", "250 sessions: exposure over a denominator far beyond 128 bits", "100000.00", points, 6, ["bignum exposure", "250 sessions"], "")
    assert figures["exposure"].denominator.bit_length() > 128, figures["exposure"].denominator.bit_length()


# --------------------------------------------------------------------------------------------
# Benchmark cases
# --------------------------------------------------------------------------------------------


def halt_for(inp, date, event_id="HALT-1"):
    """Remove the bar of `date` and confirm a halt for it, so the input still prepares."""
    inp["instruments"][0]["bars"] = [b for b in inp["instruments"][0]["bars"] if b["session"] != date]
    inp["instruments"][0]["unplanned_events"].append(
        {"event_id": event_id, "kind": "CONFIRMED_HALT", "effective_session": date, "available_at": f"{date}T13:30:00Z"}
    )


def write_benchmark_case(case_id, title, s0_id, inp, covers, notes, patched=True, scale=6):
    folder = CASES / case_id
    held = benchmark(inp)
    pn = policy_numbers(inp)
    case = {
        "id": case_id,
        "title": title,
        "kind": "benchmark",
        "source": f"s0:{s0_id}",
        "covers": covers,
        "input": "input.json" if patched else f"s0:{s0_id}",
        "metric_scale": scale,
        "expected": "expected.json",
        "derivation": "derivation.md",
    }
    if patched:
        write(folder / "input.json", inp)
    write(folder / "case.json", case)
    if held["status"] == "COMPUTED":
        expect = {
            "status": "COMPUTED",
            "entry_session": held["entry_session"],
            "quantity": fixed(held["quantity"], pn["quantity_scale"]),
            "equities": [fixed(e, pn["money_scale"]) for e in held["equities"]],
            "net_return": fixed(held["net_return"], scale),
            "max_drawdown": fixed(held["max_drawdown"], scale),
        }
    else:
        expect = {"status": "INSUFFICIENT", "reason_includes": held.get("includes", [held["reason"]])}
    write(folder / "expected.json", {"schema": "s1-metrics-expected/1", "case": case_id, "origin": origin("Derived from the input with exact rational arithmetic."), "expect": expect})
    text = [f"# {case_id}: {title}", "", f"Origin: `fixtures/s1/metrics/oracle/oracle.py`, exact rational arithmetic, from {'a patched copy of ' if patched else ''}the input of the S0 case `{s0_id}`. {notes}", ""]
    cost = inp["policy"]["cost_model"]
    text.append(f"- Capital {inp['initial_capital']}; fixed fee {cost['fixed_fee_per_fill']}, fee {cost['fee_bps']} bps; scored window {inp['windows']['scored_start']} to {inp['windows']['scored_end']}.")
    if held["status"] == "COMPUTED":
        sessions = [s["session"] for s in inp["calendar"]["sessions"]]
        start = sessions.index(inp["windows"]["scored_start"])
        text += [
            f"- The buy is the open of {held['entry_session']}: {fixed(held['quantity'], pn['quantity_scale'])} shares, cash after the buy {fixed(held['cash_after_buy'], pn['money_scale'])}.",
            "",
            table(["Session", "Equity after the close"], [(sessions[start + i], fixed(e, pn["money_scale"])) for i, e in enumerate(held["equities"])]),
            "",
            f"net_return = {lowest(held['equities'][-1])} / {inp['initial_capital']} - 1 = {lowest(held['net_return'])} -> {expect['net_return']}; max_drawdown {lowest(held['max_drawdown'])} -> {expect['max_drawdown']}.",
        ]
    else:
        text += ["", f"The benchmark is unavailable: {held['reason']}."]
    (folder / "derivation.md").write_text("\n".join(text) + "\n")
    return held


def s0_input(case_id):
    return copy.deepcopy(s0_case(case_id)["input"])


def build_benchmark_cases():
    held = write_benchmark_case("B-01", "Buy and hold at the first scored open under a fixed fee", "X-09a", s0_input("X-09a"), ["simple buy and hold", "fee in the lot search"], "Hand: 99 shares at 50.00 cost 4950.00 + 1.00; 100 shares would cost 5001.00.", patched=False)
    assert held["quantity"] == 99 and fixed(held["net_return"], 6) == "0.178000"
    held = write_benchmark_case("B-02", "A 2-for-1 split inside the window doubles the quantity", "C-01a", s0_input("C-01a"), ["split"], "Hand: 50 shares at 100.00 (capital 5000, no fee); closes 100 101 100 102, then the split on 01-14 gives 100 shares at 51.50 and 52.", patched=False)
    assert held["quantity"] == 50 and [fixed(e, 2) for e in held["equities"]] == ["5000.00", "5050.00", "5000.00", "5100.00", "5150.00", "5200.00"]
    assert fixed(held["net_return"], 6) == "0.040000" and fixed(held["max_drawdown"], 6) == fixed(Fraction(50, 5050), 6) == "0.009901"

    inp = s0_input("C-03")
    inp["calendar"]["sessions"].append({"session": "2026-01-16", "open_at": "2026-01-16T14:30:00Z", "close_at": "2026-01-16T21:00:00Z"})
    inp["instruments"][0]["corporate_actions"].append({"kind": "CASH_DIVIDEND", "action_id": "DIV-2", "effective_session": "2026-01-14", "available_at": "2026-01-14T06:00:00Z", "amount_per_share": "0.25", "payment_session": "2026-01-16", "payment_phase": "AFTER_CLOSE"})
    held = write_benchmark_case("B-03", "A dividend paid inside the window and one paid after its end", "C-03", inp, ["dividend paid inside", "dividend paid after the end"], "The second dividend pays on 2026-01-16, a calendar session after the scored end: its receivable stays in equity at the final mark. Hand: 100 shares; 100.00 on 01-13, 25.00 on 01-14.")
    assert held["quantity"] == 100
    assert fixed(held["equities"][-1], 2) == "5025.00" and fixed(held["net_return"], 6) == "0.005000"

    inp = s0_input("X-09a")
    halt_for(inp, "2026-01-08")
    held = write_benchmark_case("B-04", "The first scored session has no bar: the buy is the next session's open", "X-09a", inp, ["no bar at the first scored session", "confirmed halt"], "Hand: the open of 2026-01-09 is 50; 99 shares, cash 49.00; closes 51 50 51 50.2 59. Equity before the buy is the capital.")
    assert held["entry_session"] == "2026-01-09" and held["quantity"] == 99 and fixed(held["equities"][0], 2) == "5000.00"

    inp = s0_input("X-09a")
    inp["initial_capital"] = "40.00"
    held = write_benchmark_case("B-05", "No whole lot is affordable at the first open", "X-09a", inp, ["unaffordable lot"], "One share costs 50.00 plus a fee of 1.00, above the capital of 40.00.")
    assert held["status"] == "INSUFFICIENT"

    inp = s0_input("C-01a")
    inp["initial_capital"] = "4950.00"
    inp["instruments"][0]["corporate_actions"][0].update({"ratio_new": 3, "ratio_old": 2})
    held = write_benchmark_case("B-06", "A 3-for-2 split on an odd quantity leaves a fractional share count", "C-01a", inp, ["fractional entitlement"], "49 shares at 100.00 with no fee; 49 * 3 / 2 = 73.5 is not a whole number of shares.")
    assert held["status"] == "INSUFFICIENT" and "fractional" in held["reason"]

    for case_id, bps, quantity in [("B-07a", "100", 100), ("B-07b", "200", 99)]:
        inp = s0_input("X-09a")
        inp["initial_capital"] = "5050.00"
        inp["policy"]["cost_model"].update({"fixed_fee_per_fill": "0.00", "fee_bps": bps})
        held = write_benchmark_case(case_id, f"The fee boundary: costs of {bps} bps ({'base' if bps == '100' else 'twice the base'})", "X-09a", inp, ["fee in the lot search", "cost stress changes the quantity"], f"Hand: at {bps} bps, 100 shares cost 5000.00 + {fixed(Fraction(5000) * q(bps) / 10000, 2)}; the capital is 5050.00, so the largest quantity is {quantity}.")
        assert held["quantity"] == quantity, (case_id, held["quantity"])

    inp = s0_input("X-09a")
    halt_for(inp, "2026-01-13")
    held = write_benchmark_case("B-08", "A session without a bar while the position is held", "X-09a", inp, ["unsupported valuation"], "The position bought on 01-08 cannot be valued on the halted 2026-01-13.")
    assert held["status"] == "INSUFFICIENT"

    inp = s0_input("X-09a")
    inp["windows"]["scored_end"] = "2026-01-08"
    halt_for(inp, "2026-01-08")
    held = write_benchmark_case("B-09", "No session of the scored window has a bar", "X-09a", inp, ["no bar in the window"], "The one scored session is halted.")
    assert held["status"] == "INSUFFICIENT" and held["reason"] == "no session of the scored window has a bar"

    inp = s0_input("X-09a")
    inp["instruments"][0]["corporate_actions"] += [
        {"kind": "CASH_DIVIDEND", "action_id": "DIV-A", "effective_session": "2026-01-08", "available_at": "2026-01-08T06:00:00Z", "amount_per_share": "0.50", "payment_session": "2026-01-12", "payment_phase": "BEFORE_OPEN"},
        {"kind": "CASH_DIVIDEND", "action_id": "DIV-B", "effective_session": "2026-01-13", "available_at": "2026-01-13T06:00:00Z", "amount_per_share": "0.40", "payment_session": "2026-01-14", "payment_phase": "BEFORE_OPEN"},
    ]
    held = write_benchmark_case("B-10", "A dividend on the buy session pays nothing; a later one pays on the shares held", "X-09a", inp, ["no entitlement on the buy session"], "Hand: 99 shares are bought at the open of the ex-date 01-08, so DIV-A is worth 0.00; DIV-B pays 99 * 0.40 = 39.60 on 01-13.")
    assert [fixed(e, 2) for e in held["equities"]] == ["4999.00", "5098.00", "4999.00", "5137.60", "5058.40", "5929.60"]

    held = write_benchmark_case("B-11", "A split and a dividend on one ex-date: the dividend counts the shares held before the split", "C-05", s0_input("C-05"), ["split and dividend on one day"], "Hand: 50 shares at 100.00; on 01-14 the dividend of 1.00 is paid on the 50 shares held before the split (50.00), then the split gives 100 shares.", patched=False)
    assert held["quantity"] == 50 and fixed(held["equities"][-2], 2) == fixed(Fraction(100) * q("51.5") + 50, 2)

    held = write_benchmark_case("B-12", "An unsupported corporate action makes the benchmark unavailable", "C-06", s0_input("C-06"), ["unsupported action"], "The special distribution SD-1 on 2026-01-13 has no S1 semantics.", patched=False)
    assert held["status"] == "INSUFFICIENT" and "SD-1" in held["reason"]

# --------------------------------------------------------------------------------------------
# Gates (OQ-02 sections 3.2 and 3.6; decision D18)
# --------------------------------------------------------------------------------------------

PILOT_POLICY = ROOT.parents[1] / "protocol" / "valid" / "cohort-policy.s1-pilot.json"
WINDOW_ORDER = ["DEVELOPMENT", "VALIDATION", "HOLDOUT"]
CANDIDATE_DEFECTS = {"INVALID_LEVEL", "UNSUPPORTED_OPERATOR", "OPERATOR_TYPE_MISMATCH", "OPERATOR_UNIT_MISMATCH", "INVALID_PARAMETER"}
THRESHOLD_GATES = {"EXCESS_OVER_BUY_AND_HOLD", "WALK_FORWARD", "MINIMUM_TRADE_COUNT", "COST_STRESS"}
UNSUPPORTED_REQUIRED = {"PARAMETER_SENSITIVITY", "EXECUTION_DELAY", "ADVERSE_REGIMES", "RESAMPLING", "PROSPECTIVE_EVIDENCE", "PORTFOLIO_FIT", "OPERATING_READINESS"}


def digest(kind, name):
    return "sha256:" + hashlib.sha256(f"{kind}:{name}".encode()).hexdigest()


def offline_policy():
    """The separate test policy of the PASS path: the three robustness checks that the pilot
    records as INSUFFICIENT are NOT_APPLICABLE with a reason, so a candidate can pass."""
    policy = read(PILOT_POLICY)
    policy["policy_id"] = "s1-offline-pass"
    for rule in policy["gates"]:
        if rule["requirement"] == "RECORDED_INSUFFICIENT":
            rule["requirement"] = "NOT_APPLICABLE"
            rule["reason"] = "The offline test suite has no " + rule["gate"].lower().replace("_", " ") + " check; the PASS path is exercised without it."
    return policy


def standard_runs():
    """A candidate that passes every gate of the offline policy."""
    cost = {"fixed_fee_per_fill": "0.00", "fee_bps": "5", "gap_exit_slippage_bps": "10"}
    stress = {"fixed_fee_per_fill": "0.00", "fee_bps": "10", "gap_exit_slippage_bps": "20"}
    values = {
        ("DEVELOPMENT", "BASE"): ("0.067310", "0.017310", 11),
        ("VALIDATION", "BASE"): ("0.041873", "0.012873", 12),
        ("HOLDOUT", "BASE"): ("0.030250", "0.004250", 10),
        ("DEVELOPMENT", "COST_STRESS"): ("0.063127", "0.013127", 11),
        ("VALIDATION", "COST_STRESS"): ("0.037402", "0.008402", 12),
        ("HOLDOUT", "COST_STRESS"): ("0.026100", "0.000100", 10),
    }
    runs = []
    for (window, scenario), (net, excess, trades) in values.items():
        rid = f"run-{window[0].lower()}-{'base' if scenario == 'BASE' else 'stress'}"
        runs.append({
            "run_id": rid,
            "window": window,
            "scenario": scenario,
            "repeat_of": None,
            "submission": digest("submission", rid),
            "result": digest("result", rid),
            "metrics_digest": digest("metrics", rid),
            "outcome": {"kind": "COMPLETED"},
            "metrics": {"net_return": net, "excess_return": excess, "trade_count": trades, "buy_and_hold": "COMPUTED"},
            "cost": dict(cost if scenario == "BASE" else stress),
            "checks": {"reconciliation": "PASS", "timing": "PASS"},
        })
    replay = copy.deepcopy(runs[0])
    replay.update({"run_id": "run-d-base-replay", "repeat_of": "run-d-base", "submission": digest("submission", "run-d-base-replay"), "metrics_digest": digest("metrics", "run-d-base-replay")})
    runs.append(replay)
    return runs


def standard_evidence():
    return {
        "plan": digest("plan", "s1"),
        "validation": {"status": "VALID", "digest": digest("validation", "s1")},
        "manifest": {"digest": digest("manifest", "s1"), "bars_without_availability": 0, "actions_without_availability": 0},
        "runs": standard_runs(),
    }


def find(evidence, run_id):
    return next(r for r in evidence["runs"] if r["run_id"] == run_id)


def run_unavailable(run):
    """(reason code, text that the reason must include) of a run without evidence, else None."""
    kind = run["outcome"]["kind"]
    code = run["outcome"].get("code")
    if kind == "COMPLETED":
        return None
    if kind == "MISSING":
        return "RUN_MISSING", [run["run_id"]]
    if kind in ("FAILED", "NOT_PREPARED"):
        if code == "ARITHMETIC_OVERFLOW":
            return "OUTSIDE_ENGINE_DOMAIN", [run["run_id"], "ARITHMETIC_OVERFLOW"]
        return "RUN_FAILED", [run["run_id"], code]
    return "RUN_INSUFFICIENT", [run["run_id"], code]


def metric_value(run, metric):
    metrics = run["metrics"]
    if metric == "net_return":
        return metrics["net_return"]
    if metric == "trade_count":
        return str(metrics["trade_count"])
    if metric == "excess_return_over_buy_and_hold":
        return metrics["excess_return"] if metrics["buy_and_hold"] == "COMPUTED" else None
    raise AssertionError(metric)


def compare(observed, comparison, threshold):
    o, t = Fraction(observed), Fraction(threshold)
    return {"GREATER_THAN": o > t, "AT_LEAST": o >= t, "LESS_THAN": o < t, "AT_MOST": o <= t}[comparison]


def threshold_gate(rule, runs):
    observations, evidence = [], []
    failed, missing = False, None
    for threshold in rule["thresholds"]:
        for window in threshold["windows"]:
            found = [r for r in runs if r["repeat_of"] is None and r["window"] == window and r["scenario"] == threshold["cost_scenario"]]
            if not found:
                missing = missing or ("RUN_MISSING", [window])
                continue
            run = found[0]
            gone = run_unavailable(run)
            if gone:
                missing = missing or gone
                continue
            if run["metrics"] is None:
                missing = missing or ("METRICS_UNAVAILABLE", [run["run_id"]])
                continue
            observed = metric_value(run, threshold["metric"])
            if observed is None:
                missing = missing or ("BENCHMARK_UNAVAILABLE", [run["run_id"]])
                continue
            holds = compare(observed, threshold["comparison"], threshold["value"])
            failed = failed or not holds
            if run["submission"] not in evidence:
                evidence.append(run["submission"])
            observations.append({"run_id": run["run_id"], "metric": threshold["metric"], "window": window, "cost_scenario": threshold["cost_scenario"], "observed": observed, "comparison": threshold["comparison"], "threshold": threshold["value"], "holds": holds})
    if failed and rule["below_threshold"] == "FAIL":
        return {"result": "FAIL", "evidence": evidence, "observations": observations}
    if failed:
        return {"result": "INSUFFICIENT", "reason_code": "BELOW_THRESHOLD", "reason_includes": ["does not hold"], "evidence": evidence, "observations": observations}
    if missing:
        return {"result": "INSUFFICIENT", "reason_code": missing[0], "reason_includes": missing[1], "evidence": evidence, "observations": observations}
    return {"result": "PASS", "evidence": evidence, "observations": observations}


def expected_policy_cost(policy, scenario):
    base = policy["conditions"]["execution_policy"]["cost_model"]
    stress = policy["conditions"]["cost_stress"]
    out = {}
    for key in ("fixed_fee_per_fill", "fee_bps", "gap_exit_slippage_bps"):
        factor = Fraction(stress["multiplier"]) if scenario == "COST_STRESS" and key in stress["components"] else Fraction(1)
        out[key] = Fraction(base[key]) * factor
    return out


def gate_outcomes(policy, evidence):
    runs = evidence["runs"]
    outcomes = []
    for rule in policy["gates"]:
        gate, category = rule["gate"], rule["category"]
        if rule["requirement"] in ("NOT_APPLICABLE", "RECORDED_INSUFFICIENT"):
            outcomes.append({"result": "NOT_APPLICABLE" if rule["requirement"] == "NOT_APPLICABLE" else "INSUFFICIENT", "gate": gate, "category": category, "reason_code": "POLICY_RECORDED", "reason": rule["reason"]})
            continue
        if gate in UNSUPPORTED_REQUIRED:
            raise ValueError(f"UnsupportedRequiredGate {gate}")
        if gate in THRESHOLD_GATES:
            decision = threshold_gate(rule, runs)
        elif gate == "DEFINITION_VALIDATION":
            defect = next((r for r in runs if r["outcome"]["kind"] in ("FAILED", "NOT_PREPARED") and r["outcome"].get("code") in CANDIDATE_DEFECTS), None)
            validation = evidence["validation"]
            cited = [validation["digest"]] if validation["status"] != "MISSING" else []
            if defect:
                decision = {"result": "FAIL", "evidence": cited + [defect["submission"]], "observations": []}
            elif validation["status"] == "INVALID":
                decision = {"result": "FAIL", "evidence": cited, "observations": []}
            elif validation["status"] == "MISSING":
                decision = {"result": "INSUFFICIENT", "reason_code": "VALIDATION_FAILED", "reason_includes": ["validation"]}
            else:
                decision = {"result": "PASS", "evidence": cited, "observations": []}
        elif gate == "DETERMINISTIC_REPLAY":
            repeats = [r for r in runs if r["repeat_of"]]
            if not repeats:
                decision = {"result": "INSUFFICIENT", "reason_code": "RUN_MISSING", "reason_includes": ["repeat"]}
            else:
                cited, differing, missing = [], False, None
                for repeat in repeats:
                    base = next((r for r in runs if r["repeat_of"] is None and r["run_id"] == repeat["repeat_of"]), None)
                    if base is None:
                        missing = missing or ("RUN_MISSING", [repeat["repeat_of"]])
                        continue
                    gone = run_unavailable(base) or run_unavailable(repeat)
                    if gone:
                        missing = missing or gone
                        continue
                    for r in (base, repeat):
                        if r["submission"] not in cited:
                            cited.append(r["submission"])
                    differing = differing or base["result"] != repeat["result"]
                if differing:
                    decision = {"result": "FAIL", "evidence": cited, "observations": []}
                elif missing:
                    decision = {"result": "INSUFFICIENT", "reason_code": missing[0], "reason_includes": missing[1], "evidence": cited}
                else:
                    decision = {"result": "PASS", "evidence": cited, "observations": []}
        elif gate in ("ACCOUNTING_RECONCILIATION", "SIGNAL_DATA_TIMING"):
            key = "reconciliation" if gate == "ACCOUNTING_RECONCILIATION" else "timing"
            if not runs:
                decision = {"result": "INSUFFICIENT", "reason_code": "RUN_MISSING", "reason_includes": ["run"]}
            else:
                cited, failing, missing = [], False, None
                for run in runs:
                    gone = run_unavailable(run)
                    if gone:
                        missing = missing or gone
                        continue
                    if run["submission"] not in cited:
                        cited.append(run["submission"])
                    failing = failing or run["checks"][key] != "PASS"
                if failing:
                    decision = {"result": "FAIL", "evidence": cited, "observations": []}
                elif missing:
                    decision = {"result": "INSUFFICIENT", "reason_code": missing[0], "reason_includes": missing[1], "evidence": cited}
                else:
                    decision = {"result": "PASS", "evidence": cited, "observations": []}
        elif gate == "POINT_IN_TIME_DATA":
            manifest = evidence["manifest"]
            if manifest is None:
                decision = {"result": "INSUFFICIENT", "reason_code": "RUN_MISSING", "reason_includes": ["manifest"]}
            elif manifest["bars_without_availability"] or manifest["actions_without_availability"]:
                decision = {"result": "FAIL", "evidence": [manifest["digest"]], "observations": []}
            else:
                future = next((r for r in runs if r["outcome"]["kind"] in ("FAILED", "NOT_PREPARED") and r["outcome"].get("code") == "FUTURE_DATA"), None)
                if future:
                    decision = {"result": "INSUFFICIENT", "reason_code": "RUN_FAILED", "reason_includes": [future["run_id"], "FUTURE_DATA"], "evidence": [manifest["digest"]]}
                else:
                    decision = {"result": "PASS", "evidence": [manifest["digest"]], "observations": []}
        elif gate == "BASE_COST_MODEL":
            if not runs:
                decision = {"result": "INSUFFICIENT", "reason_code": "RUN_MISSING", "reason_includes": ["run"]}
            else:
                cited, failing, missing = [], False, None
                for run in runs:
                    if run["cost"] is None:
                        missing = missing or run_unavailable(run) or ("RUN_MISSING", [run["run_id"]])
                        continue
                    if run["submission"] not in cited:
                        cited.append(run["submission"])
                    wanted = expected_policy_cost(policy, run["scenario"])
                    failing = failing or any(Fraction(run["cost"][k]) != v for k, v in wanted.items())
                if failing:
                    decision = {"result": "FAIL", "evidence": cited, "observations": []}
                elif missing:
                    decision = {"result": "INSUFFICIENT", "reason_code": missing[0], "reason_includes": missing[1], "evidence": cited}
                else:
                    decision = {"result": "PASS", "evidence": cited, "observations": []}
        else:
            raise AssertionError(gate)
        outcome = {"gate": gate, "category": category}
        if decision["result"] == "INSUFFICIENT":
            # An undecided gate omits an empty list of evidence or observations.
            decision = {k: v for k, v in decision.items() if v != []}
        outcome.update(decision)
        if rule.get("limitation"):
            outcome["limitation"] = rule["limitation"]
        outcomes.append(outcome)
    return outcomes


def expected_inputs(evidence):
    inputs = []

    def add(kind, digest_value, run_id=None):
        entry = {"kind": kind, "digest": digest_value}
        if run_id:
            entry["run_id"] = run_id
        if entry not in inputs:
            inputs.append(entry)

    if evidence["plan"]:
        add("EVALUATION_PLAN", evidence["plan"])
    if evidence["validation"]["status"] != "MISSING":
        add("VALIDATION_RESULT", evidence["validation"]["digest"])
    for run in evidence["runs"]:
        if run["submission"]:
            add("EVALUATION_SUBMISSION", run["submission"], run["run_id"])
        if run["result"]:
            add("EVALUATION_RESULT", run["result"], run["run_id"])
        if run["metrics"] is not None:
            add("EVALUATION_METRICS", run["metrics_digest"], run["run_id"])
    if evidence["manifest"]:
        add("DATASET_MANIFEST", evidence["manifest"]["digest"])
    return inputs


def write_gate_case(case_id, title, policy_name, evidence, covers, notes, policy=None, error=None):
    folder = CASES / case_id
    policy = policy or (offline_policy() if policy_name == "offline" else read(PILOT_POLICY))
    case = {"id": case_id, "title": title, "kind": "gates", "policy": policy_name, "covers": covers, "evidence": "evidence.json", "expected": "expected.json", "derivation": "derivation.md"}
    write(folder / "case.json", case)
    write(folder / "evidence.json", evidence)
    if error:
        expect = {"error": error}
        results = None
        try:
            gate_outcomes(policy, evidence)
        except ValueError as exc:
            assert str(exc).startswith(error), (str(exc), error)
        else:
            raise AssertionError("the policy must be refused")
    else:
        results = gate_outcomes(policy, evidence)
        expect = {"inputs": expected_inputs(evidence), "gates": results}
    write(folder / "expected.json", {"schema": "s1-metrics-expected/1", "case": case_id, "origin": origin("Derived from the policy and the evidence by the rules of the method text."), "expect": expect})
    text = [f"# {case_id}: {title}", "", f"Origin: `fixtures/s1/metrics/oracle/oracle.py`, from the {policy_name} cohort policy and the evidence of `evidence.json` by the rules of OQ-02 sections 3.2 and 3.6 and the decision record D18. {notes}", ""]
    if results is not None:
        text.append(table(["Gate", "Result", "Reason code"], [(g["gate"], g["result"], g.get("reason_code", "")) for g in results]))
    else:
        text.append(f"The policy is refused with `{error}`: a required gate without a reviewed method is never passed.")
    (folder / "derivation.md").write_text("\n".join(text) + "\n")
    return results


def by_gate(results):
    return {g["gate"]: g for g in results}


def set_metrics(evidence, run_id, **values):
    run = find(evidence, run_id)
    run["metrics"].update(values)
    return run


def build_gate_cases():
    write(ROOT / "policies" / "offline-pass.json", offline_policy())

    # G-01: every required gate passes under the offline policy.
    evidence = standard_evidence()
    results = write_gate_case("G-01", "Every gate passes under the offline test policy", "offline", evidence, ["PASS path"], "Hand: every threshold holds in D, V and H under base and stress costs; the repeat of D has the digest of D; both audits pass; the manifest has no gap; the cost policies match.")
    got = by_gate(results)
    assert all(got[g]["result"] == "PASS" for g in ["DEFINITION_VALIDATION", "DETERMINISTIC_REPLAY", "ACCOUNTING_RECONCILIATION", "SIGNAL_DATA_TIMING", "POINT_IN_TIME_DATA", "BASE_COST_MODEL", "EXCESS_OVER_BUY_AND_HOLD", "WALK_FORWARD", "MINIMUM_TRADE_COUNT", "COST_STRESS"])
    assert all(got[g]["result"] == "NOT_APPLICABLE" for g in ["PARAMETER_SENSITIVITY", "EXECUTION_DELAY", "ADVERSE_REGIMES", "RESAMPLING", "PROSPECTIVE_EVIDENCE", "PORTFOLIO_FIT", "OPERATING_READINESS"])
    assert "limitation" in got["POINT_IN_TIME_DATA"] and "limitation" not in got["WALK_FORWARD"]
    assert len(got["EXCESS_OVER_BUY_AND_HOLD"]["observations"]) == 6 and len(got["WALK_FORWARD"]["observations"]) == 6 and len(got["COST_STRESS"]["observations"]) == 6

    # G-02: the expected S1 outcome: required gates pass or fail on the data, trade count is
    # INSUFFICIENT, the robustness checks are INSUFFICIENT by policy.
    evidence = standard_evidence()
    for rid, net, excess, trades in [("run-d-base", "0.067310", "0.017310", 11), ("run-v-base", "0.041873", "-0.258127", 9), ("run-h-base", "-0.008815", "-0.048815", 8)]:
        set_metrics(evidence, rid, net_return=net, excess_return=excess, trade_count=trades)
    for rid, net, excess, trades in [("run-d-stress", "0.063127", "0.013127", 11), ("run-v-stress", "0.037402", "-0.262598", 9), ("run-h-stress", "-0.012699", "-0.052699", 8)]:
        set_metrics(evidence, rid, net_return=net, excess_return=excess, trade_count=trades)
    results = write_gate_case("G-02", "The expected S1 outcome: no eligible candidate", "pilot", evidence, ["no eligible candidate", "RECORDED_INSUFFICIENT", "NOT_APPLICABLE", "limitation repeated"], "Hand: excess return is positive in D only, so EXCESS_OVER_BUY_AND_HOLD, WALK_FORWARD and COST_STRESS fail; trade counts 11, 9 and 8 are below 10, so MINIMUM_TRADE_COUNT is INSUFFICIENT with BELOW_THRESHOLD; the three robustness checks are INSUFFICIENT by policy and the other four gates NOT_APPLICABLE.")
    got = by_gate(results)
    assert [got[g]["result"] for g in ("EXCESS_OVER_BUY_AND_HOLD", "WALK_FORWARD", "COST_STRESS")] == ["FAIL"] * 3
    assert got["MINIMUM_TRADE_COUNT"]["result"] == "INSUFFICIENT" and got["MINIMUM_TRADE_COUNT"]["reason_code"] == "BELOW_THRESHOLD"
    assert [got[g]["reason_code"] for g in ("PARAMETER_SENSITIVITY", "EXECUTION_DELAY", "ADVERSE_REGIMES")] == ["POLICY_RECORDED"] * 3
    assert [o["holds"] for o in got["EXCESS_OVER_BUY_AND_HOLD"]["observations"]] == [True, False, False, True, True, False]

    # G-03: the holdout alone fails; walk-forward lists every window and never averages.
    evidence = standard_evidence()
    set_metrics(evidence, "run-h-base", excess_return="-0.001000")
    results = write_gate_case("G-03", "Excess return fails in the holdout alone: walk-forward does not average", "offline", evidence, ["walk-forward", "no averaging"], "Hand: the average excess over the three windows is positive (0.017310 + 0.012873 - 0.001000 > 0) and the gate still fails, because H does not hold on its own.")
    got = by_gate(results)
    assert got["WALK_FORWARD"]["result"] == "FAIL" and got["EXCESS_OVER_BUY_AND_HOLD"]["result"] == "FAIL"
    assert got["COST_STRESS"]["result"] == "PASS" and got["MINIMUM_TRADE_COUNT"]["result"] == "PASS"

    # G-04: stress fails while base passes.
    evidence = standard_evidence()
    set_metrics(evidence, "run-v-stress", net_return="-0.000500")
    results = write_gate_case("G-04", "Cost stress fails in V while the base costs pass", "offline", evidence, ["cost stress"], "Hand: net return under twice the costs is negative in V.")
    got = by_gate(results)
    assert got["COST_STRESS"]["result"] == "FAIL" and got["EXCESS_OVER_BUY_AND_HOLD"]["result"] == "PASS" and got["WALK_FORWARD"]["result"] == "PASS"

    # G-05: the benchmark has no value in V.
    evidence = standard_evidence()
    set_metrics(evidence, "run-v-base", buy_and_hold="INSUFFICIENT")
    results = write_gate_case("G-05", "The buy-and-hold benchmark is unavailable in V", "offline", evidence, ["BENCHMARK_UNAVAILABLE"], "Hand: D and H hold; V has no excess to read, so the two gates that need it are INSUFFICIENT, never PASS. The net-return threshold of the same gate holds in V.")
    got = by_gate(results)
    assert got["EXCESS_OVER_BUY_AND_HOLD"]["result"] == "INSUFFICIENT" and got["EXCESS_OVER_BUY_AND_HOLD"]["reason_code"] == "BENCHMARK_UNAVAILABLE"
    assert got["WALK_FORWARD"]["reason_code"] == "BENCHMARK_UNAVAILABLE" and got["COST_STRESS"]["result"] == "PASS"

    # G-06: the holdout runs never reported.
    evidence = standard_evidence()
    for rid in ("run-h-base", "run-h-stress"):
        run = find(evidence, rid)
        run.update({"outcome": {"kind": "MISSING"}, "submission": None, "result": None, "metrics_digest": None, "metrics": None, "checks": None, "cost": None})
    results = write_gate_case("G-06", "The holdout runs are missing", "offline", evidence, ["RUN_MISSING"], "Hand: D and V measure; H has no run, so every gate that reads H is INSUFFICIENT with RUN_MISSING and the audits are INSUFFICIENT too.")
    got = by_gate(results)
    for gate in ("EXCESS_OVER_BUY_AND_HOLD", "WALK_FORWARD", "MINIMUM_TRADE_COUNT", "COST_STRESS", "ACCOUNTING_RECONCILIATION", "SIGNAL_DATA_TIMING", "BASE_COST_MODEL"):
        assert got[gate]["result"] == "INSUFFICIENT" and got[gate]["reason_code"] == "RUN_MISSING", gate
    assert got["DEFINITION_VALIDATION"]["result"] == "PASS" and got["DETERMINISTIC_REPLAY"]["result"] == "PASS"

    # G-07: a measured failure wins over missing evidence in another window.
    evidence = standard_evidence()
    set_metrics(evidence, "run-d-base", excess_return="-0.002000", trade_count=4)
    run = find(evidence, "run-h-base")
    run.update({"outcome": {"kind": "MISSING"}, "submission": None, "result": None, "metrics_digest": None, "metrics": None, "checks": None, "cost": None})
    results = write_gate_case("G-07", "A measured failure wins over missing evidence", "offline", evidence, ["precedence"], "Hand: D fails its excess threshold and its trade count; H is missing. A threshold that provably fails cannot be rescued by the missing window: the excess gate is FAIL (below_threshold FAIL), the trade-count gate INSUFFICIENT with BELOW_THRESHOLD, not RUN_MISSING.")
    got = by_gate(results)
    assert got["EXCESS_OVER_BUY_AND_HOLD"]["result"] == "FAIL"
    assert got["MINIMUM_TRADE_COUNT"]["result"] == "INSUFFICIENT" and got["MINIMUM_TRADE_COUNT"]["reason_code"] == "BELOW_THRESHOLD"

    # G-08: each candidate-defect code fails DEFINITION_VALIDATION and leaves the rest INSUFFICIENT.
    for suffix, code in zip("abcde", ["INVALID_LEVEL", "UNSUPPORTED_OPERATOR", "OPERATOR_TYPE_MISMATCH", "OPERATOR_UNIT_MISMATCH", "INVALID_PARAMETER"]):
        evidence = standard_evidence()
        run = find(evidence, "run-v-base")
        run.update({"outcome": {"kind": "FAILED", "code": code}, "result": None, "metrics_digest": None, "metrics": None, "checks": None})
        results = write_gate_case(f"G-08{suffix}", f"A run fails with the candidate defect {code}", "offline", evidence, ["candidate defect", code], "Hand: the defect belongs to the candidate. DEFINITION_VALIDATION is FAIL. A failed run has no ledger, timing or result, so the gates that need it are INSUFFICIENT with RUN_FAILED rather than FAIL.")
        got = by_gate(results)
        assert got["DEFINITION_VALIDATION"]["result"] == "FAIL"
        for gate in ("ACCOUNTING_RECONCILIATION", "SIGNAL_DATA_TIMING", "EXCESS_OVER_BUY_AND_HOLD", "WALK_FORWARD", "MINIMUM_TRADE_COUNT"):
            assert got[gate]["result"] == "INSUFFICIENT" and got[gate]["reason_code"] == "RUN_FAILED", (code, gate)
        assert got["DETERMINISTIC_REPLAY"]["result"] == "PASS" and got["BASE_COST_MODEL"]["result"] == "PASS"

    # G-09: platform defects make the dependent gates INSUFFICIENT and fail nothing.
    for suffix, code in zip("abcdef", ["FUTURE_DATA", "EVENT_OUT_OF_ORDER", "INVALID_INPUT", "CHECKPOINT_MISMATCH", "IDENTITY_MISMATCH", "UNSUPPORTED_POLICY"]):
        evidence = standard_evidence()
        run = find(evidence, "run-h-base")
        run.update({"outcome": {"kind": "FAILED", "code": code}, "result": None, "metrics_digest": None, "metrics": None, "checks": None})
        results = write_gate_case(f"G-09{suffix}", f"A run fails with the platform code {code}", "offline", evidence, ["platform defect", code], "Hand: the defect belongs to the platform, so DEFINITION_VALIDATION still passes and every gate that needs the run is INSUFFICIENT with RUN_FAILED." + (" FUTURE_DATA also makes POINT_IN_TIME_DATA INSUFFICIENT: the gate checks that no run failed with it." if code == "FUTURE_DATA" else ""))
        got = by_gate(results)
        assert got["DEFINITION_VALIDATION"]["result"] == "PASS"
        assert all(g["result"] != "FAIL" for g in results)
        assert got["WALK_FORWARD"]["reason_code"] == "RUN_FAILED"
        assert got["POINT_IN_TIME_DATA"]["result"] == ("INSUFFICIENT" if code == "FUTURE_DATA" else "PASS")

    # G-10: arithmetic overflow is outside the engine domain.
    evidence = standard_evidence()
    run = find(evidence, "run-d-base")
    run.update({"outcome": {"kind": "FAILED", "code": "ARITHMETIC_OVERFLOW"}, "result": None, "metrics_digest": None, "metrics": None, "checks": None})
    results = write_gate_case("G-10", "A run overflows: outside the engine domain", "offline", evidence, ["ARITHMETIC_OVERFLOW", "OUTSIDE_ENGINE_DOMAIN"], "Hand: ARITHMETIC_OVERFLOW is neither a candidate defect nor a platform defect; the gates that need the run are INSUFFICIENT with OUTSIDE_ENGINE_DOMAIN.")
    got = by_gate(results)
    assert got["WALK_FORWARD"]["reason_code"] == "OUTSIDE_ENGINE_DOMAIN" and got["DEFINITION_VALIDATION"]["result"] == "PASS"

    # G-11: INSUFFICIENT numerical outcomes and runs that never prepared.
    evidence = standard_evidence()
    run = find(evidence, "run-d-base")
    run.update({"outcome": {"kind": "INSUFFICIENT", "code": "FRACTIONAL_ENTITLEMENT"}, "metrics_digest": None, "metrics": None, "checks": None})
    run = find(evidence, "run-v-base")
    run.update({"outcome": {"kind": "NOT_PREPARED", "code": "INVALID_INPUT"}, "result": None, "metrics_digest": None, "metrics": None, "checks": None})
    results = write_gate_case("G-11", "An INSUFFICIENT outcome and a run that never prepared", "offline", evidence, ["RUN_INSUFFICIENT", "NOT_PREPARED"], "Hand: D ended INSUFFICIENT (a completed run without metrics): RUN_INSUFFICIENT. V never prepared with INVALID_INPUT: RUN_FAILED.")
    got = by_gate(results)
    assert got["EXCESS_OVER_BUY_AND_HOLD"]["reason_code"] == "RUN_INSUFFICIENT"
    assert got["DETERMINISTIC_REPLAY"]["result"] == "INSUFFICIENT" and got["DETERMINISTIC_REPLAY"]["reason_code"] == "RUN_INSUFFICIENT"

    # G-12: replay.
    evidence = standard_evidence()
    find(evidence, "run-d-base-replay")["result"] = digest("result", "another")
    results = write_gate_case("G-12a", "The repeat of D has another result digest", "offline", evidence, ["replay mismatch"], "Hand: two evaluations of one input must give equal result digests.")
    assert by_gate(results)["DETERMINISTIC_REPLAY"]["result"] == "FAIL"
    evidence = standard_evidence()
    evidence["runs"] = [r for r in evidence["runs"] if r["repeat_of"] is None]
    results = write_gate_case("G-12b", "No repeat of D is part of the evidence", "offline", evidence, ["replay missing"], "Hand: without a repeat the replay gate has no evidence.")
    assert by_gate(results)["DETERMINISTIC_REPLAY"]["reason_code"] == "RUN_MISSING"
    evidence = standard_evidence()
    find(evidence, "run-d-base-replay").update({"outcome": {"kind": "FAILED", "code": "INVALID_INPUT"}, "result": None, "metrics_digest": None, "metrics": None, "checks": None})
    results = write_gate_case("G-12c", "The repeat of D failed", "offline", evidence, ["replay failed"], "Hand: a failed repeat cannot be compared.")
    got = by_gate(results)
    assert got["DETERMINISTIC_REPLAY"]["result"] == "INSUFFICIENT" and got["DETERMINISTIC_REPLAY"]["reason_code"] == "RUN_FAILED"

    # G-13, G-14: the audits.
    evidence = standard_evidence()
    find(evidence, "run-v-stress")["checks"]["reconciliation"] = "FAIL"
    results = write_gate_case("G-13", "The ledger of one run does not reconcile", "offline", evidence, ["reconciliation FAIL"], "Hand: one failed audit fails the gate; the other runs still count as evidence.")
    got = by_gate(results)
    assert got["ACCOUNTING_RECONCILIATION"]["result"] == "FAIL" and got["SIGNAL_DATA_TIMING"]["result"] == "PASS"
    evidence = standard_evidence()
    find(evidence, "run-h-base")["checks"]["timing"] = "FAIL"
    results = write_gate_case("G-14", "A fill of one run is outside its phase", "offline", evidence, ["timing FAIL"], "Hand: one failed timing audit fails the gate.")
    got = by_gate(results)
    assert got["SIGNAL_DATA_TIMING"]["result"] == "FAIL" and got["ACCOUNTING_RECONCILIATION"]["result"] == "PASS"

    # G-15: point in time.
    evidence = standard_evidence()
    evidence["manifest"]["bars_without_availability"] = 3
    results = write_gate_case("G-15a", "Three bars have no availability time", "pilot", evidence, ["point in time FAIL", "limitation repeated"], "Hand: a bar without an availability time fails the gate; the limitation is repeated with every result of the gate.")
    got = by_gate(results)
    assert got["POINT_IN_TIME_DATA"]["result"] == "FAIL" and "limitation" in got["POINT_IN_TIME_DATA"]
    evidence = standard_evidence()
    evidence["manifest"] = None
    results = write_gate_case("G-15b", "No dataset manifest was read", "pilot", evidence, ["point in time missing", "limitation repeated"], "Hand: without the manifest nothing evidences availability. The limitation is repeated on an INSUFFICIENT result too.")
    got = by_gate(results)
    assert got["POINT_IN_TIME_DATA"]["result"] == "INSUFFICIENT" and "limitation" in got["POINT_IN_TIME_DATA"]

    # G-16: a required gate without a method.
    policy = offline_policy()
    for rule in policy["gates"]:
        if rule["gate"] == "PARAMETER_SENSITIVITY":
            rule.clear()
            rule.update({"requirement": "REQUIRED", "gate": "PARAMETER_SENSITIVITY", "category": "ROBUSTNESS", "thresholds": [], "below_threshold": "FAIL"})
    write_gate_case("G-16", "A policy that requires parameter sensitivity", "inline", standard_evidence(), ["unsupported required gate"], "The method has no rule for the gate.", policy=policy, error="UnsupportedRequiredGate PARAMETER_SENSITIVITY")
    (CASES / "G-16" / "policy.json").write_text(json.dumps(policy, indent=2) + "\n")

    # G-17: thresholds are exact at the boundary.
    evidence = standard_evidence()
    set_metrics(evidence, "run-d-base", excess_return="0", trade_count=10)
    set_metrics(evidence, "run-h-base", trade_count=9)
    results = write_gate_case("G-17", "An observed value equal to its threshold", "offline", evidence, ["threshold boundary", "tolerance zero"], "Hand: GREATER_THAN 0 does not hold at exactly 0; AT_LEAST 10 holds at exactly 10 and fails at 9.")
    got = by_gate(results)
    assert got["EXCESS_OVER_BUY_AND_HOLD"]["result"] == "FAIL"
    obs = {(o["run_id"], o["metric"]): o["holds"] for o in got["EXCESS_OVER_BUY_AND_HOLD"]["observations"]}
    assert obs[("run-d-base", "excess_return_over_buy_and_hold")] is False
    trade = {o["run_id"]: o["holds"] for o in got["MINIMUM_TRADE_COUNT"]["observations"]}
    assert trade["run-d-base"] is True and trade["run-h-base"] is False

    # G-18: the cost model.
    evidence = standard_evidence()
    find(evidence, "run-v-base")["cost"]["fee_bps"] = "6"
    results = write_gate_case("G-18a", "A base run carries another fee than the cohort's", "offline", evidence, ["base cost model FAIL"], "Hand: 6 bps differs from the cohort's 5 bps.")
    assert by_gate(results)["BASE_COST_MODEL"]["result"] == "FAIL"
    evidence = standard_evidence()
    find(evidence, "run-h-stress")["cost"]["gap_exit_slippage_bps"] = "10"
    results = write_gate_case("G-18b", "A stress run does not double the slippage", "offline", evidence, ["stress cost model FAIL"], "Hand: the stress run must carry 20 bps (twice 10), not 10.")
    assert by_gate(results)["BASE_COST_MODEL"]["result"] == "FAIL"
    evidence = standard_evidence()
    for run in evidence["runs"]:
        run["cost"]["fixed_fee_per_fill"] = "0"
        run["cost"]["fee_bps"] = run["cost"]["fee_bps"] + ".0"
    results = write_gate_case("G-18c", "Decimals that differ in text and not in value", "offline", evidence, ["decimal comparison by value"], "Hand: 0 equals 0.00 and 5.0 equals 5.")
    assert by_gate(results)["BASE_COST_MODEL"]["result"] == "PASS"

    # G-19: the validation result.
    evidence = standard_evidence()
    evidence["validation"] = {"status": "INVALID", "digest": digest("validation", "invalid")}
    results = write_gate_case("G-19a", "The validate job found the draft invalid", "offline", evidence, ["validation FAIL"], "Hand: an invalid draft fails the definition gate.")
    assert by_gate(results)["DEFINITION_VALIDATION"]["result"] == "FAIL"
    evidence = standard_evidence()
    evidence["validation"] = {"status": "MISSING"}
    results = write_gate_case("G-19b", "No validation result is part of the evidence", "offline", evidence, ["validation missing"], "Hand: without a result the definition gate is INSUFFICIENT with VALIDATION_FAILED, the closest code of the schema.")
    got = by_gate(results)
    assert got["DEFINITION_VALIDATION"]["result"] == "INSUFFICIENT" and got["DEFINITION_VALIDATION"]["reason_code"] == "VALIDATION_FAILED"

    # G-20: three windows below the trade-count threshold.
    evidence = standard_evidence()
    for rid in ("run-d-base", "run-v-base", "run-h-base"):
        set_metrics(evidence, rid, trade_count=3)
    results = write_gate_case("G-20", "Too few trades in every window", "offline", evidence, ["minimum trade count"], "Hand: 3 closed trades in each window are below 10: INSUFFICIENT with BELOW_THRESHOLD, never FAIL.")
    got = by_gate(results)
    assert got["MINIMUM_TRADE_COUNT"]["result"] == "INSUFFICIENT" and got["MINIMUM_TRADE_COUNT"]["reason_code"] == "BELOW_THRESHOLD"
    assert [o["holds"] for o in got["MINIMUM_TRADE_COUNT"]["observations"]] == [False, False, False]


if __name__ == "__main__":
    build_metrics_cases()
    build_series_cases()
    build_benchmark_cases()
    build_gate_cases()
    print("metrics, series, benchmark and gate cases written")
