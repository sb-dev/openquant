//! Support for the integration tests of the batch host: a fake queue, API and provider behind the
//! real egress module and clients (see `world`), synthetic documents (`data`) and the harness that
//! builds a job and runs a worker over it (`harness`).

#![allow(dead_code, unused_imports)]

pub mod data;
pub mod harness;
pub mod world;

pub use data::*;
pub use harness::*;
pub use world::*;
