//! The enablement gate (OQ-05 section 5): provider retrieval is off unless configuration turns it on
//! and every fact of the provider evidence is verified.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::cell::RefCell;

use openquant_engine::market::{
    gate::{
        BlockReason, Blocked, ENABLE_VARIABLE, Fact, ProviderEvidence, RetrievalSwitch, decide,
    },
    session::SessionProbe,
};

type Setter = fn(&mut ProviderEvidence, Fact);

fn verified() -> ProviderEvidence {
    ProviderEvidence {
        paper_authority: Fact::Verified,
        no_live_authority: Fact::Verified,
        data_entitlement: Fact::Verified,
        session_semantics: Fact::Verified,
        egress_refusals: Fact::Verified,
        declaration_field: Fact::Verified,
    }
}

fn blocked(switch: RetrievalSwitch, evidence: &ProviderEvidence) -> Blocked {
    decide(switch, evidence).expect_err("the gate must block")
}

fn facts(blocked: &Blocked) -> Vec<&'static str> {
    blocked
        .reasons()
        .iter()
        .map(|reason| match reason {
            BlockReason::Disabled => "switch",
            BlockReason::NotVerified { fact, .. } => fact,
        })
        .collect()
}

#[test]
fn retrieval_is_off_by_default() {
    assert_eq!(RetrievalSwitch::default(), RetrievalSwitch::Off);
    let from_nothing = RetrievalSwitch::from_config(&|_| None);
    assert_eq!(from_nothing, RetrievalSwitch::Off);
    // With nothing configured and nothing probed, the gate names every reason.
    let reasons = blocked(from_nothing, &ProviderEvidence::default());
    assert_eq!(reasons.reasons().len(), 7);
    assert_eq!(reasons.reasons()[0], BlockReason::Disabled);
}

#[test]
fn only_the_exact_value_enabled_turns_retrieval_on() {
    let asked = RefCell::new(Vec::new());
    let on = RetrievalSwitch::from_config(&|name| {
        asked.borrow_mut().push(name.to_owned());
        Some("enabled".to_owned())
    });
    assert_eq!(on, RetrievalSwitch::On);
    assert_eq!(*asked.borrow(), vec![ENABLE_VARIABLE.to_owned()]);
    assert_eq!(ENABLE_VARIABLE, "OPENQUANT_MARKET_RETRIEVAL");
    for value in [
        "",
        "true",
        "TRUE",
        "1",
        "yes",
        "on",
        "ENABLED",
        "Enabled",
        " enabled",
        "enabled ",
        "enabled\n",
        "enable",
        "enabled,",
        "0",
        "false",
        "disabled",
    ] {
        let switch = RetrievalSwitch::from_config(&|_| Some(value.to_owned()));
        assert_eq!(switch, RetrievalSwitch::Off, "{value:?}");
    }
}

#[test]
fn a_switch_that_is_on_is_not_enough() {
    let reasons = blocked(RetrievalSwitch::On, &ProviderEvidence::default());
    assert_eq!(reasons.reasons().len(), 6);
    assert!(!reasons.reasons().contains(&BlockReason::Disabled));
}

#[test]
fn verified_evidence_is_not_enough_without_the_switch() {
    let reasons = blocked(RetrievalSwitch::Off, &verified());
    assert_eq!(reasons.reasons(), [BlockReason::Disabled]);
    assert!(reasons.to_string().contains("OPENQUANT_MARKET_RETRIEVAL"));
}

#[test]
fn every_fact_alone_can_block_and_is_named() {
    let setters: [(&str, Setter); 6] = [
        ("paper account authority", |e, f| e.paper_authority = f),
        ("absence of live order authority", |e, f| {
            e.no_live_authority = f
        }),
        ("data entitlement of the profile feed", |e, f| {
            e.data_entitlement = f
        }),
        ("session semantics of the daily bars", |e, f| {
            e.session_semantics = f
        }),
        (
            "egress refusals (host outside the allowlist, cross-host redirect)",
            |e, f| e.egress_refusals = f,
        ),
        (
            "declaration-date field in a real corporate-actions response",
            |e, f| e.declaration_field = f,
        ),
    ];
    for (name, set) in setters {
        for fact in [Fact::Unverified, Fact::Failed("probe said no".to_owned())] {
            let mut evidence = verified();
            set(&mut evidence, fact.clone());
            let reasons = blocked(RetrievalSwitch::On, &evidence);
            assert_eq!(facts(&reasons), vec![name], "{name}");
            let expected_detail = match fact {
                Fact::Failed(detail) => Some(detail),
                _ => None,
            };
            assert_eq!(
                reasons.reasons()[0],
                BlockReason::NotVerified {
                    fact: name,
                    detail: expected_detail
                }
            );
        }
    }
}

#[test]
fn a_credential_with_live_order_authority_blocks_retrieval() {
    let mut evidence = verified();
    evidence.no_live_authority = Fact::Failed("the live trading host accepted the key".to_owned());
    let reasons = blocked(RetrievalSwitch::On, &evidence);
    let text = reasons.to_string();
    assert!(text.contains("absence of live order authority failed"));
    assert!(text.contains("accepted the key"));
}

#[test]
fn every_reason_is_listed_in_a_fixed_order() {
    let reasons = blocked(RetrievalSwitch::Off, &ProviderEvidence::default());
    assert_eq!(
        facts(&reasons),
        vec![
            "switch",
            "paper account authority",
            "absence of live order authority",
            "data entitlement of the profile feed",
            "session semantics of the daily bars",
            "egress refusals (host outside the allowlist, cross-host redirect)",
            "declaration-date field in a real corporate-actions response",
        ]
    );
    let text = reasons.to_string();
    assert!(text.starts_with("provider retrieval is blocked: "));
    assert_eq!(text.matches("; ").count(), 6);
}

#[test]
fn an_enabled_switch_and_verified_evidence_give_a_permit() {
    assert!(decide(RetrievalSwitch::On, &verified()).is_ok());
}

#[test]
fn a_session_probe_result_feeds_the_gate() {
    // Only an exact match of daily and regular-hours minute bars verifies the session semantics.
    assert_eq!(SessionProbe::Matches.into_fact(), Fact::Verified);
    assert_eq!(SessionProbe::NoMinutes.into_fact(), Fact::Unverified);
    let differs = SessionProbe::Differs(vec![]).into_fact();
    assert!(matches!(differs, Fact::Failed(_)));
}
