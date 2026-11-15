//! What binds the evidence of the `assess` job (OQ-02 sections 3.1, 3.2 and 3.6; decisions D2,
//! D18 and D20 of the S1 pilot record).
//!
//! The dispatch of an `assess` job names the evaluation plan by reference, the candidate's trial
//! slot and the runs of that slot with the labels that the API gave them. The plan is the
//! registered comparison: it lists the planned runs of each trial slot with their window role and
//! cost scenario, and the sessions each window resolved to. The job binds before it decides:
//!
//! * Every run of the dispatch is placed in a planned slot of its trial slot with the same window
//!   role and cost scenario, and the planned slot is claimed by one run only. A planned slot that
//!   no run claims becomes a run without a result.
//! * A submission is the run's: the run id, the engine digest and the method of the running
//!   binary. The input that the run used has the windows that the plan resolved for its role.
//! * The metrics are the run's: its id, its window role and cost scenario, the plan's scored
//!   window, the result the submission cites, the input hash and the engine digest of the run that
//!   the job rebuilt, the candidate's strategy hash and the running method. The job also
//!   recomputes them from the rebuilt run (`assess.rs`).
//! * The validation result is the candidate's draft, under the running engine and method.
//! * The manifest is the dataset that the runs' inputs name.
//!
//! The functions here are pure. Each returns the first [`Mismatch`] it finds, or `None`. Evidence
//! with a mismatch is passed to the gates marked as such, and the gates never read it.

use std::collections::{BTreeMap, BTreeSet};

use openquant_core::{
    gates::Mismatch,
    metrics::{MethodRef, Scenario, Window},
};
use serde_json::Value;

fn text<'v>(document: &'v Value, pointer: &str) -> Option<&'v str> {
    document.pointer(pointer).and_then(Value::as_str)
}

/// `None` when `found` is `required`.
fn differs(field: &str, required: &str, found: Option<&str>) -> Option<Mismatch> {
    if found == Some(required) {
        None
    } else {
        Some(Mismatch::new(field, required, found.unwrap_or("absent")))
    }
}

/// One window of the plan, resolved to sessions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanWindow {
    pub warmup_start: String,
    pub scored_start: String,
    pub scored_end: String,
    pub information_cutoff: String,
}

/// One planned run of the candidate's trial slot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedSlot {
    pub id: String,
    pub window: Window,
    pub scenario: Scenario,
    /// The planned slot that this one repeats.
    pub replay_of: Option<String>,
}

/// The part of an `evaluation-plan/1` that binds one candidate.
#[derive(Clone, Debug)]
pub struct Plan {
    trial_slot: String,
    slots: Vec<PlannedSlot>,
    windows: BTreeMap<Window, PlanWindow>,
}

impl Plan {
    /// Read the planned runs of `trial_slot` and the resolved windows from an `evaluation-plan/1`.
    ///
    /// # Errors
    /// A message when the plan contradicts itself: a window role or a run slot listed twice.
    pub fn read(plan: &Value, trial_slot: &str) -> Result<Self, String> {
        let list = |pointer: &str| -> Vec<&Value> {
            plan.pointer(pointer)
                .and_then(Value::as_array)
                .map(|items| items.iter().collect())
                .unwrap_or_default()
        };
        let member = |entry: &Value, pointer: &str| -> Result<String, String> {
            text(entry, pointer)
                .map(str::to_owned)
                .ok_or_else(|| format!("an entry of the plan has no {pointer}"))
        };
        let mut windows = BTreeMap::new();
        for entry in list("/windows") {
            let role = member(entry, "/role")?;
            let role = Window::from_wire(&role)
                .ok_or_else(|| format!("the plan names the window role {role}"))?;
            let window = PlanWindow {
                warmup_start: member(entry, "/resolved/warmup_start")?,
                scored_start: member(entry, "/resolved/scored_start")?,
                scored_end: member(entry, "/resolved/scored_end")?,
                information_cutoff: member(entry, "/resolved/information_cutoff")?,
            };
            if windows.insert(role, window).is_some() {
                return Err(format!("the plan lists the {} window twice", role.wire()));
            }
        }
        let mut ids = BTreeSet::new();
        let mut slots = Vec::new();
        for entry in list("/run_slots") {
            let id = member(entry, "/run_slot_id")?;
            if !ids.insert(id.clone()) {
                return Err(format!("the plan lists the run slot {id} twice"));
            }
            if member(entry, "/trial_slot")? != trial_slot {
                continue;
            }
            let window = member(entry, "/window_role")?;
            let scenario = member(entry, "/cost_scenario")?;
            slots.push(PlannedSlot {
                window: Window::from_wire(&window)
                    .ok_or_else(|| format!("the run slot {id} names the window role {window}"))?,
                scenario: Scenario::from_wire(&scenario).ok_or_else(|| {
                    format!("the run slot {id} names the cost scenario {scenario}")
                })?,
                replay_of: text(entry, "/replay_of").map(str::to_owned),
                id,
            });
        }
        Ok(Self {
            trial_slot: trial_slot.to_owned(),
            slots,
            windows,
        })
    }

    /// The planned run of the trial slot with this id.
    #[must_use]
    pub fn slot(&self, id: &str) -> Option<&PlannedSlot> {
        self.slots.iter().find(|slot| slot.id == id)
    }

    /// The window that the plan resolved for a role.
    #[must_use]
    pub fn window(&self, role: Window) -> Option<&PlanWindow> {
        self.windows.get(&role)
    }

    /// The planned runs of the trial slot, in plan order.
    #[must_use]
    pub fn slots(&self) -> &[PlannedSlot] {
        &self.slots
    }
}

/// One run of the dispatch, with the labels that the API gave it.
#[derive(Clone, Debug)]
pub struct Claim<'a> {
    pub run_id: &'a str,
    pub run_slot: &'a str,
    pub window: Window,
    pub scenario: Scenario,
    /// The run that this one repeats.
    pub replay_of: Option<&'a str>,
}

/// Where one run of the dispatch stands against the plan.
#[derive(Clone, Debug)]
pub struct Placement {
    /// The window and scenario that the evidence of the run is filed under: the planned slot's
    /// when the run names one, else the dispatch's.
    pub window: Window,
    pub scenario: Scenario,
    /// The run it repeats, as the plan says: some run when the planned slot repeats another one.
    pub repeat_of: Option<String>,
    /// Why the run is not the run of the slot that it names. `None` for a run that binds.
    pub mismatch: Option<Mismatch>,
}

/// A planned run that no run of the dispatch claims.
#[derive(Clone, Debug)]
pub struct Unfilled {
    pub slot: PlannedSlot,
    /// The run that it would repeat: the run of the planned base slot, else the base slot's id.
    pub repeat_of: Option<String>,
}

/// The runs of a dispatch against the plan.
#[derive(Clone, Debug)]
pub struct Placed {
    /// One placement per claim, in order.
    pub runs: Vec<Placement>,
    /// The planned runs of the trial slot that no claim names.
    pub unfilled: Vec<Unfilled>,
}

/// Place each claim in the plan, and list the planned runs that nobody claims.
#[must_use]
pub fn place(plan: &Plan, claims: &[Claim<'_>]) -> Placed {
    let mut claimants: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for claim in claims {
        claimants
            .entry(claim.run_slot)
            .or_default()
            .push(claim.run_id);
    }
    // The run of a planned slot, when exactly one run claims it.
    let sole_run = |slot: &str| -> Option<&str> {
        match claimants.get(slot).map(Vec::as_slice) {
            Some([only]) => Some(*only),
            _ => None,
        }
    };
    let runs = claims
        .iter()
        .map(|claim| {
            let Some(slot) = plan.slot(claim.run_slot) else {
                return Placement {
                    window: claim.window,
                    scenario: claim.scenario,
                    repeat_of: claim.replay_of.map(str::to_owned),
                    mismatch: Some(Mismatch::new(
                        "run_slot",
                        format!("a run slot of trial slot {} of the plan", plan.trial_slot),
                        claim.run_slot,
                    )),
                };
            };
            let repeat_of = slot.replay_of.as_ref().map(|base| {
                sole_run(base)
                    .or(claim.replay_of)
                    .map_or_else(|| base.clone(), str::to_owned)
            });
            let claimed_by = claimants.get(claim.run_slot).map_or(0, Vec::len);
            let mismatch = if claim.window != slot.window {
                Some(Mismatch::new(
                    "window_role",
                    slot.window.wire(),
                    claim.window.wire(),
                ))
            } else if claim.scenario != slot.scenario {
                Some(Mismatch::new(
                    "cost_scenario",
                    slot.scenario.wire(),
                    claim.scenario.wire(),
                ))
            } else if let Some(mismatch) = replay_mismatch(slot, claim, &sole_run) {
                Some(mismatch)
            } else if claimed_by > 1 {
                Some(Mismatch::new(
                    "run_slot",
                    "a planned slot that this run alone claims",
                    format!("{} (claimed by {claimed_by} runs)", slot.id),
                ))
            } else {
                None
            };
            Placement {
                window: slot.window,
                scenario: slot.scenario,
                repeat_of,
                mismatch,
            }
        })
        .collect();
    let unfilled = plan
        .slots()
        .iter()
        .filter(|slot| !claimants.contains_key(slot.id.as_str()))
        .map(|slot| Unfilled {
            slot: slot.clone(),
            repeat_of: slot
                .replay_of
                .as_ref()
                .map(|base| sole_run(base).map_or_else(|| base.clone(), str::to_owned)),
        })
        .collect();
    Placed { runs, unfilled }
}

/// The plan says whether a slot repeats another, and which run is the other.
fn replay_mismatch<'a>(
    slot: &PlannedSlot,
    claim: &Claim<'_>,
    sole_run: &dyn Fn(&str) -> Option<&'a str>,
) -> Option<Mismatch> {
    match (&slot.replay_of, claim.replay_of) {
        (None, None) => None,
        (None, Some(found)) => Some(Mismatch::new(
            "replay_of",
            "none: the plan does not make this slot a repeat",
            found,
        )),
        (Some(base), None) => Some(Mismatch::new(
            "replay_of",
            format!("the run of slot {base}"),
            "none",
        )),
        (Some(base), Some(found)) => match sole_run(base) {
            Some(run) if run != found => Some(Mismatch::new("replay_of", run, found)),
            _ => None,
        },
    }
}

/// What the evidence is compared with: the plan, the candidate and the running binary.
#[derive(Clone, Debug)]
pub struct Binder<'a> {
    pub plan: &'a Plan,
    /// The candidate's strategy hash.
    pub strategy_hash: &'a str,
    /// The engine digest of the running binary.
    pub engine_digest: &'a str,
    /// The method identity of the running binary.
    pub method: &'a MethodRef,
}

/// What the metrics of one run derive from, as the job rebuilt it.
#[derive(Clone, Debug)]
pub struct MetricsSource<'a> {
    pub run_id: &'a str,
    pub window: Window,
    pub scenario: Scenario,
    /// The digest of the evaluation result that the submission cites.
    pub result_digest: &'a str,
    /// The input hash and the engine digest of the run that the job rebuilt.
    pub input_hash: &'a str,
    pub engine_digest: &'a str,
}

impl Binder<'_> {
    fn method_mismatch(&self, field: &str, document: &Value) -> Option<Mismatch> {
        let name = text(document, "/method/name");
        let version = text(document, "/method/version");
        let digest = text(document, "/method/digest");
        if name == Some(self.method.name.as_str())
            && version == Some(self.method.version.as_str())
            && digest == Some(self.method.digest.as_str())
        {
            return None;
        }
        Some(Mismatch::new(
            field,
            format!(
                "{} version {} {}",
                self.method.name, self.method.version, self.method.digest
            ),
            format!(
                "{} version {} {}",
                name.unwrap_or("absent"),
                version.unwrap_or("absent"),
                digest.unwrap_or("absent")
            ),
        ))
    }

    /// A submission is the run's, from the running engine and method.
    #[must_use]
    pub fn submission(&self, run_id: &str, document: &Value) -> Option<Mismatch> {
        differs("submission.run_id", run_id, text(document, "/run_id"))
            .or_else(|| {
                differs(
                    "submission.engine_digest",
                    self.engine_digest,
                    text(document, "/engine_digest"),
                )
            })
            .or_else(|| self.method_mismatch("submission.method", document))
    }

    /// The input that a run used has the windows that the plan resolved for its role.
    #[must_use]
    pub fn input_windows(&self, role: Window, input: &Value) -> Option<Mismatch> {
        let Some(planned) = self.plan.window(role) else {
            return Some(Mismatch::new(
                "input.windows",
                format!("a {} window in the plan", role.wire()),
                "none",
            ));
        };
        [
            ("warmup_start", &planned.warmup_start),
            ("scored_start", &planned.scored_start),
            ("scored_end", &planned.scored_end),
            ("information_cutoff", &planned.information_cutoff),
        ]
        .into_iter()
        .find_map(|(key, required)| {
            differs(
                &format!("input.windows.{key}"),
                required,
                text(input, &format!("/windows/{key}")),
            )
        })
    }

    /// The metrics document derives from this run, window, scenario, result and method.
    #[must_use]
    pub fn metrics(&self, source: &MetricsSource<'_>, document: &Value) -> Option<Mismatch> {
        let scored = self.plan.window(source.window);
        differs("metrics.run_id", source.run_id, text(document, "/run_id"))
            .or_else(|| {
                differs(
                    "metrics.window.role",
                    source.window.wire(),
                    text(document, "/window/role"),
                )
            })
            .or_else(|| {
                differs(
                    "metrics.window.cost_scenario",
                    source.scenario.wire(),
                    text(document, "/window/cost_scenario"),
                )
            })
            .or_else(|| {
                let Some(planned) = scored else {
                    return Some(Mismatch::new(
                        "metrics.window.scored",
                        format!("the {} window of the plan", source.window.wire()),
                        "no such window",
                    ));
                };
                let required = format!("{} to {}", planned.scored_start, planned.scored_end);
                let found = format!(
                    "{} to {}",
                    text(document, "/window/scored/start").unwrap_or("absent"),
                    text(document, "/window/scored/end").unwrap_or("absent")
                );
                (found != required).then(|| Mismatch::new("metrics.window.scored", required, found))
            })
            .or_else(|| {
                differs(
                    "metrics.source.result_digest",
                    source.result_digest,
                    text(document, "/source/result_digest"),
                )
            })
            .or_else(|| {
                differs(
                    "metrics.source.input_hash",
                    source.input_hash,
                    text(document, "/source/input_hash"),
                )
            })
            .or_else(|| {
                differs(
                    "metrics.source.strategy_hash",
                    self.strategy_hash,
                    text(document, "/source/strategy_hash"),
                )
            })
            .or_else(|| {
                differs(
                    "metrics.source.engine_digest",
                    source.engine_digest,
                    text(document, "/source/engine_digest"),
                )
            })
            .or_else(|| self.method_mismatch("metrics.method", document))
    }

    /// A validation result is the candidate's draft, from the running engine and method.
    #[must_use]
    pub fn validation(&self, document: &Value) -> Option<Mismatch> {
        differs(
            "validation.draft_digest",
            self.strategy_hash,
            text(document, "/draft_digest"),
        )
        .or_else(|| {
            differs(
                "validation.engine_digest",
                self.engine_digest,
                text(document, "/engine_digest"),
            )
        })
        .or_else(|| self.method_mismatch("validation.method", document))
    }
}

/// A manifest is the dataset that the inputs of the runs name. `datasets` is the `dataset` member
/// of the input of each run that binds, with the run's id.
#[must_use]
pub fn dataset_mismatch(document: &Value, datasets: &[(String, Value)]) -> Option<Mismatch> {
    let required = document.get("dataset").unwrap_or(&Value::Null);
    datasets
        .iter()
        .find(|(_, used)| used != required)
        .map(|(run, used)| {
            Mismatch::new(
                "manifest.dataset",
                format!("the dataset of the input of run {run}: {used}"),
                required.to_string(),
            )
        })
}

/// The first place where `found` differs from `expected`, as a JSON pointer with the two values.
#[must_use]
pub fn first_difference(expected: &Value, found: &Value) -> Option<(String, String, String)> {
    fn walk(path: &str, expected: &Value, found: &Value) -> Option<(String, String, String)> {
        match (expected, found) {
            (Value::Object(x), Value::Object(y)) => {
                for (key, value) in x {
                    let here = format!("{path}/{key}");
                    match y.get(key) {
                        Some(other) => {
                            if let Some(found) = walk(&here, value, other) {
                                return Some(found);
                            }
                        }
                        None => return Some((here, value.to_string(), "absent".to_owned())),
                    }
                }
                y.iter()
                    .find(|(key, _)| !x.contains_key(*key))
                    .map(|(key, value)| {
                        (
                            format!("{path}/{key}"),
                            "absent".to_owned(),
                            value.to_string(),
                        )
                    })
            }
            (Value::Array(x), Value::Array(y)) => {
                for (index, (value, other)) in x.iter().zip(y).enumerate() {
                    if let Some(found) = walk(&format!("{path}/{index}"), value, other) {
                        return Some(found);
                    }
                }
                (x.len() != y.len()).then(|| {
                    (
                        path.to_owned(),
                        format!("{} items", x.len()),
                        format!("{} items", y.len()),
                    )
                })
            }
            _ => (expected != found)
                .then(|| (path.to_owned(), expected.to_string(), found.to_string())),
        }
    }
    walk("", expected, found)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn plan() -> Plan {
        Plan::read(
            &json!({
                "windows": [
                    {"role": "DEVELOPMENT", "resolved": {"warmup_start": "2024-01-01", "scored_start": "2024-03-01", "scored_end": "2024-05-31", "information_cutoff": "2024-05-31T23:00:00Z"}},
                    {"role": "VALIDATION", "resolved": {"warmup_start": "2024-04-01", "scored_start": "2024-06-03", "scored_end": "2024-08-30", "information_cutoff": "2024-08-30T23:00:00Z"}},
                ],
                "run_slots": [
                    {"run_slot_id": "s.d.base", "trial_slot": "s", "window_role": "DEVELOPMENT", "cost_scenario": "BASE"},
                    {"run_slot_id": "s.d.rep", "trial_slot": "s", "window_role": "DEVELOPMENT", "cost_scenario": "BASE", "replay_of": "s.d.base"},
                    {"run_slot_id": "s.v.base", "trial_slot": "s", "window_role": "VALIDATION", "cost_scenario": "BASE"},
                    {"run_slot_id": "t.d.base", "trial_slot": "t", "window_role": "DEVELOPMENT", "cost_scenario": "BASE"},
                ],
            }),
            "s",
        )
        .unwrap()
    }

    fn claim<'a>(
        run: &'a str,
        slot: &'a str,
        window: Window,
        replay_of: Option<&'a str>,
    ) -> Claim<'a> {
        Claim {
            run_id: run,
            run_slot: slot,
            window,
            scenario: Scenario::Base,
            replay_of,
        }
    }

    #[test]
    fn the_plan_lists_the_planned_runs_of_its_trial_slot_only() {
        let plan = plan();
        let ids: Vec<&str> = plan.slots().iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["s.d.base", "s.d.rep", "s.v.base"]);
        assert_eq!(
            plan.window(Window::Validation).unwrap().scored_start,
            "2024-06-03"
        );
        assert!(plan.window(Window::Holdout).is_none());
    }

    #[test]
    fn a_plan_that_repeats_a_window_or_a_slot_is_refused() {
        let twice = json!({"windows": [
            {"role": "HOLDOUT", "resolved": {"warmup_start": "a", "scored_start": "b", "scored_end": "c", "information_cutoff": "d"}},
            {"role": "HOLDOUT", "resolved": {"warmup_start": "a", "scored_start": "b", "scored_end": "c", "information_cutoff": "d"}},
        ], "run_slots": []});
        assert!(Plan::read(&twice, "s").unwrap_err().contains("twice"));
        let slots = json!({"windows": [], "run_slots": [
            {"run_slot_id": "x", "trial_slot": "s", "window_role": "HOLDOUT", "cost_scenario": "BASE"},
            {"run_slot_id": "x", "trial_slot": "t", "window_role": "HOLDOUT", "cost_scenario": "BASE"},
        ]});
        assert!(Plan::read(&slots, "s").unwrap_err().contains("twice"));
    }

    #[test]
    fn runs_that_match_the_plan_bind_and_the_unclaimed_slot_is_listed() {
        let plan = plan();
        let claims = [
            claim("r1", "s.d.base", Window::Development, None),
            claim("r2", "s.d.rep", Window::Development, Some("r1")),
        ];
        let placed = place(&plan, &claims);
        assert!(placed.runs.iter().all(|p| p.mismatch.is_none()));
        assert_eq!(placed.runs[1].repeat_of.as_deref(), Some("r1"));
        assert_eq!(placed.runs[0].repeat_of, None);
        let unfilled: Vec<&str> = placed.unfilled.iter().map(|u| u.slot.id.as_str()).collect();
        assert_eq!(unfilled, ["s.v.base"]);
    }

    #[test]
    fn a_label_that_is_not_the_slots_is_a_mismatch_and_the_run_is_filed_under_the_plan() {
        let plan = plan();
        let placed = place(&plan, &[claim("r3", "s.v.base", Window::Development, None)]);
        let mismatch = placed.runs[0].mismatch.as_ref().unwrap();
        assert_eq!(mismatch.field, "window_role");
        assert_eq!(mismatch.required, "VALIDATION");
        assert_eq!(mismatch.found, "DEVELOPMENT");
        assert_eq!(placed.runs[0].window, Window::Validation);
        let mut stress = claim("r3", "s.v.base", Window::Validation, None);
        stress.scenario = Scenario::CostStress;
        let placed = place(&plan, &[stress]);
        assert_eq!(
            placed.runs[0].mismatch.as_ref().unwrap().field,
            "cost_scenario"
        );
    }

    #[test]
    fn a_slot_of_another_trial_slot_or_of_no_slot_is_a_mismatch() {
        let plan = plan();
        for slot in ["t.d.base", "nowhere"] {
            let placed = place(&plan, &[claim("r4", slot, Window::Development, None)]);
            let mismatch = placed.runs[0].mismatch.as_ref().unwrap();
            assert_eq!(mismatch.field, "run_slot", "{slot}");
            assert_eq!(mismatch.found, slot);
            assert_eq!(placed.unfilled.len(), 3, "no slot of the plan is filled");
        }
    }

    #[test]
    fn two_runs_for_one_slot_are_both_mismatches() {
        let plan = plan();
        let claims = [
            claim("r5", "s.v.base", Window::Validation, None),
            claim("r6", "s.v.base", Window::Validation, None),
        ];
        let placed = place(&plan, &claims);
        for placement in &placed.runs {
            let mismatch = placement.mismatch.as_ref().unwrap();
            assert!(mismatch.found.contains("claimed by 2 runs"), "{mismatch}");
        }
    }

    #[test]
    fn the_plan_decides_which_run_repeats_which() {
        let plan = plan();
        let base = claim("r1", "s.d.base", Window::Development, None);
        // A repeat without its replay_of, a base that claims one, and a repeat of another run.
        let missing = place(
            &plan,
            &[
                base.clone(),
                claim("r2", "s.d.rep", Window::Development, None),
            ],
        );
        assert_eq!(
            missing.runs[1].mismatch.as_ref().unwrap().field,
            "replay_of"
        );
        assert_eq!(missing.runs[1].repeat_of.as_deref(), Some("r1"));
        let extra = place(
            &plan,
            &[claim("r1", "s.d.base", Window::Development, Some("r9"))],
        );
        assert_eq!(extra.runs[0].mismatch.as_ref().unwrap().field, "replay_of");
        assert_eq!(extra.runs[0].repeat_of, None);
        let other = place(
            &plan,
            &[
                base,
                claim("r2", "s.d.rep", Window::Development, Some("r9")),
            ],
        );
        let mismatch = other.runs[1].mismatch.as_ref().unwrap();
        assert_eq!(
            (mismatch.required.as_str(), mismatch.found.as_str()),
            ("r1", "r9")
        );
        // An unfilled repeat names the run of its base slot, else the base slot.
        let unfilled = place(&plan, &[claim("r1", "s.d.base", Window::Development, None)]);
        let repeat = unfilled
            .unfilled
            .iter()
            .find(|u| u.slot.id == "s.d.rep")
            .unwrap();
        assert_eq!(repeat.repeat_of.as_deref(), Some("r1"));
        let none = place(&plan, &[]);
        let repeat = none
            .unfilled
            .iter()
            .find(|u| u.slot.id == "s.d.rep")
            .unwrap();
        assert_eq!(repeat.repeat_of.as_deref(), Some("s.d.base"));
    }

    fn binder<'a>(plan: &'a Plan, method: &'a MethodRef) -> Binder<'a> {
        Binder {
            plan,
            strategy_hash: "sha256:s",
            engine_digest: "sha256:e",
            method,
        }
    }

    fn method() -> MethodRef {
        MethodRef {
            name: "m".to_owned(),
            version: "1".to_owned(),
            digest: "sha256:m".to_owned(),
        }
    }

    #[test]
    fn a_submission_binds_to_the_run_the_engine_and_the_method() {
        let (plan, method) = (plan(), method());
        let binder = binder(&plan, &method);
        let good = json!({"run_id": "r1", "engine_digest": "sha256:e", "method": {"name": "m", "version": "1", "digest": "sha256:m"}});
        assert_eq!(binder.submission("r1", &good), None);
        for (field, pointer, value) in [
            ("submission.run_id", "run_id", json!("r2")),
            (
                "submission.engine_digest",
                "engine_digest",
                json!("sha256:x"),
            ),
        ] {
            let mut bad = good.clone();
            bad[pointer] = value;
            assert_eq!(binder.submission("r1", &bad).unwrap().field, field);
        }
        for member in ["name", "version", "digest"] {
            let mut bad = good.clone();
            bad["method"][member] = json!("other");
            assert_eq!(
                binder.submission("r1", &bad).unwrap().field,
                "submission.method"
            );
        }
        assert_eq!(
            binder.submission("r1", &json!({})).unwrap().found,
            "absent",
            "a missing member is a mismatch, never a pass"
        );
    }

    #[test]
    fn the_input_windows_are_the_plans() {
        let (plan, method) = (plan(), method());
        let binder = binder(&plan, &method);
        let input = json!({"windows": {"warmup_start": "2024-04-01", "scored_start": "2024-06-03", "scored_end": "2024-08-30", "information_cutoff": "2024-08-30T23:00:00Z"}});
        assert_eq!(binder.input_windows(Window::Validation, &input), None);
        assert_eq!(
            binder
                .input_windows(Window::Development, &input)
                .unwrap()
                .field,
            "input.windows.warmup_start"
        );
        assert_eq!(
            binder.input_windows(Window::Holdout, &input).unwrap().found,
            "none"
        );
    }

    #[test]
    fn the_metrics_name_the_run_the_window_the_result_and_the_method() {
        let (plan, method) = (plan(), method());
        let binder = binder(&plan, &method);
        let source = MetricsSource {
            run_id: "r3",
            window: Window::Validation,
            scenario: Scenario::Base,
            result_digest: "sha256:r",
            input_hash: "sha256:i",
            engine_digest: "sha256:e",
        };
        let good = json!({
            "run_id": "r3",
            "window": {"role": "VALIDATION", "cost_scenario": "BASE", "scored": {"start": "2024-06-03", "end": "2024-08-30"}},
            "source": {"result_digest": "sha256:r", "input_hash": "sha256:i", "strategy_hash": "sha256:s", "engine_digest": "sha256:e"},
            "method": {"name": "m", "version": "1", "digest": "sha256:m"},
        });
        assert_eq!(binder.metrics(&source, &good), None);
        for (field, pointer, value) in [
            ("metrics.run_id", "/run_id", json!("r4")),
            ("metrics.window.role", "/window/role", json!("HOLDOUT")),
            (
                "metrics.window.cost_scenario",
                "/window/cost_scenario",
                json!("COST_STRESS"),
            ),
            (
                "metrics.window.scored",
                "/window/scored/start",
                json!("2024-06-04"),
            ),
            (
                "metrics.window.scored",
                "/window/scored/end",
                json!("2024-08-29"),
            ),
            (
                "metrics.source.result_digest",
                "/source/result_digest",
                json!("sha256:x"),
            ),
            (
                "metrics.source.input_hash",
                "/source/input_hash",
                json!("sha256:x"),
            ),
            (
                "metrics.source.strategy_hash",
                "/source/strategy_hash",
                json!("sha256:x"),
            ),
            (
                "metrics.source.engine_digest",
                "/source/engine_digest",
                json!("sha256:x"),
            ),
            ("metrics.method", "/method/digest", json!("sha256:x")),
        ] {
            let mut bad = good.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            assert_eq!(
                binder.metrics(&source, &bad).unwrap().field,
                field,
                "{pointer}"
            );
        }
    }

    #[test]
    fn the_validation_names_the_draft_the_engine_and_the_method() {
        let (plan, method) = (plan(), method());
        let binder = binder(&plan, &method);
        let good = json!({"draft_digest": "sha256:s", "engine_digest": "sha256:e", "method": {"name": "m", "version": "1", "digest": "sha256:m"}});
        assert_eq!(binder.validation(&good), None);
        let mut bad = good.clone();
        bad["draft_digest"] = json!("sha256:x");
        assert_eq!(
            binder.validation(&bad).unwrap().field,
            "validation.draft_digest"
        );
        let mut bad = good;
        bad["method"]["version"] = json!("2");
        assert_eq!(binder.validation(&bad).unwrap().field, "validation.method");
    }

    #[test]
    fn the_manifest_is_the_dataset_of_every_run_that_binds() {
        let dataset = json!({"id": "d", "version": "1", "source": "PROVIDER", "licence": "l"});
        let manifest_doc = json!({"dataset": dataset});
        let runs = vec![
            ("r1".to_owned(), dataset.clone()),
            ("r2".to_owned(), dataset.clone()),
        ];
        assert_eq!(dataset_mismatch(&manifest_doc, &runs), None);
        assert_eq!(
            dataset_mismatch(&manifest_doc, &[]),
            None,
            "no run, nothing to bind"
        );
        let other = json!({"id": "d", "version": "2", "source": "PROVIDER", "licence": "l"});
        let mixed = vec![("r1".to_owned(), dataset), ("r2".to_owned(), other)];
        let mismatch = dataset_mismatch(&manifest_doc, &mixed).unwrap();
        assert_eq!(mismatch.field, "manifest.dataset");
        assert!(mismatch.required.contains("run r2"), "{mismatch}");
    }

    #[test]
    fn the_first_difference_is_found_by_path() {
        let a = json!({"x": {"y": [1, 2, 3]}, "z": "a"});
        assert_eq!(first_difference(&a, &a), None);
        let b = json!({"x": {"y": [1, 9, 3]}, "z": "a"});
        assert_eq!(
            first_difference(&a, &b),
            Some(("/x/y/1".to_owned(), "2".to_owned(), "9".to_owned()))
        );
        let c = json!({"x": {"y": [1, 2]}, "z": "a"});
        assert_eq!(first_difference(&a, &c).unwrap().0, "/x/y");
        let d = json!({"x": {"y": [1, 2, 3]}, "z": "a", "extra": 1});
        assert_eq!(first_difference(&a, &d).unwrap().0, "/extra");
    }
}
