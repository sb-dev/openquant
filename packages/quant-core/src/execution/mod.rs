//! The four daily phases (OQ-02 section 2.5): before open, open, during session, after close.
//!
//! Each phase receives the prior state by mutable reference on a private copy; `Run::step`
//! discards that copy on failure, so an event is all-or-nothing.

pub mod accounting;
pub mod after_close;
pub mod before_open;
pub mod corporate_actions;
pub mod open;
pub mod session;
