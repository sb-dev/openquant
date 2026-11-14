//! The contract registry: engine-scope schema pins, and one contract per schema file.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeSet;

use openquant_contracts::{
    AnyContract, Checkpoint, Contract, ContractError, ContractKind, Envelope, EvaluationInput,
    EvaluationResult, Payload, StrategyArtefact, digest_bytes, generated, validate,
};
use serde_json::{Value, json};

const SCHEMAS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../schemas");

/// Schema files that hold shared definitions only. No contract has them as its root.
const DEFINITIONS_ONLY: [&str; 2] = ["common", "connected-common"];

/// SHA-256 of each engine-scope schema file (OQ-05 section 7, OQ-02 section 7). These files
/// define what the engine reads and writes. Their version tags are part of engine identity.
const ENGINE_SCHEMA_PINS: [(&str, &str); 5] = [
    (
        "common",
        "sha256:2af2e47ba23c17c8e1defc821336dd23131d9f53d84f266e600ef4b7297b8a70",
    ),
    (
        "strategy-artefact",
        "sha256:7d94566184a1a0ad2bddd1fad2b5f6f0f1411a923fe11844c609deff36224c35",
    ),
    (
        "evaluation-input",
        "sha256:14f7068bf6f97473ca6a3b2e207b6d98259c0a68ec623fa652e4ecd0c377c9f0",
    ),
    (
        "evaluation-result",
        "sha256:490dadabe3775a63730f270553cb1851d7538ea1186c752a6e89bd0c27eef6ed",
    ),
    (
        "checkpoint",
        "sha256:0cebe7875354911277775947d736847f7df13974e9ff1316356bb01f4b8d0029",
    ),
];

fn read(name: &str) -> Vec<u8> {
    std::fs::read(format!("{SCHEMAS}/{name}.schema.json")).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn schema(name: &str) -> Value {
    serde_json::from_slice(&read(name)).unwrap()
}

fn schema_names() -> BTreeSet<String> {
    std::fs::read_dir(SCHEMAS)
        .unwrap()
        .filter_map(|item| {
            let file = item.unwrap().file_name().into_string().unwrap();
            file.strip_suffix(".schema.json").map(str::to_owned)
        })
        .collect()
}

#[test]
fn engine_scope_schema_files_keep_their_pinned_content() {
    let mut changed = Vec::new();
    for (name, pinned) in ENGINE_SCHEMA_PINS {
        let found = digest_bytes(&read(name));
        if found != pinned {
            changed.push(format!(
                "{name}.schema.json: pinned {pinned}, found {found}"
            ));
        }
    }
    assert!(
        changed.is_empty(),
        "an engine-scope schema changed: {changed:#?}\n\
         An engine-scope schema change needs a new version tag or an explicit A18 compatibility \
         decision (OQ-05 section 7, OQ-02 section 7). Record that decision before you update the pin."
    );
}

#[test]
fn the_pins_cover_exactly_the_engine_scope_schema_files() {
    let pinned: BTreeSet<&str> = ENGINE_SCHEMA_PINS.iter().map(|(name, _)| *name).collect();
    let engine: BTreeSet<&str> = Contract::ALL
        .into_iter()
        .map(ContractKind::name)
        .chain(["common"])
        .collect();
    assert_eq!(pinned, engine);
}

#[test]
fn every_contract_schema_file_has_exactly_one_contract() {
    let contracts: Vec<&str> = AnyContract::all().map(AnyContract::name).collect();
    let unique: BTreeSet<&str> = contracts.iter().copied().collect();
    assert_eq!(unique.len(), contracts.len(), "a contract is listed twice");
    let expected: BTreeSet<String> = schema_names()
        .into_iter()
        .filter(|name| !DEFINITIONS_ONLY.contains(&name.as_str()))
        .collect();
    let listed: BTreeSet<String> = unique.iter().map(|name| (*name).to_owned()).collect();
    assert_eq!(listed, expected);
    assert_eq!(Contract::ALL.len() + Envelope::ALL.len(), contracts.len());
}

/// Every `schema_version` enum value in a root and in the forms of a root `oneOf`.
fn root_version_tags(schema: &Value) -> BTreeSet<String> {
    let mut objects = vec![schema.clone()];
    for form in schema["oneOf"].as_array().into_iter().flatten() {
        let reference = form["$ref"].as_str().unwrap();
        let name = reference.strip_prefix("#/$defs/").unwrap();
        objects.push(schema["$defs"][name].clone());
    }
    objects
        .iter()
        .filter_map(|object| object["properties"]["schema_version"]["enum"].as_array())
        .flatten()
        .map(|tag| tag.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn each_contract_names_its_schema_id_and_the_version_tag_of_its_schema() {
    for contract in AnyContract::all() {
        let (id, tag) = match contract {
            AnyContract::Engine(c) => (ContractKind::schema_id(c), ContractKind::version_tag(c)),
            AnyContract::Envelope(e) => (ContractKind::schema_id(e), ContractKind::version_tag(e)),
        };
        let root = schema(contract.name());
        assert_eq!(root["$id"], id, "{contract:?}");
        assert_eq!(id, format!("urn:openquant:schema:{}:1", contract.name()));
        let tags = root_version_tags(&root);
        assert_eq!(
            tags,
            BTreeSet::from([tag.to_owned()]),
            "{contract:?}: every form carries the one version tag"
        );
    }
}

#[test]
fn the_engine_contract_set_is_unchanged() {
    let tags: Vec<&str> = Contract::ALL.iter().map(|c| c.version_tag()).collect();
    assert_eq!(
        tags,
        [
            "strategy-artefact/1",
            "evaluation-input/1",
            "evaluation-result/1",
            "checkpoint/1"
        ]
    );
    for contract in Contract::ALL {
        assert_eq!(ContractKind::schema_id(contract), contract.schema_id());
        assert_eq!(ContractKind::version_tag(contract), contract.version_tag());
    }
    assert_eq!(StrategyArtefact::CONTRACT, Contract::StrategyArtefact);
    assert_eq!(EvaluationInput::CONTRACT, Contract::EvaluationInput);
    assert_eq!(EvaluationResult::CONTRACT, Contract::EvaluationResult);
    assert_eq!(Checkpoint::CONTRACT, Contract::Checkpoint);
    assert_eq!(generated::JobDispatch::CONTRACT, Envelope::JobDispatch);
}

#[test]
fn names_resolve_to_one_contract_and_unknown_names_to_none() {
    assert_eq!(
        AnyContract::from_name("checkpoint"),
        Some(AnyContract::Engine(Contract::Checkpoint))
    );
    assert_eq!(
        AnyContract::from_name("evaluation-request"),
        Some(AnyContract::Envelope(Envelope::EvaluationRequest))
    );
    for unknown in [
        "",
        "common",
        "connected-common",
        "checkpoint/1",
        "Checkpoint",
    ] {
        assert_eq!(AnyContract::from_name(unknown), None, "{unknown:?}");
    }
}

#[test]
fn an_envelope_checks_its_version_tag_before_its_schema() {
    let tagged = |tag: &str| json!({"schema_version": tag});
    for envelope in Envelope::ALL {
        let error = validate(envelope, &tagged("checkpoint/1")).unwrap_err();
        assert!(
            matches!(&error, ContractError::UnsupportedVersion { expected, .. } if expected == envelope.version_tag()),
            "{envelope:?}: {error:?}"
        );
        // The right tag on an empty body reaches the schema.
        let error = validate(envelope, &tagged(envelope.version_tag())).unwrap_err();
        assert!(
            matches!(error, ContractError::Schema(_)),
            "{envelope:?}: {error:?}"
        );
    }
    // An engine contract never accepts an envelope tag.
    let error = validate(Contract::Checkpoint, &tagged("job-dispatch/1")).unwrap_err();
    assert!(matches!(error, ContractError::UnsupportedVersion { .. }));
    assert!(matches!(
        validate(Envelope::ApiError, &json!({})).unwrap_err(),
        ContractError::MissingVersion
    ));
}
