# AI-Native Quant Fund — Ink UX/UI Specification

**Version:** 1.1  
**Status:** Design specification  
**Interface:** Terminal UI  
**Companion specs:** AI-Native Quant Trading Platform — Design Specification v1; AI-Native Quant Fund — Tech Stack Specification v1

---

## 1. Purpose

Define the user experience and interface for operating the AI-native quant fund from a terminal.

This specification owns:

- information architecture;
- screen hierarchy;
- operator workflows;
- navigation;
- keyboard interaction;
- terminal layouts;
- status presentation;
- confirmations;
- failure-state presentation;
- visual language.

It does **not** define backend architecture, APIs, persistence, orchestration, deployment, or implementation structure. Those belong to the Tech Stack Specification.

The product is not a chatbot, a conventional trading terminal, or a CRUD dashboard.

It is a **terminal-native control room for a governed strategy market**.

The interface must let an operator answer five questions quickly:

1. What is the fund doing now?
2. What needs my attention?
3. Which strategies are progressing, degrading, or failing?
4. What capital and risk are currently exposed?
5. Why did the system make a given decision?

The primary UX principle is:

> **Surface decisions, evidence, capital, and risk before agent activity or raw market data.**

---

## 2. Experience Model

The primary experience is a persistent full-screen terminal application launched with:

```bash
fund
```

The interface is designed for repeated operational use.

It supports:

- fund monitoring;
- reviewing attention items;
- strategy exploration;
- Arena competition;
- promotion and demotion reviews;
- portfolio allocation review;
- risk monitoring;
- operational monitoring;
- research missions;
- audit inspection.

Short direct commands may exist for quick terminal workflows, but they are secondary to the interactive TUI and are not specified here.

---

## 3. UX Principles

### 3.1 Attention before navigation

The home experience prioritises unresolved items that need acknowledgement, investigation, or a decision.

Examples:

- a strategy eligible for promotion;
- a paper strategy outside expected drawdown;
- a critic disagreement;
- execution outside expected slippage;
- a failed evaluation;
- stale market data;
- portfolio risk approaching a limit;
- a reconciliation mismatch.

The operator should not need to browse several screens to discover important state.

### 3.2 Evidence before performance

The interface must not turn the Arena into a raw-return leaderboard.

Strategy presentation prioritises:

1. lifecycle stage;
2. evidence completeness;
3. robustness;
4. risk;
5. portfolio contribution;
6. performance.

### 3.3 Fund before agent

Agents are workers behind the system.

The primary navigation is organised around:

- research;
- strategies;
- evidence;
- capital;
- risk;
- operations.

It is not organised around individual AI agents.

### 3.4 Progressive disclosure

The default presentation stays concise.

The operator can drill down through:

```text
Fund
→ Attention item
→ Strategy
→ Evidence
→ Experiment
→ Decision
```

Detailed statistics and provenance appear only when useful.

### 3.5 Explicit operating mode

Paper, shadow, micro-capital, and live activity must never be visually ambiguous.

Every screen exposes the current environment and fund operating state.

Every strategy exposes its lifecycle state.

### 3.6 Structured consequential actions

Natural language may be used to express research intent.

It must not be the primary interaction for:

- promotion;
- capital changes;
- pausing/resuming;
- risk-limit changes;
- emergency controls.

Consequential actions use structured review screens and explicit confirmations.

### 3.7 Calm presentation

Avoid:

- casino-style leaderboards;
- flashing P&L;
- celebratory animations;
- agent avatars;
- excessive colour;
- decorative terminal chrome.

Prefer:

- concise status labels;
- aligned financial values;
- evidence summaries;
- explicit uncertainty;
- restrained warnings;
- clear next actions.

### 3.8 Keyboard-first but discoverable

Frequent operators should become fast without having to memorise hidden controls.

Important actions are discoverable through:

- contextual footer hints;
- command palette;
- search;
- `?` help.

---

## 4. Information Architecture

Primary navigation:

```text
Overview
Foundry
Arena
Strategies
Portfolio
Risk
Operations
```

Secondary navigation:

```text
Agents
Audit
Settings
Help
```

The hierarchy follows the operating loop:

```text
Research
  ↓
Compete
  ↓
Evaluate
  ↓
Allocate
  ↓
Trade
  ↓
Monitor
```

### 4.1 Overview

Fund-wide state and attention queue.

### 4.2 Foundry

Research missions, hypotheses, candidate strategies, and research progress.

### 4.3 Arena

Strategy competition across evaluation stages.

### 4.4 Strategies

Catalogue and detailed inspection of all strategies.

### 4.5 Portfolio

Capital, positions, exposure, diversification, and attribution.

### 4.6 Risk

Risk limits, utilisation, warnings, breaches, and emergency controls.

### 4.7 Operations

Workflows, evaluations, orders, reconciliation, and system state.

### 4.8 Agents

Role-specific operational performance of agents.

### 4.9 Audit

Read-only decision and action history.

---

## 5. Global Application Shell

Wide-terminal concept:

```text
┌─ FUND ──────────────────────────────────────────────────────────────────────────────┐
│ ENV PROD   BROKER LIVE   DATA LIVE   RISK OK            18 Aug 2026  23:08 London │
├──────────────┬──────────────────────────────────────────────────────────────────────┤
│ Overview     │                                                                      │
│ Foundry      │                                                                      │
│ Arena        │                         CURRENT SCREEN                               │
│ Strategies   │                                                                      │
│ Portfolio    │                                                                      │
│ Risk         │                                                                      │
│ Operations   │                                                                      │
│              │                                                                      │
│ Agents       │                                                                      │
│ Audit        │                                                                      │
├──────────────┴──────────────────────────────────────────────────────────────────────┤
│ ↑↓ Move  Enter Open  / Search  : Commands  ? Help  Esc Back                  ● LIVE │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

The shell has four persistent regions:

1. system header;
2. navigation;
3. current screen;
4. contextual footer.

### 5.1 System Header

Always expose:

- environment;
- broker/trading mode;
- market-data state;
- risk state;
- time and timezone.

Example states:

```text
ENV DEV
ENV STAGING
ENV PROD

BROKER OFF
BROKER SHADOW
BROKER LIVE

DATA LIVE
DATA DELAYED
DATA STALE
DATA OFFLINE

RISK OK
RISK WARN
RISK BREACH
RISK HALTED
```

These states must remain understandable without colour.

### 5.2 Navigation

Wide terminals:

- persistent left navigation.

Standard terminals:

- compact navigation row.

Narrow terminals:

- navigation opened from a palette.

### 5.3 Footer

The footer shows only actions that are currently valid.

Example:

```text
↑↓ Select   Enter Open   C Compare   A Actions   / Filter   ? Help
```

---

## 6. Overview

The Overview is the operational home screen.

It is not primarily a market dashboard.

Presentation order:

1. attention;
2. fund state;
3. Arena movement;
4. portfolio and risk;
5. recent activity.

Example:

```text
OVERVIEW
──────────────────────────────────────────────────────────────────────────────────────

ATTENTION  3
! S42  Paper slippage exceeds model                 EXECUTION      7m
! Risk  Gross exposure at 82% of limit              RISK           11m
? S17  Eligible for PAPER promotion                 REVIEW         24m

FUND
NAV             £102,480       Day             +0.38%
Drawdown          -1.62%       Gross              61%
Live strategies        4       Paper              13
Cash              £38,220      Risk                OK

ARENA                                  PORTFOLIO
ROBUSTNESS   8 active                  Momentum       24%
PAPER       13 active                  Mean rev.      18%
SHADOW       3 active                  Event          11%
READY        2 decisions               Other           9%
                                        Cash           38%

ACTIVITY
23:06  S11 paper order simulated       FILLED
23:04  Critic-3 completed S17 review   PASS
23:02  Backtest B892 completed          FAIL
22:58  S42 execution alert created     WARN
```

### 6.1 Attention Queue

Each item shows:

```text
severity
object
reason
category
age
```

Opening an item routes directly to the relevant decision context.

Examples:

```text
Promotion candidate
→ Strategy / Promotion Review

Risk warning
→ Risk / Warning Detail

Evaluation failure
→ Operations / Evaluation Detail

Critic disagreement
→ Strategy / Evidence / Critics
```

Attention states:

```text
OPEN
ACKNOWLEDGED
RESOLVED
```

Acknowledgement does not hide unresolved risk.

---

## 7. Foundry

The Foundry represents strategy creation.

The primary object is a **Research Mission**: a bounded research objective assigned to the agent system.

Example:

```text
MISSION R31
Find short-horizon liquid strategies with low correlation
to the current equity portfolio.

Universe       US large-cap equities
Horizon        Intraday → 2 days
Risk profile   Low drawdown
Status         EXPLORING
Budget         24 experiments
Created        18 Aug 22:31
```

### 7.1 Foundry List

```text
FOUNDRY
──────────────────────────────────────────────────────────────────────────────────────
Mission   Intent                                      Hypotheses  Strategies  State
R31       Low-correlation short horizon equity                8           3  ACTIVE
R30       FX volatility regime transitions                    5           1  REVIEW
R29       Post-earnings volume continuation                   9           2  COMPLETE
```

### 7.2 New Research Mission

Use a short structured flow.

```text
NEW RESEARCH MISSION

Objective
> Find strategies that diversify the current live portfolio

Universe
> US equities

Horizon
> intraday to 5 days

Constraints
> liquid instruments, no leverage, max expected drawdown 5%

Experiment budget
> 30

[Enter] Start mission   [Esc] Cancel
```

Only the objective needs unrestricted natural language.

Where possible, investment universe, horizon, budget, and constraints are structured.

### 7.3 Mission Detail

Show:

- objective;
- constraints;
- status;
- hypotheses generated;
- hypotheses rejected;
- candidate strategies;
- experiment budget consumed;
- current research stage;
- important critic findings.

Agent activity is shown as structured outcomes:

```text
22:42 Researcher generated H119
22:43 Critic rejected H117: likely factor duplication
22:44 Strategy S62 created from H119
22:45 Evaluation queued for S62
```

Do not expose hidden model reasoning as an operational requirement.

---

## 8. Arena

The Arena is the strategy competition surface.

It must not be a single P&L leaderboard.

### 8.1 Summary

```text
ARENA
──────────────────────────────────────────────────────────────────────────────────────
BACKTEST      21
ROBUSTNESS     8
PAPER         13
SHADOW         3
READY          2
PAUSED         4

Cohort: Liquid US Equity / Short Horizon                         [C] Change cohort
```

### 8.2 Arena Table

```text
ID    Stage       Evidence      OOS      DD      Robust   Corr    Portfolio   State
S17   PAPER       6/7 gates    +8.2%   -2.1%    HIGH     .18     +0.31       READY
S42   PAPER       5/7 gates    +9.1%   -3.8%    MED      .12     +0.27       WARN
S33   ROBUSTNESS  4/7 gates    +5.4%   -1.9%    HIGH     .46     +0.11       ACTIVE
S51   BACKTEST    2/7 gates   +18.6%   -8.7%    LOW      .74     -0.04       REJECT
```

Default ordering:

1. readiness;
2. evidence strength;
3. portfolio contribution;
4. risk;
5. performance.

### 8.3 Evidence Gates

Expanded:

```text
CONTRACT ✓
CRITIC   ✓
BACKTEST ✓
ROBUST   ✓
PAPER    ✓
SHADOW   ○
MICRO    —
```

Compact:

```text
C✓ CR✓ B✓ R✓ P✓ S○ M—
```

The compact representation always has a discoverable legend.

### 8.4 Cohorts

Strategies are compared within economically meaningful cohorts.

Examples:

```text
Liquid US Equity / Short Horizon
FX / Intraday
ETF / Mean Reversion
Cross-Asset / Medium Horizon
```

### 8.5 Compare Mode

Two or more comparable strategies can be inspected side by side.

```text
COMPARE S17 ↔ S42
──────────────────────────────────────────────────────────────────────
                        S17                 S42
Stage                   PAPER               PAPER
OOS return              +8.2%               +9.1%
Max DD                  -2.1%               -3.8%
Robustness              HIGH                MED
Cost sensitivity        LOW                 MED
Portfolio corr           .18                 .12
Portfolio contribution  +0.31               +0.27
Trials                   43                  231
Critic open findings     0                   2
```

Trial count is deliberately prominent.

---

## 9. Strategy Detail

Strategy Detail is the primary inspection screen.

Header:

```text
S17  Intraday Reversal / v4              PAPER   READY FOR REVIEW

Hypothesis H44      Parent S17-v3      Cohort US-EQ-SHORT
```

Tabs:

```text
Summary | Evidence | Runs | Lineage | Capital | Activity
```

### 9.1 Summary

```text
EVIDENCE                          RISK
Contract          PASS            Max DD            -2.1%
Critic            PASS            Expected shortfall -0.7%
Backtest          PASS            Turnover            1.8x
Robustness        PASS            Capacity             MED
Paper             PASS
Shadow            PENDING

PORTFOLIO                          CURRENT PAPER RUN
Correlation        .18            Days                 61
Marginal value    +0.31           Return             +3.2%
Factor overlap      LOW           Slippage             7bp
```

Below the scorecard:

```text
OPEN FINDINGS
None

INVALIDATION CONDITIONS
- 20-day rolling expectancy < 0
- realised slippage > 18bp for 5 sessions
- correlation to live momentum cluster > .65
```

Invalidation conditions are visible without opening implementation details.

### 9.2 Evidence

Group evidence by lifecycle stage.

```text
ROBUSTNESS
✓ Walk-forward     E421
✓ Cost stress      E422
✓ Delay stress     E423
✓ Parameter sweep  E424
✓ PBO analysis     E425

Critic conclusion
PASS — edge survives cost and timing perturbation.
```

Opening an experiment presents:

- declared inputs;
- dataset version;
- parameters;
- cost assumptions;
- output metrics;
- warnings;
- provenance;
- resulting decision.

### 9.3 Runs

Chronological strategy history with filters:

```text
ALL | BACKTEST | ROBUSTNESS | PAPER | SHADOW | LIVE | FAILED
```

### 9.4 Lineage

Text-first tree:

```text
H44
└─ S17 v1
   ├─ v2  exit timing mutation        RETIRED
   └─ v3
      └─ v4                           CURRENT
         ├─ E421 walk-forward
         ├─ E422 cost stress
         ├─ E423 delay stress
         └─ P18  paper run
```

### 9.5 Capital

Paper/non-live:

```text
Current mandate     PAPER ONLY
Recommended next    SHADOW
```

Live:

```text
Allocated capital   £10,000
Gross limit         £12,500
Position limit       £2,000
Daily loss limit       £250
Current utilisation       64%
Last allocation      16 Aug
Next review           23 Aug
```

### 9.6 Activity

Show structured actions and outcomes:

```text
timestamp
actor role
action
result
evidence reference
```

---

## 10. Promotion Review

Promotion is a dedicated workflow, not an inline button.

### 10.1 Non-capital Promotion

Example:

```text
PROMOTION REVIEW — S17
PAPER → SHADOW
──────────────────────────────────────────────────────────────────────

REQUIRED GATES
✓ Contract valid
✓ Independent critic passed
✓ Robustness passed
✓ Paper minimum duration reached
✓ Risk policy passed
✓ No unresolved incidents

EVIDENCE
Paper days              61
Paper return          +3.2%
Max drawdown          -2.1%
Expected max DD       -4.0%
Slippage                7bp
Expected slippage      10bp
Portfolio corr          .18

OPEN FINDINGS
None

PROPOSED MANDATE
Mode                   SHADOW
Capital                    £0
Order routing        SIMULATED

[P] Approve promotion
[R] Reject
[Esc] Return
```

### 10.2 Promotion to Real Capital

Real-capital promotion is visually distinct.

```text
PROMOTION REVIEW — S17
SHADOW → MICRO CAPITAL

Current capital        £0
Proposed capital      £500
Maximum position      £100
Daily loss limit       £25
Drawdown halt          £50
Allowed instruments    12

This enables real broker orders.

Type:
PROMOTE S17

> _
```

The safe default is always cancellation.

---

## 11. Portfolio

Portfolio is fund-centric rather than strategy-centric.

### 11.1 Summary

```text
PORTFOLIO
──────────────────────────────────────────────────────────────────────────────────────
NAV            £102,480       Day             +£389 / +0.38%
Cash            £38,220       Gross                    61%
Net             £17,540       Drawdown               -1.62%
Risk state           OK       Live strategies             4
```

### 11.2 Allocation

```text
Strategy   Capital    Util.   Day P&L   Risk    Corr cluster   Contribution
S08        £18,000      72%      +£91   OK      Momentum       +0.28
S11        £15,000      54%      -£23   OK      MeanRev        +0.24
S14        £12,500      61%     +£141   OK      Event          +0.18
S17         £5,000      30%      +£18   OK      Diversifier    +0.31
```

### 11.3 Exposure Views

Tabs:

```text
Strategies | Assets | Sectors | Factors | Correlation | Attribution
```

Avoid dense pseudo-graphical heatmaps in narrow terminals.

Correlation is presented using:

- clusters;
- sorted pairs;
- threshold warnings;
- a compact matrix only where the terminal is wide enough.

Example:

```text
HIGH CORRELATION PAIRS
S08 ↔ S21     .78   LIMIT .75   WARN
S11 ↔ S19     .64
```

---

## 12. Risk

Risk is the highest-authority operator surface.

### 12.1 Summary

```text
RISK
──────────────────────────────────────────────────────────────────────────────────────
FUND STATE       OK
TRADING          ENABLED
AUTO-HALT        ARMED

LIMIT                  CURRENT        LIMIT        UTILISATION
Gross exposure             61%          100%             61%
Net exposure               17%           60%             28%
Daily loss              -£410        -£1,500             27%
Drawdown                -1.62%         -8.00%             20%
Correlated cluster          32%           40%             80%  WARN
```

### 12.2 Warnings and Breaches

```text
OPEN
WARN  Correlated cluster utilisation > 75%          11m
INFO  S42 approaching paper drawdown boundary       47m
```

### 12.3 Emergency Halt

Emergency controls are explicit and always available from Risk.

```text
[H] Emergency halt
```

Opening:

```text
EMERGENCY HALT

This will:
- reject new production orders;
- cancel cancellable open orders;
- pause all production strategies;
- preserve current state for reconciliation.

Existing positions are NOT automatically liquidated.

Type HALT to continue:

> _
```

Liquidation is a separate action.

Never conflate stopping new trading with closing existing positions.

---

## 13. Operations

Operations exposes operational state without becoming an infrastructure console.

Tabs:

```text
Workflows | Evaluations | Orders | Reconciliation | Services
```

### 13.1 Workflows

```text
WORKFLOWS
ID       Type                 Object   Stage              Age    State
W821     research-mission     R31      generating         2m     RUNNING
W820     strategy-review      S17      critic-review      8m     COMPLETE
W819     promotion            S12      risk-check         14m    FAILED
```

Workflow detail:

```text
W821 — Research Mission R31

✓ Build context
✓ Generate hypotheses
→ Independent critique
○ Construct strategies
○ Register experiments

Elapsed  2m 14s
Retry    0
Cancel   AVAILABLE
```

Use stages and elapsed time rather than speculative completion estimates.

### 13.2 Evaluations

```text
EVALUATIONS
E551  S33  walk-forward      64%  RUNNING
E550  S42  cost-stress      DONE  PASS
E549  S21  parameter-grid   DONE  FAIL
```

The operator can leave this screen while work continues.

### 13.3 Orders

```text
TIME      STRATEGY  INSTRUMENT  SIDE  QTY   STATE      MODE
22:43:11  S11       SPY         BUY   12    FILLED     LIVE
22:42:08  S17       QQQ         SELL   3    SIMULATED  SHADOW
```

Live and simulated orders must be distinguishable without colour.

### 13.4 Reconciliation

```text
RECONCILIATION   OK
Positions        MATCH
Open orders      MATCH
Cash             MATCH
Last completed   23:07:42
```

Any mismatch becomes an Attention item.

### 13.5 Services

Keep service presentation deliberately high level.

```text
API                   OK
Database              OK
Market data           OK
Broker                OK
Workflow runtime      OK
Evaluation workers    2/2
Realtime              OK
```

Technical diagnostics belong behind error references rather than the primary screen.

---

## 14. Agents

Agents are operational actors, not personas.

Group by role:

```text
Research
Strategy
Critic
Evaluation
Risk
Allocator
Execution
```

Example:

```text
AGENTS — CRITIC
Agent       Active   Reviews   Calibration   Useful findings   State
critic-1         1        84          0.87                31   READY
critic-2         0        61          0.79                19   READY
critic-3         2       102          0.91                44   BUSY
```

Do not create one cross-role leaderboard.

Agent Detail shows:

- role;
- scope/permissions;
- current task;
- recent decisions;
- calibration;
- reputation history;
- failures;
- current configuration/version.

---

## 15. Audit

Audit is a read-only chronological ledger.

```text
AUDIT
──────────────────────────────────────────────────────────────────────────────────────
23:04  critic-3    strategy.reviewed      S17     PASS
22:58  risk-agent  alert.created          S42     WARN
22:44  allocator   allocation.proposed    S08     £18k → £16k
22:31  steward     strategy.promoted      S11     MICRO → LIVE
```

Filters:

```text
Actor | Strategy | Action | Risk | Time | Environment
```

Opening a record shows:

- action;
- inputs;
- evidence references;
- policy version;
- outcome;
- resulting state.

---

## 16. Search and Command Palette

### 16.1 Context Search

`/` searches the current view.

Examples:

- strategies;
- missions;
- experiments;
- audit records;
- workflows.

### 16.2 Command Palette

`:` opens global navigation and actions.

Examples:

```text
strategy open S17
strategy compare S17 S42
research new
arena cohort
strategy pause S42
portfolio review
risk halt
help shortcuts
```

Only actions available to the current operator and valid in the current state are shown.

The palette cannot bypass review or confirmation screens.

---

## 17. Keyboard Model

Global:

```text
?          Help
:          Command palette
/          Search/filter
Esc        Back / close
Tab        Next focus region
Shift+Tab  Previous focus region
Ctrl+C     Cancel current interaction / exit when safe
g          Navigation
```

Lists:

```text
↑ / k      Previous
↓ / j      Next
Enter      Open
Space      Select for comparison where supported
```

Details:

```text
← / h      Previous tab
→ / l      Next tab
A          Actions
```

Rules:

- shortcuts are centralised conceptually;
- text-entry mode disables conflicting single-letter commands;
- dialogs own focus while open;
- hidden controls cannot receive input;
- focus has a non-colour indicator;
- dangerous actions never execute from one accidental keypress.

---

## 18. Input Modes

The UI has explicit interaction modes:

```text
NAVIGATION
SEARCH
EDITING
SELECTION
CONFIRMATION
COMMAND
```

The active mode determines input behaviour and footer hints.

Example:

```text
COMMAND  :strategy open S17_
Esc Cancel   Enter Run
```

Pasted text is treated as text, not as a sequence of shortcuts.

---

## 19. Visual Language

### 19.1 Philosophy

Use terminal strengths:

- alignment;
- hierarchy;
- density;
- monospace comparison;
- immediacy.

Do not imitate a web dashboard with excessive borders and nested panels.

### 19.2 Hierarchy

Use:

- bold for primary headings and selected values;
- dim styling for secondary metadata;
- whitespace before borders;
- short separators;
- aligned numeric values.

### 19.3 Status Labels

Preferred:

```text
✓ PASS
! WARN
× FAIL
○ PENDING
→ RUNNING
|| PAUSED
```

ASCII fallback:

```text
[OK]
[WARN]
[FAIL]
[PENDING]
[RUNNING]
[PAUSED]
```

### 19.4 Colour

Colour is semantic enhancement only.

Roles:

```text
success
warning
danger
information
muted
accent
```

No meaning depends solely on colour.

### 19.5 Financial Values

Examples:

```text
+£1,284
-£413
+2.41%
-0.83%
0.64
12 bp
```

Rules:

- show signs for directional values;
- use consistent precision per metric;
- align decimals in tables where practical;
- show units;
- do not rely on colour for positive/negative meaning.

---

## 20. Responsive Behaviour

### Wide — 120+ columns

Use:

- navigation rail;
- two-column summary regions;
- larger comparison tables;
- secondary metadata.

### Standard — 80–119 columns

Use:

- compact navigation;
- one primary table;
- stacked secondary regions.

### Narrow — below 80 columns

Use:

- single-column layouts;
- hidden secondary metadata;
- vertical key/value presentation;
- navigation palette;
- minimal borders.

Priority when space is constrained:

1. required decision;
2. warning/error;
3. current task;
4. primary metric/data;
5. progress;
6. secondary metadata;
7. decoration.

Never rely on accidental terminal clipping.

---

## 21. Live-State UX

The interface may change while the operator is viewing it.

Update rules from a UX perspective:

- risk changes appear immediately;
- trading-mode changes appear immediately;
- attention items appear without forcing navigation;
- workflow progress updates in place;
- table selection should not jump because another row changed;
- completed work should remain visually stable;
- high-frequency market movements should not cause constant screen redraws;
- newly updated values may receive a short, restrained emphasis but no animation is required.

If a detail view becomes stale because its underlying object changed, show:

```text
UPDATED
This strategy changed while you were viewing it.

[R] Refresh details
```

Do not silently replace user-entered values or an active confirmation.

---

## 22. Failure and Connectivity UX

Connection state is visible whenever it affects confidence in displayed data.

### 22.1 Delayed or Stale Data

```text
DATA DELAYED
```

or:

```text
DATA STALE — last confirmed 23:06:14
```

### 22.2 Backend Unavailable

```text
BACKEND OFFLINE

Last confirmed state: 23:06:14
Live actions are unavailable.
Displayed values may be stale.
```

### 22.3 Realtime Degraded

```text
REALTIME DEGRADED

Live updates are delayed.
Last snapshot: 23:07:20
```

Do not label a degraded view as live.

### 22.4 Action Failure

Preserve the operator's context.

```text
PROMOTION FAILED

No strategy state was changed.
Risk validation was unavailable.

[R] Retry   [Esc] Return
Reference: ERR-8F21
```

User-facing errors communicate:

- what failed;
- whether state changed;
- whether retry is safe;
- what to do next;
- a technical reference.

Raw stack traces are not part of the normal interface.

---

## 23. Confirmation Model

Actions have three UX risk levels.

### Low

No confirmation.

Examples:

- open strategy;
- inspect evidence;
- filter Arena;
- search;
- compare.

### Medium

Explicit confirmation.

Examples:

- cancel a research mission;
- reject promotion;
- pause a paper strategy;
- start a costly evaluation.

### High

Typed confirmation.

Examples:

- promote to real capital;
- increase a live capital mandate;
- resume a risk-paused live strategy;
- change global risk limits;
- emergency halt;
- liquidation instruction.

Every high-risk confirmation states:

- exact action;
- affected object;
- capital/risk consequence;
- whether it is reversible;
- the safe default.

Never use only:

```text
Are you sure?
```

---

## 24. Authentication and Environment UX

Authentication is outside the main navigation once established.

The shell always exposes the active environment.

Example:

```text
operator@example.com   ENV PROD
```

Switching into production must be explicit.

```text
SWITCH ENVIRONMENT

  development
  staging
> production

Production contains real fund state.

[Enter] Continue   [Esc] Cancel
```

Entering the production environment does not itself enable trading.

If the operator lacks permission for an action, the UI shows it as unavailable rather than allowing an action to fail late where possible.

Example:

```text
Increase live mandate    LOCKED — steward permission required
```

---

## 25. Empty States

Empty states explain the next useful action.

### No Strategies

```text
STRATEGIES

No strategies yet.

Start a Research Mission in Foundry to generate the first hypotheses.
[N] New mission
```

### No Live Capital

```text
PORTFOLIO

No strategies currently hold real capital.

Paper and shadow strategies remain available in Arena.
```

### No Attention Items

```text
ATTENTION

No unresolved items.
Risk state: OK
```

Do not use celebratory copy for the absence of risk alerts.

---

## 26. First-Run Experience

The first session should establish the mental model quickly.

Initial Overview:

```text
AI-NATIVE QUANT FUND

No strategies have been created yet.

The operating loop is:

Research → Test → Compete → Promote → Allocate → Monitor

Start by creating a Research Mission.

[N] New mission    [?] How the fund works
```

The first-run experience should not force configuration details unrelated to the first useful action.

Production/broker setup remains visibly unavailable until configured.

---

## 27. UX Acceptance Criteria

The UX is successful when:

1. The operator can identify environment, trading mode, data state, and risk state from every primary screen.
2. Important unresolved events converge into one Attention queue.
3. Strategy evidence is more prominent than raw P&L.
4. Paper, shadow, micro-capital, and live states cannot be confused.
5. Promotion to real capital cannot happen through a single accidental keypress.
6. A strategy can be navigated from current mandate back through evidence and lineage.
7. Long-running work can continue while the operator navigates elsewhere.
8. Risk warnings and halts are impossible to miss without using animation.
9. The interface remains usable around 80 columns.
10. Essential status remains understandable without colour.
11. Important actions are keyboard efficient but discoverable.
12. Failure screens preserve context and state whether anything changed.
13. Raw model reasoning is unnecessary to understand an operational decision.
14. The interface remains useful before real-money trading exists.
15. The first-run path leads directly to creating useful research rather than infrastructure setup.

---

## 28. Governing UX Principle

> **The operator manages evidence, decisions, capital, and risk. Agents remain workers behind the system.**

The product should feel like a compact fund control room—not a chat client and not a casino dashboard.
