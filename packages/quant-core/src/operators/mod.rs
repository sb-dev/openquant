//! Reviewed typed operators (OQ-02 section 2.2): catalogue, compiler, evaluator, indicator maths.

pub mod catalogue;
pub mod compile;
pub mod eval;
pub mod indicators;

pub use catalogue::{CATALOGUE, Descriptor, OPERATOR_SET, OpId, Scope};
pub use compile::{Field, Node};
pub use eval::{Env, PriceBar, Value};
