//! The enablement gate: provider retrieval stays off unless configuration turns it on and the
//! evidence says it is safe (OQ-05 section 5).
//!
//! Two things must hold. The configuration switch must be exactly `enabled`, and every fact of the
//! provider evidence must be verified: the credential is a paper-account key that the paper host
//! accepts, the live trading host rejects it (a live-account key is prohibited even for data
//! calls), the profile's feed is entitled, the session semantics were recorded from a real
//! comparison of daily and regular-hours minute bars, the egress allowlist refused both a host
//! outside it and a cross-host redirect, and the declaration-date field of the availability rule
//! appears in a real response. Anything unverified keeps retrieval blocked and says why.
//!
//! The gate does no I/O. The bounded probes of the delivery step produce the evidence. Without a
//! [`RetrievalPermit`] a retrieval cannot start: the permit has no public constructor.

use std::fmt;

/// The configuration variable that turns provider retrieval on. Only the exact value `enabled`
/// does. Absent, empty, `true`, `1`, `ENABLED` or any other text leaves it off.
pub const ENABLE_VARIABLE: &str = "OPENQUANT_MARKET_RETRIEVAL";

/// The only value that enables retrieval.
pub const ENABLED_VALUE: &str = "enabled";

/// The configuration switch. The default is off.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RetrievalSwitch {
    #[default]
    Off,
    On,
}

impl RetrievalSwitch {
    /// Read the switch through `lookup`, which returns the value of a configuration variable. The
    /// caller decides where configuration lives; the gate never reads the environment.
    #[must_use]
    pub fn from_config(lookup: &dyn Fn(&str) -> Option<String>) -> Self {
        match lookup(ENABLE_VARIABLE) {
            Some(value) if value == ENABLED_VALUE => Self::On,
            _ => Self::Off,
        }
    }
}

/// What a probe established about one fact.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Fact {
    /// Established by a recorded probe.
    Verified,
    /// The probe ran and the fact does not hold.
    Failed(String),
    /// No probe has established it.
    #[default]
    Unverified,
}

/// The six facts that provider retrieval depends on. Every one starts unverified.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProviderEvidence {
    /// The paper host accepted the credential and reported a paper account.
    pub paper_authority: Fact,
    /// The live trading host rejected the credential: it carries no live order authority.
    pub no_live_authority: Fact,
    /// The data entitlement of the profile's feed (SIP) was probed, with no fallback.
    pub data_entitlement: Fact,
    /// The session semantics were recorded by comparing daily and regular-hours minute bars.
    pub session_semantics: Fact,
    /// The egress allowlist refused a host outside it and a cross-host redirect.
    pub egress_refusals: Fact,
    /// The profile's declaration-date field appears in a real corporate-actions response.
    pub declaration_field: Fact,
}

/// A reason retrieval is blocked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockReason {
    /// The configuration switch is not `enabled`.
    Disabled,
    /// The named fact is not verified.
    NotVerified {
        fact: &'static str,
        detail: Option<String>,
    },
}

impl fmt::Display for BlockReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Disabled => write!(
                f,
                "provider retrieval is not enabled ({ENABLE_VARIABLE} is not `{ENABLED_VALUE}`)"
            ),
            Self::NotVerified { fact, detail: None } => write!(f, "{fact} is not verified"),
            Self::NotVerified {
                fact,
                detail: Some(detail),
            } => write!(f, "{fact} failed: {detail}"),
        }
    }
}

/// Every reason retrieval is blocked, in a fixed order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blocked {
    reasons: Vec<BlockReason>,
}

impl Blocked {
    /// The reasons, the switch first, then the facts in the order of [`ProviderEvidence`].
    #[must_use]
    pub fn reasons(&self) -> &[BlockReason] {
        &self.reasons
    }
}

impl fmt::Display for Blocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("provider retrieval is blocked: ")?;
        for (index, reason) in self.reasons.iter().enumerate() {
            if index > 0 {
                f.write_str("; ")?;
            }
            write!(f, "{reason}")?;
        }
        Ok(())
    }
}

impl std::error::Error for Blocked {}

/// Proof that the gate said yes. Only [`decide`] makes one.
///
/// Its field is private, so no other code can build a permit:
///
/// ```compile_fail
/// use openquant_engine::market::gate::RetrievalPermit;
/// let _permit = RetrievalPermit { _private: () };
/// ```
#[derive(Debug)]
#[must_use = "a permit is the only way to start a retrieval"]
pub struct RetrievalPermit {
    _private: (),
}

/// Decide whether provider retrieval may run.
///
/// # Errors
/// [`Blocked`] with every reason, when the switch is off or any fact is not verified.
pub fn decide(
    switch: RetrievalSwitch,
    evidence: &ProviderEvidence,
) -> Result<RetrievalPermit, Blocked> {
    let mut reasons = Vec::new();
    if switch != RetrievalSwitch::On {
        reasons.push(BlockReason::Disabled);
    }
    let facts: [(&'static str, &Fact); 6] = [
        ("paper account authority", &evidence.paper_authority),
        (
            "absence of live order authority",
            &evidence.no_live_authority,
        ),
        (
            "data entitlement of the profile feed",
            &evidence.data_entitlement,
        ),
        (
            "session semantics of the daily bars",
            &evidence.session_semantics,
        ),
        (
            "egress refusals (host outside the allowlist, cross-host redirect)",
            &evidence.egress_refusals,
        ),
        (
            "declaration-date field in a real corporate-actions response",
            &evidence.declaration_field,
        ),
    ];
    for (fact, state) in facts {
        match state {
            Fact::Verified => {}
            Fact::Failed(detail) => reasons.push(BlockReason::NotVerified {
                fact,
                detail: Some(detail.clone()),
            }),
            Fact::Unverified => reasons.push(BlockReason::NotVerified { fact, detail: None }),
        }
    }
    if reasons.is_empty() {
        Ok(RetrievalPermit { _private: () })
    } else {
        Err(Blocked { reasons })
    }
}
