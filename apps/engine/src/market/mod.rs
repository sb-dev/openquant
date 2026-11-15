//! Market data for the connected competition: the provider adapter, the normaliser, the manifest
//! and the enablement gate (OQ-05 sections 5, 7 and 7.1).
//!
//! - [`provider`] defines the `MarketDataProvider` interface and the call accounting that enforces
//!   the request budget, the deadline, cancellation and the bounded retry policy outside the
//!   adapter.
//! - [`alpaca`] is the Alpaca adapter over an [`http::HttpTransport`]. It builds the endpoint
//!   requests, follows pagination and parses responses without a float.
//! - [`normalise`] turns the provider data into a `dataset-manifest/1` snapshot, with the
//!   availability time of every bar and corporate action under the profile's rules, or blocks the
//!   profile when the evidence the rules require is missing.
//! - [`gate`] keeps provider retrieval off unless it is enabled by configuration and the
//!   authority, entitlement, session and egress evidence is verified.
//! - [`retrieve`] sequences one retrieval behind the gate.
//!
//! Not here: the queue, the claim, the upload and the real HTTP client. They belong to the batch
//! host, which supplies the transport and holds the egress allowlist. Nothing in this module reads
//! the environment, the clock, the network or a credential on its own.

pub mod alpaca;
pub mod error;
pub mod gate;
pub mod http;
pub mod normalise;
pub mod number;
pub mod provider;
pub mod retrieve;
pub mod session;
pub mod time;
