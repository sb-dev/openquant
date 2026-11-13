//! Run preparation rejects invalid inputs with a typed failure before any event (OQ-02 sections
//! 2.5-2.6, OQ-06 section 8 "Invalid inputs"). Each test breaks one thing in an otherwise valid
//! input and checks the failure code. The mutated payloads skip the JSON Schema on purpose: the
//! core must hold these rules itself, because a caller can build an `EvaluationInput` without
//! going through the schema.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;
use openquant_contracts::EvaluationInput;
use openquant_core::{Failure, Run};
use serde_json::{Value, json};

fn base() -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
        quiet_bar("51", "52", "50", "51"),
    ])
}

/// Prepare the base scenario after `mutate` edited its input JSON.
fn prepare_with(mutate: impl FnOnce(&mut Value)) -> Result<Run, Failure> {
    prepare_scenario_with(&base(), mutate)
}

fn prepare_scenario_with(
    scenario: &Scenario,
    mutate: impl FnOnce(&mut Value),
) -> Result<Run, Failure> {
    let mut value = scenario.input_value();
    mutate(&mut value);
    let input: EvaluationInput = serde_json::from_value(value).expect("typed payload");
    Run::prepare(&scenario.strategy_artefact(), &input)
}

fn code_of(result: Result<Run, Failure>) -> String {
    result.unwrap_err().code.to_string()
}

#[test]
fn the_unmodified_base_input_prepares() {
    assert!(prepare_with(|_| {}).is_ok());
}

#[test]
fn an_unsorted_calendar_is_rejected() {
    let result = prepare_with(|v| {
        let sessions = v["calendar"]["sessions"].as_array_mut().unwrap();
        sessions.swap(1, 2);
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn an_overlapping_calendar_is_rejected() {
    // The third session opens before the second one closes.
    let result = prepare_with(|v| {
        v["calendar"]["sessions"][2]["open_at"] = json!(format!("{}T20:00:00Z", date(1)));
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn a_duplicate_session_is_rejected() {
    let result = prepare_with(|v| {
        let duplicate = v["calendar"]["sessions"][1].clone();
        v["calendar"]["sessions"][2] = duplicate;
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn a_session_that_closes_before_it_opens_is_rejected() {
    let result = prepare_with(|v| {
        v["calendar"]["sessions"][1]["close_at"] = json!(format!("{}T14:00:00Z", date(1)));
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn a_session_date_that_is_not_a_real_date_is_rejected() {
    // 2027-02-29 does not exist; 2028-02-29 does.
    let replace = |scenario: &Scenario, to: &str| {
        let text = scenario.input_value().to_string().replace(&date(3), to);
        let input: EvaluationInput = serde_json::from_str(&text).unwrap();
        Run::prepare(&scenario.strategy_artefact(), &input)
    };
    assert_eq!(code_of(replace(&base(), "2027-02-29")), "INVALID_INPUT");
    assert!(replace(&base(), "2028-02-29").is_ok());
    assert_eq!(code_of(replace(&base(), "2026-13-01")), "INVALID_INPUT");
    assert_eq!(code_of(replace(&base(), "2026-04-31")), "INVALID_INPUT");
}

#[test]
fn an_impossible_time_of_day_is_rejected() {
    for bad in ["T25:00:00Z", "T14:60:00Z", "T14:30:60Z"] {
        let result = prepare_with(|v| {
            v["calendar"]["sessions"][1]["open_at"] = json!(format!("{}{bad}", date(1)));
        });
        assert_eq!(code_of(result), "INVALID_INPUT", "{bad}");
    }
}

#[test]
fn a_bar_that_is_not_on_the_calendar_is_rejected() {
    let result = prepare_with(|v| {
        v["instruments"][0]["bars"][0]["session"] = json!("2026-03-30");
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn a_duplicate_bar_is_rejected() {
    let result = prepare_with(|v| {
        let duplicate = v["instruments"][0]["bars"][1].clone();
        v["instruments"][0]["bars"][2] = duplicate;
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn bars_with_inconsistent_prices_are_rejected() {
    // Base bar S0: open 50, high 51, low 49, close 50.
    for (field, value) in [
        ("high", "48"),   // below the low (and the open and close)
        ("high", "49.5"), // below the open
        ("low", "50.5"),  // above the close
        ("open", "52"),   // above the high
        ("open", "48"),   // below the low
        ("close", "52"),  // above the high
        ("close", "48"),  // below the low
    ] {
        let result = prepare_with(|v| {
            v["instruments"][0]["bars"][0][field] = json!(value);
        });
        assert_eq!(code_of(result), "INVALID_INPUT", "{field} {value}");
    }
}

#[test]
fn non_positive_and_oversized_prices_are_rejected() {
    for value in ["0", "-1", "1000000001"] {
        let result = prepare_with(|v| {
            let bar = &mut v["instruments"][0]["bars"][0];
            bar["open"] = json!(value);
            bar["high"] = json!(value);
            bar["low"] = json!(value);
            bar["close"] = json!(value);
        });
        assert_eq!(code_of(result), "INVALID_INPUT", "{value}");
    }
}

#[test]
fn prices_with_more_digits_than_the_price_scale_are_rejected() {
    let result = prepare_with(|v| {
        v["instruments"][0]["bars"][0]["open"] = json!("50.001");
    });
    assert_eq!(code_of(result), "INVALID_DECIMAL");
}

#[test]
fn a_negative_volume_is_rejected_and_a_fractional_volume_exceeds_the_quantity_scale() {
    let result = prepare_with(|v| {
        v["instruments"][0]["bars"][0]["volume"] = json!("-1");
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
    let result = prepare_with(|v| {
        v["instruments"][0]["bars"][0]["volume"] = json!("1000.5");
    });
    assert_eq!(code_of(result), "INVALID_DECIMAL");
}

#[test]
fn a_bar_available_before_its_event_time_is_rejected() {
    let result = prepare_with(|v| {
        v["instruments"][0]["bars"][0]["available_at"] = json!(format!("{}T20:59:59Z", date(0)));
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn windows_out_of_order_or_off_the_calendar_are_rejected() {
    // warmup_start after scored_start.
    let result = prepare_with(|v| {
        v["windows"]["warmup_start"] = json!(date(2));
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
    // scored_end before scored_start.
    let result = prepare_with(|v| {
        v["windows"]["scored_end"] = json!(date(0));
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
    // A window date that is not a session.
    for field in ["warmup_start", "scored_start", "scored_end"] {
        let result = prepare_with(|v| {
            v["windows"][field] = json!("2026-03-30");
        });
        assert_eq!(code_of(result), "INVALID_INPUT", "{field}");
    }
}

#[test]
fn bad_policy_values_are_rejected() {
    let cases: [(&str, Value, &str); 14] = [
        ("lot_size", json!("0"), "UNSUPPORTED_POLICY"),
        ("lot_size", json!("-1"), "UNSUPPORTED_POLICY"),
        ("lot_size", json!("0.5"), "INVALID_DECIMAL"), // finer than the quantity scale
        (
            "cost_model/fixed_fee_per_fill",
            json!("-1.00"),
            "UNSUPPORTED_POLICY",
        ),
        (
            "cost_model/fixed_fee_per_fill",
            json!("1.001"),
            "INVALID_DECIMAL",
        ),
        ("cost_model/fee_bps", json!("-1"), "UNSUPPORTED_POLICY"),
        ("cost_model/fee_bps", json!("10000"), "UNSUPPORTED_POLICY"),
        (
            "cost_model/gap_exit_slippage_bps",
            json!("10000"),
            "UNSUPPORTED_POLICY",
        ),
        (
            "corporate_actions/withholding_bps",
            json!("10001"),
            "UNSUPPORTED_POLICY",
        ),
        (
            "corporate_actions/withholding_bps",
            json!("-1"),
            "UNSUPPORTED_POLICY",
        ),
        ("money_scale", json!(1), "UNSUPPORTED_POLICY"), // below price + quantity scale
        ("price_scale", json!(9), "UNSUPPORTED_POLICY"),
        ("quantity_scale", json!(-1), "UNSUPPORTED_POLICY"),
        ("money_scale", json!(13), "UNSUPPORTED_POLICY"),
    ];
    for (path, value, code) in cases {
        let result = prepare_with(|v| {
            let mut node = &mut v["policy"];
            let parts: Vec<&str> = path.split('/').collect();
            for part in &parts[..parts.len() - 1] {
                node = &mut node[*part];
            }
            node[parts[parts.len() - 1]] = value.clone();
        });
        assert_eq!(code_of(result), code, "{path} = {value}");
    }
}

#[test]
fn a_withholding_of_exactly_one_hundred_percent_is_allowed() {
    assert!(
        prepare_with(|v| {
            v["policy"]["corporate_actions"]["withholding_bps"] = json!("10000");
        })
        .is_ok()
    );
}

#[test]
fn a_non_positive_or_oversized_capital_is_rejected() {
    for capital in ["0.00", "-5.00", "1000000000000001"] {
        let result = prepare_with(|v| {
            v["initial_capital"] = json!(capital);
        });
        assert_eq!(code_of(result), "INVALID_INPUT", "{capital}");
    }
    let result = prepare_with(|v| {
        v["initial_capital"] = json!("100.001");
    });
    assert_eq!(code_of(result), "INVALID_DECIMAL");
}

#[test]
fn an_input_bound_to_another_strategy_is_rejected() {
    let result = prepare_with(|v| {
        v["strategy_hash"] = json!(format!("sha256:{}", "0".repeat(64)));
    });
    assert_eq!(code_of(result), "IDENTITY_MISMATCH");
}

#[test]
fn duplicate_action_ids_are_rejected() {
    let scenario = base()
        .split("A1", 2, 2, 1)
        .dividend("A1", 3, "1.00", 3, "OPEN");
    assert_eq!(
        code_of(prepare_scenario_with(&scenario, |_| {})),
        "INVALID_INPUT"
    );
}

#[test]
fn a_negative_dividend_is_rejected() {
    let scenario = base().dividend("D1", 2, "-1.00", 3, "OPEN");
    assert_eq!(
        code_of(prepare_scenario_with(&scenario, |_| {})),
        "INVALID_INPUT"
    );
}

#[test]
fn a_dividend_may_pay_on_the_ex_date_or_later_but_not_earlier() {
    let on_ex_date = base().dividend("D1", 2, "1.00", 2, "BEFORE_OPEN");
    assert!(prepare_scenario_with(&on_ex_date, |_| {}).is_ok());
    let later = base().dividend("D1", 2, "1.00", 3, "AFTER_CLOSE");
    assert!(prepare_scenario_with(&later, |_| {}).is_ok());
    let earlier = base().dividend("D1", 3, "1.00", 2, "AFTER_CLOSE");
    assert_eq!(
        code_of(prepare_scenario_with(&earlier, |_| {})),
        "INVALID_INPUT"
    );
}

#[test]
fn a_payment_session_that_does_not_exist_is_rejected() {
    let scenario = base().dividend("D1", 2, "1.00", 3, "OPEN");
    let result = prepare_scenario_with(&scenario, |v| {
        v["instruments"][0]["corporate_actions"][0]["payment_session"] = json!("2026-03-30");
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn an_action_on_a_non_session_date_is_rejected() {
    let scenario = base().split("S1", 2, 2, 1);
    let result = prepare_scenario_with(&scenario, |v| {
        v["instruments"][0]["corporate_actions"][0]["effective_session"] = json!("2026-03-30");
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn an_action_with_an_impossible_availability_time_is_rejected() {
    let scenario = base().split("S1", 2, 2, 1);
    let result = prepare_scenario_with(&scenario, |v| {
        v["instruments"][0]["corporate_actions"][0]["available_at"] = json!("2026-03-03T24:00:00Z");
    });
    assert_eq!(code_of(result), "INVALID_INPUT");
}

#[test]
fn an_instrument_id_that_would_overflow_a_trade_id_is_rejected() {
    // T-<date>-<id> must fit the 64 characters of an identifier: 13 + 51 = 64.
    let mut scenario = base();
    scenario.instrument = "A".repeat(52);
    assert_eq!(
        code_of(prepare_scenario_with(&scenario, |_| {})),
        "INVALID_INPUT"
    );
    scenario.instrument = "A".repeat(51);
    assert!(prepare_scenario_with(&scenario, |_| {}).is_ok());
}

#[test]
fn the_longest_instrument_id_runs_a_complete_trade_without_an_identifier_failure() {
    let mut scenario = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
        quiet_bar("51", "70", "50", "60"),
    ]);
    scenario.instrument = "A".repeat(51);
    let out = scenario.evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(out.fills().len(), 2);
    assert_eq!(out.trades()[0]["trade_id"].as_str().unwrap().len(), 64);
}

#[test]
fn a_bar_on_a_confirmed_halt_session_is_contradictory_evidence() {
    // Dated evidence says S2 did not trade, yet a bar is supplied for it.
    let mut scenario = base().halt("HALT1", 2);
    scenario.bars[2] = Some(quiet_bar("50", "53", "49", "51"));
    assert_eq!(
        code_of(prepare_scenario_with(&scenario, |_| {})),
        "INVALID_INPUT"
    );
}

#[test]
fn a_bar_on_a_session_with_late_halt_evidence_is_accepted() {
    // The halt is only known at 15:00, after the open, so it does not confirm anything at the
    // open and the supplied bar stands.
    let known = format!("{}T15:00:00Z", date(2));
    let mut scenario = base().halt_known_at("HALT1", 2, &known);
    scenario.bars[2] = Some(quiet_bar("50", "53", "49", "51"));
    assert!(prepare_scenario_with(&scenario, |_| {}).is_ok());
}

#[test]
fn halt_events_must_be_on_the_calendar_and_unique() {
    let scenario = base().halt("HALT1", 2);
    let result = prepare_scenario_with(&scenario, |v| {
        v["instruments"][0]["unplanned_events"][0]["effective_session"] = json!("2026-03-30");
    });
    assert_eq!(code_of(result), "INVALID_INPUT");

    let scenario = base().halt("HALT1", 2).halt("HALT1", 3);
    assert_eq!(
        code_of(prepare_scenario_with(&scenario, |_| {})),
        "INVALID_INPUT"
    );
}

#[test]
fn a_missing_bar_is_not_a_preparation_error() {
    // Coverage is checked when the session is processed, so the journal keeps the earlier work
    // and the outcome names the event.
    assert!(prepare_scenario_with(&base().without_bar(2), |_| {}).is_ok());
}
