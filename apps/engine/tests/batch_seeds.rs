//! The four S0 seeds through the batch path.
//!
//! Every S0 case that runs one of the four seed strategies is queued as a REPLAY evaluate job,
//! claimed, evaluated by the worker and submitted. The result that the worker uploaded must be the
//! byte-for-byte result that the S0 harness produces for the same case (so its digest equals the
//! S0 result digest), and the outcome that the submission states must be the one the S0 harness
//! reports. The S0 harness compares its result with the independently derived expectation of the
//! case (`expected.json`, an exact-rational oracle), so the batch path inherits that check.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;

use std::{collections::BTreeSet, fs};

use batch_support::{Harness, data::*, worker_handled};
use openquant_contracts::{
    canonical::digest_bytes,
    generated::{EvaluationMetrics, EvaluationResult},
    parse,
};
use openquant_engine::{batch::worker::Handled, case::load_case, replay::run_case};
use serde_json::Value;

/// The ids of the S0 cases that run one of the four seeds, with the seed number.
fn seed_cases() -> Vec<(String, usize)> {
    let root = repo().join("fixtures/s0/cases");
    let mut found = Vec::new();
    for entry in fs::read_dir(&root).unwrap() {
        let dir = entry.unwrap().path();
        let file = read_json(&dir.join("case.json"));
        let strategy = file["strategy"].as_str().unwrap();
        for number in 1..=4 {
            let marker = format!("strategies/seed-{number}-");
            if strategy.contains(&marker) {
                found.push((file["id"].as_str().unwrap().to_owned(), number));
            }
        }
    }
    found.sort();
    found
}

#[test]
fn the_cases_of_all_four_seeds_exist() {
    let cases = seed_cases();
    let seeds: BTreeSet<usize> = cases.iter().map(|(_, n)| *n).collect();
    assert_eq!(seeds, BTreeSet::from([1, 2, 3, 4]));
    assert!(cases.len() >= 16, "{cases:?}");
}

#[test]
fn every_seed_case_gives_the_s0_result_through_the_batch_path() {
    let cases = seed_cases();
    let mut completed = 0;
    let mut by_seed: BTreeSet<usize> = BTreeSet::new();
    for (id, number) in &cases {
        let harness = Harness::new();
        let case = s0_case(id);
        let job = harness.enqueue_replay(&case, &id.to_lowercase());
        let handled = worker_handled(&harness.poll(), &job.message);
        let Handled::Completed { acked: true, .. } = handled else {
            panic!("{id}: {handled:?}\n{}", harness.log_text());
        };

        // The S0 harness: its result bytes and its verdict against the independent expectation.
        let s0 = run_case(&load_case(&repo().join("fixtures/s0/cases").join(id)).unwrap());
        assert!(s0.passed, "{id}: the S0 harness does not pass the case");
        let expected_text = s0.result_text.clone().expect("a result exists");
        let expected_digest = digest_bytes(expected_text.as_bytes());

        let world = harness.world();
        let accepted = world.accepted_on("attempts.evaluation-submission");
        assert_eq!(accepted.len(), 1, "{id}: one official result");
        let submission = &accepted[0].body;
        assert_eq!(submission["mode"], "REPLAY", "{id}");
        assert_eq!(submission["engine_digest"], ENGINE_DIGEST, "{id}");
        assert_eq!(submission["method"]["digest"], METHOD_DIGEST, "{id}");
        assert_eq!(submission["executable"]["name"], "engine-batch", "{id}");
        let evaluation = &submission["evaluation"];
        let status = s0.outcome["status"].as_str().unwrap();
        assert_eq!(evaluation["status"], status, "{id}");

        let result_ref = &evaluation["result"];
        assert_eq!(
            result_ref["digest"],
            expected_digest.as_str(),
            "{id}: the result digest"
        );
        let uploaded = world
            .artefacts
            .get(result_ref["digest"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            uploaded.as_slice(),
            expected_text.as_bytes(),
            "{id}: the result bytes"
        );
        assert_eq!(result_ref["size_bytes"], expected_text.len(), "{id}");

        // The uploaded result is a valid evaluation-result/1 and binds to the case's input.
        let result: EvaluationResult = parse(std::str::from_utf8(uploaded).unwrap()).unwrap();
        assert_eq!(
            result.input_hash.as_str(),
            s0.input_hash.as_deref().unwrap(),
            "{id}"
        );
        assert_eq!(
            result.strategy_hash.as_str(),
            s0.strategy_hash.as_deref().unwrap(),
            "{id}"
        );
        assert_eq!(
            evaluation["input"]["digest"],
            s0.input_hash.as_deref().unwrap(),
            "{id}"
        );

        if status == "COMPLETED" {
            completed += 1;
            by_seed.insert(*number);
            let metrics_bytes = world
                .artefacts
                .get(evaluation["metrics"]["digest"].as_str().unwrap())
                .unwrap();
            let metrics: EvaluationMetrics =
                parse(std::str::from_utf8(metrics_bytes).unwrap()).unwrap();
            let value: Value = serde_json::to_value(&metrics).unwrap();
            assert_eq!(
                value["source"]["result_digest"],
                expected_digest.as_str(),
                "{id}"
            );
            assert_eq!(value["method"]["digest"], METHOD_DIGEST, "{id}");
            assert_eq!(
                value["run_id"],
                format!("run-s0-{}", id.to_lowercase()),
                "{id}"
            );
        } else {
            assert!(
                evaluation.get("metrics").is_none(),
                "{id}: no metrics without a completed run"
            );
        }
    }
    assert_eq!(
        by_seed,
        BTreeSet::from([1, 2, 3, 4]),
        "every seed has a completed case"
    );
    assert!(completed >= 8, "{completed} completed cases");
}
