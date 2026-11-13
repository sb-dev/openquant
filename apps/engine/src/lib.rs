//! Local S0 harness. It loads fixture cases, evaluates them through the shared core, checks
//! repeatability and restore, compares actual results with independently derived expectations
//! and writes a readable report. It holds no numerical logic of its own.

pub mod case;
pub mod compare;
pub mod replay;
pub mod report;
