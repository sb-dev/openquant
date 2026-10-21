---
id: OQ-04
title: OpenQuant — Ink UX/UI
version: 1.0.0
status: canonical
updated: 2026-10-19
owns: screens, navigation, focus, input, states, confirmations, terminal behaviour
---

# OpenQuant — Ink UX/UI

This document defines required behaviour. It does not claim that the behaviour is implemented.
See the [specification index](README.md) for ownership and the current bootstrap scope.

## 1. Purpose

The interface lets an operator see what the fund is doing, find unresolved decisions, inspect strategy evidence, understand exposed capital and risk, and trace decisions.

Present attention, evidence, capital, and risk before agent activity or raw market data. Use concise summaries with drill-down to runs, findings, and provenance.

This specification owns screens, navigation, input, status, confirmations, and terminal behaviour. Backend implementation belongs to the architecture specification.

## 2. Navigation and shell

Launch the persistent terminal experience with `openquant`.

| Workspace | Main contents |
| --- | --- |
| Overview | Attention queue, fund state, active work, Arena movement, portfolio and risk summary. |
| Foundry | Research missions, hypotheses, proposals, budgets, critic findings. |
| Arena | All strategies, cohorts, evidence, comparisons, promotion review. |
| Portfolio | Mandates, cash, positions, allocation, attribution, exposure, risk detail. |
| Operations | Research/evaluation work, orders, reconciliation, incidents, service state, audit. |

Strategy Detail is shared across entry points. Agent activity appears within mission/run detail. Audit is a filtered view in Operations. Settings and Help are secondary. Do not add separate primary Strategies, Risk, or Agents workspaces.

Risk status and the route to risk/emergency controls remain persistent from every workspace. Consolidated navigation must not hide risk.

The shell contains a header, navigation, current view, and contextual footer. Always show environment, account, selected run or session mode, real/simulated money state, data observation time, risk state, and time zone.

Use explicit labels:

| Dimension | Labels |
| --- | --- |
| Environment | `DEV`, `STAGING`, `PROD` |
| Result/session mode | `REPLAY`, `BACKTEST`, `PAPER`, `SHADOW`, `LIVE` |
| Live mandate tier | `MICRO`, `PRODUCTION` |
| Market data | `LIVE`, `DELAYED`, `STALE`, `OFFLINE` |
| Risk | `OK`, `WARN`, `BREACH`, `HALTED`, `UNKNOWN` |

Production hosting does not imply real-money trading. A `LIVE` result with a `MICRO` mandate must show both labels. Every status remains clear without colour.

## 3. Overview and attention

Order the Overview as attention, fund state, Arena movement, portfolio/risk, and recent activity. Attention items show severity, affected object, reason, category, age, and the next action.

Promotion candidates, critic disagreements, stale data, unusual execution, limit warnings, failed work, and reconciliation mismatches enter the same attention queue.

Use `OPEN`, `ACKNOWLEDGED`, and `RESOLVED`. Acknowledgement does not hide unresolved risk. Opening an item goes directly to its decision or investigation context.

Show NAV, cash, drawdown, exposure, and active strategies only with their period, money mode, and observation time. Unknown values remain unknown; they are not zero.

## 4. Foundry

A Research Mission is a bounded objective. The list shows intent, status, candidate count, and budget use. Detail includes constraints, hypotheses, rejected ideas, competing versions, critic findings, attempts, and remaining budget.

Create a mission through a short structured flow. Use free text for the objective. Select the market profile, horizon, constraints, cohort policy, candidate limit, experiment limit, compute budget, model budget, and revision limit from valid controls.

Review resource use before starting a costly operation. Show exhaustion as a paused or blocked state with retained outcomes. Do not quietly raise limits.

Show proposer and critic work as structured outcomes. Include role, task, result, version, usage, and evidence links. Do not require hidden model reasoning to explain an operational decision.

Agent detail shows scope, tool permissions, execution profile, actual model when reported, behaviour version, resolved forecast sample count, calibration, and failures. Unknown provenance is labelled unknown. Do not rank unrelated roles on one reputation score.

## 5. Arena

Compare strategies within economically comparable cohorts. Display mismatched periods separately. Retain failed, retired, and paused candidates, losses, outages, and complete search history.

Default order is promotion readiness, evidence strength, portfolio contribution, risk, then performance. Show lifecycle separately from the currently running test.

Each strategy row exposes version, lifecycle, required evidence, net return, drawdown, sample size, trial count, risk, and promotion status where space allows. Drill-down exposes tail loss, turnover, costs, capacity, exposure, uncertainty, and methodology.

Use explicit outcomes:

| Concern | Values |
| --- | --- |
| Run status | `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| Gate result | `PASS`, `FAIL`, `INSUFFICIENT`, `NOT_APPLICABLE` |
| Decision outcome | `APPROVED`, `REJECTED`, `DEFERRED` |

A completed evaluation can fail its gates. A passed gate does not grant capital. Missing evidence is `INSUFFICIENT`. `NOT_APPLICABLE` must expose the approved policy reason.

Evidence summaries show contract validity, independent critique, historical testing, robustness, prospective paper evidence, and shadow readiness as separate checks. Each compact label has a discoverable legend. Do not invent a universal gate count when cohort policies differ.

Comparison shows the same metrics, units, periods, methods, costs, trial counts, uncertainty, and open findings for each candidate. Replace unexplained scores such as “robustness HIGH” or “portfolio +0.31” with defined measures and their limits.

## 6. Strategy Detail

The header shows strategy identity, immutable version, parent, hypothesis, cohort, lifecycle, and readiness. Use these tabs:

| Tab | Contents |
| --- | --- |
| Summary | Evidence, current run, risk, portfolio fit, open findings, invalidation conditions. |
| Evidence | Required tests, outcomes, missing evidence, approved exclusions, critic findings. |
| Runs | Chronological history including failed, cancelled, reused, and retired work. |
| Lineage | Parent versions, hypothesis, linked runs/findings/decisions; no manual graph editing. |
| Capital | Mandate, allowed instruments, ceilings, utilisation, expiry, installed revision, review date. |
| Activity | Timestamp, actor/role, action, outcome, evidence reference. |

Opening evidence shows declared inputs, strategy and dataset versions, engine identity, parameters, costs, suite, seeds where used, metrics, warnings, and the resulting decision.

Keep the route from an active mandate back to its approval, evidence, trials, and original hypothesis. Show old versions without implying they retain authority.

## 7. Promotion and mandate review

Promotion uses a dedicated review screen. Present the exact version, account, current state, proposed state, evidence manifest, gate results, blocking findings, policy revision, and proposed mandate.

For paper-to-shadow, show prospective observations and their coverage alongside execution-path readiness. Do not replace the policy with a fixed day count.

For real money, show capital, instrument permissions, all applicable limits, expiry, and the effect on broker orders. Use typed confirmation that identifies the action and object, for example `PROMOTE S17`. Example identifiers are not defaults.

The safe default is cancellation. Reject stale reviews and require the operator to inspect the current revision. Do not silently replace values while a confirmation is open.

After approval, show `APPROVED`, `INSTALLED`, and `ACTIVE` separately. Do not report activation until the authoritative state confirms the engine's installed revision and active state.

## 8. Portfolio and risk

Portfolio shows NAV, cash, gross/net exposure, drawdown, strategy allocation, mandate utilisation, working-order reservations, costs, and attribution. Separate gross strategy exposure from net account exposure.

Provide strategy, asset, sector, factor, correlation, and attribution views where the market profile supports them. Present correlation as clusters, sorted pairs, and threshold warnings. Use a compact matrix only when the terminal has space.

Allocation review compares the current and proposed portfolio under the same scenarios. Show the changes in return, tail loss, drawdown, exposure, turnover, and costs separately. Retained cash is a valid outcome.

Risk detail shows the rule, current value, limit, unit, utilisation, data time, warnings, breaches, and control status. Unknown risk is not `OK`.

Separate these actions:

| Action | Explain before confirmation |
| --- | --- |
| Pause strategy | Blocks new strategy risk and requests applicable cancellations; existing exposure remains managed under its exit policy. |
| Halt account | Blocks ordinary new submissions and requests cancellation of cancellable orders; reconciliation continues. |
| Liquidate | Requests separately authorised closing orders within its execution limits. |

Halt does not automatically liquidate positions or guarantee cancellation. Show requested and confirmed cancellation separately. Explain that a loss limit is an intervention threshold, not a guaranteed maximum loss.

Emergency controls are reachable from every workspace through the persistent risk route. Use an explicit, concise confirmation such as `HALT`; do not add unrelated screens. Show the independent broker emergency route when the ordinary application is unavailable.

## 9. Operations and audit

Use views for work, evaluations, orders, reconciliation, incidents, services, and audit. Work includes research and evaluation progress plus pending control commands. Do not present every approval as a separate durable workflow.

Show stage, elapsed time, last progress, attempt, retry count, and cancellation availability. Display percentages only when total work is known. Leaving the view does not cancel the work.

Orders show time, account/strategy, instrument, side, quantity, state, and money mode. Expose `UNKNOWN` submissions and pending cancellations. A simulated fill cannot look like a broker fill.

Reconciliation shows positions, open orders, cash, last completion, and discrepancies. Mismatches create attention items. Service status stays high level; detailed diagnostics sit behind a reference.

Audit is read-only. Filter by actor, strategy, action, risk, time, and environment. Detail shows inputs, evidence, policy revision, action outcome, and resulting state. A correction remains visible as a new record.

## 10. Search, input, and focus

`/` searches the current view. `:` opens global navigation and actions. Show only permitted, currently valid actions. The palette cannot bypass review or confirmation.

| Context | Keys |
| --- | --- |
| Global | `?` Help; `:` palette; `/` search; `Esc` back/close; `Tab` and `Shift+Tab` focus; `g` navigation. |
| Lists | Up/`k`, Down/`j`, `Enter` open, `Space` compare where supported. |
| Detail | Left/`h`, Right/`l` change tab; `A` actions. |
| Local interaction | `Ctrl+C` cancels the local interaction, or exits when no interaction owns it. |

Input modes are `NAVIGATION`, `SEARCH`, `EDITING`, `SELECTION`, `CONFIRMATION`, and `COMMAND`. The active mode determines shortcuts and footer hints.

Dialogs own focus. Hidden controls receive no input. Text entry disables conflicting single-letter shortcuts. Pasted text is text, never a stream of commands. Focus has a non-colour indicator.

Quitting detaches the client. Cancelling a remote mission requires its own explicit command. Pausing a strategy and halting an account are different actions.

## 11. Visual and responsive behaviour

Use alignment, concise labels, whitespace, and restrained emphasis. Align financial values and use consistent precision, units, and signs. Colour supplements text; it never carries meaning alone. Avoid flashing P&L, celebratory animation, agent avatars, and excessive borders.

| Width | Layout |
| --- | --- |
| 120+ columns | Navigation rail, paired summaries, wider comparisons. |
| 80–119 columns | Compact navigation, primary table, stacked detail. |
| Below 80 columns | Single column, vertical key/value detail, palette navigation, minimal borders. |

Preserve the decision, warnings, action target, operating mode, and risk before secondary metadata. Never rely on clipping. If the terminal cannot fit a safe confirmation, require resize before proceeding.

Support no colour, ASCII fallback, terminal resize, and plain output for non-interactive use. Restore terminal state on normal exit, cancellation, signals, and failure.

Risk and mode changes appear promptly. Updates must not move the selected row, replace entered values, or complete a confirmation. Bound redraw frequency. Completed output stays stable.

## 12. Connectivity and command outcomes

Show data observation time and connection state whenever freshness is uncertain. A degraded stream is not labelled live. On reconnect, refresh authoritative state before allowing consequential actions.

Distinguish `PENDING`, `UNKNOWN`, `REJECTED`, and confirmed completion. A timeout does not prove that no state changed. Resolve the existing command before offering a new submission.

Errors preserve context and state what failed, whether the outcome is known, whether retry is safe, what to do next, and a diagnostic reference. Show “No state changed” only when authoritative evidence establishes that fact. Keep raw stack traces out of normal views.

## 13. Confirmations and environments

| Risk | Interaction | Examples |
| --- | --- | --- |
| Low | No confirmation | Open, inspect, search, filter, compare. |
| Medium | Explicit confirmation | Cancel a mission, reject promotion, pause paper work, start costly evaluation. |
| High | Typed confirmation | Enable real capital, increase a live mandate, weaken limits, resume after a risk halt, halt, liquidate. |

Each consequential review states the exact action, object, account, capital/risk consequence, reversibility, and safe default. Do not use a generic “Are you sure?” prompt.

Environment changes are explicit. Entering production grants no trading authority. Keep permission failures discoverable; show unavailable actions with the reason where possible.

## 14. First run and empty states

The credential-free first run is `openquant demo` with bundled replay data. Identify recorded agent material and calculated engine outputs. Do not imply the bootstrap already provides this command.

The connected product starts with a mission prompt when none exist. Explain the operating loop without requiring unrelated broker setup. Live controls stay unavailable until their prerequisites are satisfied.

An empty Arena points to Foundry. No real capital points to paper/shadow evidence. An empty attention queue says there are no unresolved items and shows current risk. Do not celebrate the absence of alerts.

## 15. UX acceptance

Verify persistent environment/account/mode/freshness/risk context; attention routing; evidence before performance; separate paper/shadow/live labels; guarded promotion; complete lineage; background continuity; persistent risk access; 80-column operation; no-colour/ASCII use; discoverable keyboard control; safe focus/paste/resize; honest failure outcomes; and useful operation before real money.

A15 owns terminal state and authoritative read-back. A16 owns the installed demo. Domain and engineering tests own financial correctness and recovery. A screenshot alone satisfies neither.

## 16. Source migration

Retains the Ink UX/UI v1.1 interaction requirements. Applies Design v2 §14 and Repository Design v1.1 §9: five workspaces, two AI roles, explicit gate/decision states, activation acknowledgement, stale-review rejection, `UNKNOWN` outcomes, and detach semantics. Illustrative returns and capital amounts are not operating defaults.
