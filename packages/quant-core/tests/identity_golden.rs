//! Golden identities (A18): the operator-set digest, the engine identity and the strategy hash.
//!
//! Engine changes must invalidate affected evidence or carry an explicit compatibility decision.
//! These tests make a change to evaluated semantics visible: if one fails, the change is either a
//! mistake or a decision. For a decision, update the golden value together with the compatibility
//! note, and explain the changed numbers in the change description.
//!
//! The golden digests below were computed outside the engine with Python's `hashlib` over the
//! literal text written here (see the derivation notes beside each constant).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod operators_support;

use openquant_contracts::{
    Contract, StrategyArtefact, canonical_json, digest_bytes, parse, payload_digest, to_value,
};
use openquant_core::{
    identity::{ENGINE_NAME, engine_digest, engine_identity, operator_set_digest},
    operators::catalogue::catalogue_text,
    validate_strategy,
};
use operators_support::*;
use serde_json::{Value, json};

/// The catalogue text, transcribed by hand from the reviewed operator semantics. Each line is
/// `name@version args=min..max scopes=[...] semantics`.
const EXPECTED_TEXT: &str = "daily-long-only-seed@1\n\
const@1 args=0..0 scopes=[Signal, Level, Trigger] decimal constant with declared unit; warm-up 0\n\
bar_field@1 args=0..0 scopes=[Signal, Trigger] OHLCV of the current completed bar; signal scope reads the split-adjusted causal series, trigger scope the raw bar; price units, volume shares; warm-up 0; absent bar is missing\n\
ref@1 args=0..0 scopes=[Signal] named indicator defined earlier in the list; unit and warm-up of the target\n\
lag@1 args=1..1 scopes=[Signal] value periods sessions earlier, 1..=60; missing when history is shorter\n\
sma@1 args=1..1 scopes=[Signal] simple mean over window values including the current bar, 1..=252; missing unless the full window exists\n\
rsi_simple@1 args=1..1 scopes=[Signal] price input, points output; 100*sum_gain/(sum_gain+sum_loss) over window close changes, which equals 100-100/(1+mean_gain/mean_loss); needs window+1 values; both sums zero is missing(UNDEFINED_FLAT); no Wilder smoothing\n\
atr_simple@1 args=0..0 scopes=[Signal] price output; simple mean over window of max(high-low,abs(high-previous_close),abs(low-previous_close)); needs window+1 bars\n\
add@1 args=2..2 scopes=[Signal, Level, Trigger] sum of equal units\n\
sub@1 args=2..2 scopes=[Signal, Level, Trigger] difference of equal units\n\
mul@1 args=2..2 scopes=[Signal, Level, Trigger] product where one factor is a ratio; result takes the other unit\n\
div@1 args=2..2 scopes=[Signal, Level, Trigger] equal units give a ratio; a ratio divisor keeps the dividend unit; zero divisor is missing(DIV_BY_ZERO)\n\
gt@1 args=2..2 scopes=[Signal, Level, Trigger] strictly greater, equal numeric units, flag output\n\
gte@1 args=2..2 scopes=[Signal, Level, Trigger] greater or equal, equal numeric units, flag output\n\
lt@1 args=2..2 scopes=[Signal, Level, Trigger] strictly less, equal numeric units, flag output\n\
lte@1 args=2..2 scopes=[Signal, Level, Trigger] less or equal, equal numeric units, flag output\n\
and@1 args=2..8 scopes=[Signal, Level, Trigger] all flags true; any missing input makes the result missing\n\
or@1 args=2..8 scopes=[Signal, Level, Trigger] any flag true; any missing input makes the result missing\n\
entry_price@1 args=0..0 scopes=[Level, Trigger] actual simulated fill price of the position, on the position's share basis\n\
snapshot@1 args=0..0 scopes=[Level, Trigger] value snapshotted at the signal session, converted for intervening splits\n";

/// SHA-256 of `EXPECTED_TEXT`, computed with Python `hashlib.sha256(text.encode()).hexdigest()`.
const OPERATOR_SET_DIGEST: &str =
    "sha256:fe143b1792a0374f8fa3209063b88e100f01daa700d78bdf81bb9189078d16c0";

/// Canonical JSON of the engine identity: sorted keys, no whitespace.
const ENGINE_JSON: &str = concat!(
    r#"{"name":"openquant-core","operator_set_digest":""#,
    "sha256:fe143b1792a0374f8fa3209063b88e100f01daa700d78bdf81bb9189078d16c0",
    r#"","schema_versions":["strategy-artefact/1","evaluation-input/1","evaluation-result/1","checkpoint/1"],"version":"0.0.0"}"#
);

/// SHA-256 of `ENGINE_JSON`, computed with Python.
const ENGINE_DIGEST: &str =
    "sha256:7ceafb5e32e05c234b2a4cd2915946d4c6273ea9455d7b4f98821712555bb36a";

/// SHA-256 of each seed artefact's canonical JSON (Python: `json.dumps(obj, sort_keys=True,
/// separators=(",", ":"), ensure_ascii=False)`), in `SEEDS` order.
const SEED_HASHES: [&str; 5] = [
    "sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78",
    "sha256:ab5f48cdc451feb20a105cfc26fe8f969bb7f1f2c4d2ed7dfdf8390aeb106889",
    "sha256:2e917d22052a0a33251dfe88029788e590f08f4c1d3901b5b956cb4c51fc88e9",
    "sha256:e0ee4fbc776eca23c172dfdcdf6975f56d52c509f232248b9813b552cf60884f",
    "sha256:2f2741c1b58253034b7fe57d8b08dc63e5037c781a35898a59a4a27ae36d4d2b",
];

// ---------------------------------------------------------------------------------------------
// Operator set and engine identity (A18)
// ---------------------------------------------------------------------------------------------

#[test]
fn the_catalogue_text_is_the_reviewed_text() {
    assert_eq!(
        catalogue_text(),
        EXPECTED_TEXT,
        "operator semantics changed: this changes the operator-set digest and the engine \
         identity (A18). Review the change, record the compatibility decision, then update \
         EXPECTED_TEXT and the golden digests together."
    );
}

#[test]
fn the_operator_set_digest_is_pinned() {
    assert_eq!(digest_bytes(EXPECTED_TEXT.as_bytes()), OPERATOR_SET_DIGEST);
    assert_eq!(
        operator_set_digest(),
        OPERATOR_SET_DIGEST,
        "the operator-set digest changed (A18): make it a conscious compatibility decision"
    );
}

#[test]
fn the_engine_identity_has_a_fixed_shape() {
    let identity = engine_identity().unwrap();
    let value = serde_json::to_value(&identity).unwrap();
    // Exactly four fields, nothing environmental (no timestamps, paths, hostnames, revisions).
    let object = value.as_object().unwrap();
    let mut keys: Vec<_> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["name", "operator_set_digest", "schema_versions", "version"]
    );
    assert_eq!(value["name"], json!(ENGINE_NAME));
    assert_eq!(value["name"], json!("openquant-core"));
    assert_eq!(value["version"], json!(env!("CARGO_PKG_VERSION")));
    assert_eq!(value["operator_set_digest"], json!(OPERATOR_SET_DIGEST));
    // The wire contract versions the engine supports, in contract order.
    assert_eq!(
        value["schema_versions"],
        json!([
            "strategy-artefact/1",
            "evaluation-input/1",
            "evaluation-result/1",
            "checkpoint/1"
        ])
    );
    let tags: Vec<_> = Contract::ALL.iter().map(|c| c.version_tag()).collect();
    assert_eq!(
        tags,
        [
            "strategy-artefact/1",
            "evaluation-input/1",
            "evaluation-result/1",
            "checkpoint/1"
        ]
    );
}

#[test]
fn the_engine_digest_is_pinned() {
    let identity = engine_identity().unwrap();
    let canonical = canonical_json(&serde_json::to_value(&identity).unwrap()).unwrap();
    assert_eq!(canonical, ENGINE_JSON);
    assert_eq!(digest_bytes(ENGINE_JSON.as_bytes()), ENGINE_DIGEST);
    assert_eq!(
        engine_digest(&identity).unwrap(),
        ENGINE_DIGEST,
        "the engine identity changed (A18): evidence produced by the previous engine is \
         affected. Record a compatibility decision before updating the golden value."
    );
}

#[test]
fn identities_are_deterministic() {
    assert_eq!(operator_set_digest(), operator_set_digest());
    let a = engine_digest(&engine_identity().unwrap()).unwrap();
    let b = engine_digest(&engine_identity().unwrap()).unwrap();
    assert_eq!(a, b);
}

// ---------------------------------------------------------------------------------------------
// Strategy hash
// ---------------------------------------------------------------------------------------------

#[test]
fn seed_hashes_match_an_independent_computation() {
    for (name, golden) in SEEDS.iter().zip(SEED_HASHES) {
        let artefact = seed(name);
        assert_eq!(payload_digest(&artefact).unwrap(), golden, "{name}");
        assert_eq!(validate_strategy(&artefact).unwrap().hash, golden, "{name}");
    }
}

/// Re-serialise a JSON value with keys in reverse order and unusual whitespace.
fn scramble(value: &Value, depth: usize, out: &mut String) {
    let gap = ["", " ", "\n", "\t", "\r\n  "][depth % 5];
    match value {
        Value::Object(map) => {
            out.push('{');
            out.push_str(gap);
            let mut first = true;
            for (key, child) in map.iter().rev() {
                if !first {
                    out.push(',');
                    out.push_str(gap);
                }
                first = false;
                out.push_str(&serde_json::to_string(key).unwrap());
                out.push_str(gap);
                out.push(':');
                out.push_str(gap);
                scramble(child, depth + 1, out);
            }
            out.push_str(gap);
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            out.push_str(gap);
            for (index, child) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                    out.push_str(gap);
                }
                scramble(child, depth + 1, out);
            }
            out.push_str(gap);
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap()),
    }
}

#[test]
fn the_hash_ignores_key_order_and_whitespace() {
    for (name, golden) in SEEDS.iter().zip(SEED_HASHES) {
        let value = seed_json(name);
        let pretty = serde_json::to_string_pretty(&value).unwrap();
        let compact = serde_json::to_string(&value).unwrap();
        let mut scrambled = String::new();
        scramble(&value, 0, &mut scrambled);
        assert_ne!(
            scrambled, compact,
            "the scrambled text must differ from the compact text"
        );
        let crlf = pretty.replace('\n', "\r\n");
        for (form, text) in [
            ("original", seed_text(name)),
            ("pretty", pretty),
            ("compact", compact),
            ("scrambled", scrambled),
            ("crlf", crlf),
        ] {
            let artefact: StrategyArtefact =
                parse(&text).unwrap_or_else(|e| panic!("{name} {form}: {e}"));
            assert_eq!(payload_digest(&artefact).unwrap(), golden, "{name} {form}");
            assert_eq!(
                validate_strategy(&artefact).unwrap().hash,
                golden,
                "{name} {form}"
            );
        }
        // Whitespace around the document is harmless too.
        let spaced = format!("\n\t {} \r\n", serde_json::to_string(&value).unwrap());
        let artefact: StrategyArtefact = parse(&spaced).unwrap();
        assert_eq!(payload_digest(&artefact).unwrap(), golden);
    }
}

#[test]
fn the_hash_covers_the_contract_and_every_part_of_the_definition() {
    let base = seed_json(SEEDS[0]);
    let hash_of = |value: &Value| -> String {
        let artefact: StrategyArtefact = serde_json::from_value(value.clone()).unwrap();
        payload_digest(&artefact).unwrap()
    };
    let golden = hash_of(&base);
    let mut changed: Vec<(&str, Value)> = Vec::new();
    let mut edit = |name: &'static str, apply: &dyn Fn(&mut Value)| {
        let mut value = base.clone();
        apply(&mut value);
        changed.push((name, value));
    };
    edit("hypothesis", &|v| {
        v["contract"]["hypothesis"] = json!("Another hypothesis.")
    });
    edit("assumption added", &|v| {
        v["contract"]["assumptions"]
            .as_array_mut()
            .unwrap()
            .push(json!("One more."));
    });
    edit("strategy id", &|v| v["strategy_id"] = json!("other-seed"));
    edit("version", &|v| v["version"] = json!(2));
    edit("slots", &|v| {
        v["definition"]["selection"]["slots"] = json!(4)
    });
    edit("threshold constant", &|v| {
        v["definition"]["indicators"][5]["expr"]["params"]["value"] = json!("31");
    });
    edit("window", &|v| {
        v["definition"]["indicators"][0]["expr"]["params"]["window"] = json!(51);
    });
    edit("indicator name", &|v| {
        v["definition"]["indicators"][0]["name"] = json!("sma51")
    });
    edit("indicator order", &|v| {
        v["definition"]["indicators"]
            .as_array_mut()
            .unwrap()
            .swap(0, 1);
    });
    edit("operator", &|v| {
        v["definition"]["entry"]["condition"]["args"][0]["op"] = json!("operator:gte@1");
    });
    edit("rank", &|v| {
        v["definition"]["entry"]["rank"]["args"][0]["args"][0]["params"]["value"] = json!("51");
    });
    edit("stop multiple", &|v| {
        v["definition"]["exits"]["stop"]["args"][1]["args"][0]["params"]["value"] = json!("3");
    });
    edit("break-even rule", &|v| {
        v["definition"]["exits"]["stop_adjustments"] =
            seed_json(SEEDS[2])["definition"]["exits"]["stop_adjustments"].clone();
    });
    edit("parent", &|v| {
        v["parent"] = json!({"hash": SEED_HASHES[0], "changes": []});
    });
    for (name, value) in &changed {
        assert_ne!(
            hash_of(value),
            golden,
            "changing the {name} must change the hash"
        );
    }
    // ... and every edit gives a distinct hash.
    let mut hashes: Vec<_> = changed.iter().map(|(_, v)| hash_of(v)).collect();
    hashes.sort();
    hashes.dedup();
    assert_eq!(hashes.len(), changed.len());
}

#[test]
fn canonical_json_sorts_keys_and_drops_whitespace() {
    let value = json!({"b": [1, {"z": null, "a": true}], "a": "x\"y\u{1}"});
    assert_eq!(
        canonical_json(&value).unwrap(),
        r#"{"a":"x\"y\u0001","b":[1,{"a":true,"z":null}]}"#
    );
    // The digest of the canonical text is what a strategy hash is.
    let artefact = seed(SEEDS[0]);
    let text = canonical_json(&to_value(&artefact).unwrap()).unwrap();
    assert_eq!(digest_bytes(text.as_bytes()), SEED_HASHES[0]);
}
