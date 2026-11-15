//! The batch host: egress, the queue and API clients, the worker loop and the four jobs
//! (OQ-05 sections 4, 5, 7 and 7.1).
//!
//! - [`egress`] is the only way the binary sends a request: an allowlist of exact host, method and
//!   path, a request budget, HTTPS only, no redirect followed, no credential in a log. [`wire`] is
//!   the one HTTP client behind it.
//! - [`queue`] is the Cloudflare Queues HTTP-pull consumer, and [`api`] the client of the
//!   application API's attempt routes.
//! - [`worker`] pulls a job message, claims its attempt, runs the job, uploads and submits, and
//!   acknowledges only after the result is committed. [`jobs`] holds the four jobs: `retrieve`,
//!   `validate`, `evaluate` and `assess`. [`input`] builds the inner evaluation input of a
//!   provider run from its dataset manifest.
//! - [`config`] reads the environment and fails closed; [`identity`] states the executable, engine
//!   and method identities; [`clock`] and [`secret`] are small shared pieces. [`journal`] is the
//!   optional local checkpoint journal of a long evaluation.

pub mod api;
pub mod clock;
pub mod config;
pub mod egress;
pub mod identity;
pub mod input;
pub mod jobs;
pub mod journal;
pub mod queue;
pub mod secret;
pub mod wire;
pub mod worker;
