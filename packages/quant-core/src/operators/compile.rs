//! Compile and type-check operator trees (OQ-02 section 2.2).
//!
//! Validation happens before any evaluation: unknown operators, wrong arity, missing or stray
//! parameters, unit and type mismatches, scope violations and resource limits all fail here.

use openquant_contracts::generated::{Expr, ExprParamsField};

use super::catalogue::{OpId, Scope, lookup};
use crate::{
    model::{Failure, FailureCode, Result, Unit},
    numeric::Decimal,
    ratio::Ratio,
};

pub const MAX_DEPTH: usize = 16;
/// Limit on the nesting of one evaluation, counting the operator levels reached through `ref`.
/// The evaluator recurses once per level, so this bounds its stack use: a chain of references
/// to references, each a full-depth expression, could otherwise exhaust a small thread stack.
pub const MAX_EVAL_DEPTH: usize = 64;
pub const MAX_NODES: usize = 128;
pub const MAX_WINDOW: u64 = 252;
pub const MAX_PERIODS: u64 = 60;
/// Upper bound on the evaluation work of one tree (see `Node::cost`).
pub const MAX_COST: u64 = 200_000;
const MAX_CONST_ABS: i64 = 1_000_000_000_000;
const MAX_CONST_SCALE: u32 = 12;

/// An OHLCV field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Open,
    High,
    Low,
    Close,
    Volume,
}

/// A compiled, typed operator node.
#[derive(Clone, Debug)]
pub struct Node {
    pub op: OpId,
    pub args: Vec<Node>,
    pub unit: Unit,
    pub window: usize,
    pub periods: usize,
    pub field: Field,
    pub value: Ratio,
    pub name: String,
    /// Index of the referenced indicator (`ref` only).
    pub index: usize,
    /// Upper bound on evaluation work: number of node visits for one evaluation.
    pub cost: u64,
    /// Number of earlier sessions the node needs beyond the current one.
    pub lookback: usize,
    /// Nesting of one evaluation of this node, including levels reached through `ref`.
    pub depth: usize,
}

/// A named value visible to later expressions.
#[derive(Clone, Debug)]
pub struct Defined {
    pub name: String,
    pub unit: Unit,
    pub cost: u64,
    pub lookback: usize,
    pub depth: usize,
}

/// Compilation context.
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    pub scope: Scope,
    pub indicators: &'a [Defined],
    pub snapshots: &'a [Defined],
}

fn fail(code: FailureCode, path: &str, message: &str) -> Failure {
    Failure::new(code, format!("{path}: {message}"))
}

fn numeric(unit: Unit) -> bool {
    unit != Unit::Flag
}

fn convert_field(field: ExprParamsField) -> Field {
    match field {
        ExprParamsField::Open => Field::Open,
        ExprParamsField::High => Field::High,
        ExprParamsField::Low => Field::Low,
        ExprParamsField::Close => Field::Close,
        ExprParamsField::Volume => Field::Volume,
    }
}

/// Which parameters an operator takes.
struct Wants {
    window: bool,
    periods: bool,
    field: bool,
    value: bool,
    unit: bool,
    name: bool,
}

const NONE: Wants = Wants {
    window: false,
    periods: false,
    field: false,
    value: false,
    unit: false,
    name: false,
};

fn wants(op: OpId) -> Wants {
    match op {
        OpId::Const => Wants {
            value: true,
            unit: true,
            ..NONE
        },
        OpId::BarField => Wants {
            field: true,
            ..NONE
        },
        OpId::Ref | OpId::Snapshot => Wants { name: true, ..NONE },
        OpId::Lag => Wants {
            periods: true,
            ..NONE
        },
        OpId::Sma | OpId::RsiSimple | OpId::AtrSimple => Wants {
            window: true,
            ..NONE
        },
        _ => NONE,
    }
}

fn check_params(expr: &Expr, op: OpId, path: &str) -> Result<()> {
    let params = &expr.params;
    let want = wants(op);
    let checks = [
        ("window", want.window, params.window.is_some()),
        ("periods", want.periods, params.periods.is_some()),
        ("field", want.field, params.field.is_some()),
        ("value", want.value, params.value.is_some()),
        ("unit", want.unit, params.unit.is_some()),
        ("name", want.name, params.name.is_some()),
    ];
    for (name, wanted, present) in checks {
        if wanted && !present {
            return Err(fail(
                FailureCode::InvalidParameter,
                path,
                &format!("parameter {name} is required"),
            ));
        }
        if !wanted && present {
            return Err(fail(
                FailureCode::InvalidParameter,
                path,
                &format!("parameter {name} is not accepted by this operator"),
            ));
        }
    }
    Ok(())
}

fn bounded(value: u64, max: u64, what: &str, path: &str) -> Result<usize> {
    if value > max {
        return Err(fail(
            FailureCode::InvalidParameter,
            path,
            &format!("{what} {value} exceeds the limit {max}"),
        ));
    }
    usize::try_from(value).map_err(|_| fail(FailureCode::InvalidParameter, path, "too large"))
}

fn same_numeric(a: &Node, b: &Node, path: &str) -> Result<Unit> {
    if !numeric(a.unit) || !numeric(b.unit) {
        return Err(fail(
            FailureCode::OperatorTypeMismatch,
            path,
            "a numeric operand is required",
        ));
    }
    if a.unit != b.unit {
        return Err(fail(
            FailureCode::OperatorUnitMismatch,
            path,
            &format!("units differ: {:?} and {:?}", a.unit, b.unit),
        ));
    }
    Ok(a.unit)
}

/// Compile an expression.
///
/// # Errors
/// A typed [`Failure`] naming the JSON path of the first problem.
pub fn compile_expr(expr: &Expr, ctx: Ctx<'_>, path: &str, nodes: &mut usize) -> Result<Node> {
    compile_inner(expr, ctx, path, nodes, 1)
}

fn compile_inner(
    expr: &Expr,
    ctx: Ctx<'_>,
    path: &str,
    nodes: &mut usize,
    depth: usize,
) -> Result<Node> {
    if depth > MAX_DEPTH {
        return Err(fail(
            FailureCode::InvalidParameter,
            path,
            &format!("expression deeper than {MAX_DEPTH}"),
        ));
    }
    *nodes = nodes.saturating_add(1);
    if *nodes > MAX_NODES {
        return Err(fail(
            FailureCode::InvalidParameter,
            path,
            &format!("expression has more than {MAX_NODES} nodes"),
        ));
    }
    let descriptor = lookup(expr.op.as_str()).map_err(|f| fail(f.code, path, &f.detail))?;
    if !descriptor.scopes.contains(&ctx.scope) {
        return Err(fail(
            FailureCode::OperatorTypeMismatch,
            path,
            &format!(
                "operator {} is not allowed in {:?} scope",
                descriptor.name, ctx.scope
            ),
        ));
    }
    let arg_count = expr.args.len();
    if arg_count < descriptor.min_args || arg_count > descriptor.max_args {
        return Err(fail(
            FailureCode::InvalidParameter,
            path,
            &format!(
                "{} takes {}..={} arguments, found {arg_count}",
                descriptor.name, descriptor.min_args, descriptor.max_args
            ),
        ));
    }
    check_params(expr, descriptor.id, path)?;

    let mut args = Vec::with_capacity(arg_count);
    for (index, child) in expr.args.iter().enumerate() {
        let child_path = format!("{path}/args/{index}");
        args.push(compile_inner(child, ctx, &child_path, nodes, depth + 1)?);
    }

    let mut node = Node {
        op: descriptor.id,
        args,
        unit: Unit::Flag,
        window: 0,
        periods: 0,
        field: Field::Close,
        value: Ratio::ZERO,
        name: String::new(),
        index: 0,
        cost: 1,
        lookback: 0,
        depth: 1,
    };
    let child_cost: u64 = node
        .args
        .iter()
        .map(|a| a.cost)
        .fold(0, u64::saturating_add);
    let child_lookback = node.args.iter().map(|a| a.lookback).max().unwrap_or(0);
    let child_depth = node.args.iter().map(|a| a.depth).max().unwrap_or(0);
    node.cost = child_cost.saturating_add(1);
    node.lookback = child_lookback;
    node.depth = child_depth.saturating_add(1);

    match descriptor.id {
        OpId::Const => {
            let unit = expr
                .params
                .unit
                .ok_or_else(|| fail(FailureCode::InvalidParameter, path, "unit"))?;
            if !numeric(unit) {
                return Err(fail(
                    FailureCode::InvalidParameter,
                    path,
                    "a constant cannot be a FLAG",
                ));
            }
            let text = expr
                .params
                .value
                .as_ref()
                .map(|v| v.as_str())
                .unwrap_or_default();
            let value = Decimal::from_str_exact(text)
                .map_err(|_| fail(FailureCode::InvalidDecimal, path, "constant out of range"))?;
            if value.scale() > MAX_CONST_SCALE || value.abs() > Decimal::from(MAX_CONST_ABS) {
                return Err(fail(
                    FailureCode::InvalidParameter,
                    path,
                    "constant outside the supported range",
                ));
            }
            node.unit = unit;
            node.value = Ratio::from_decimal(value);
        }
        OpId::BarField => {
            let field = expr
                .params
                .field
                .map(convert_field)
                .ok_or_else(|| fail(FailureCode::InvalidParameter, path, "field"))?;
            node.field = field;
            node.unit = if field == Field::Volume {
                Unit::Shares
            } else {
                Unit::Price
            };
        }
        OpId::Ref => {
            let name = expr
                .params
                .name
                .as_ref()
                .map(|n| n.as_str())
                .unwrap_or_default();
            let (index, found) = ctx
                .indicators
                .iter()
                .enumerate()
                .find(|(_, d)| d.name == name)
                .ok_or_else(|| {
                    fail(
                        FailureCode::InvalidParameter,
                        path,
                        &format!("unknown or later-defined indicator {name:?}"),
                    )
                })?;
            node.name = name.to_owned();
            node.index = index;
            node.unit = found.unit;
            node.cost = found.cost.saturating_add(1);
            node.lookback = found.lookback;
            node.depth = found.depth.saturating_add(1);
        }
        OpId::Snapshot => {
            let name = expr
                .params
                .name
                .as_ref()
                .map(|n| n.as_str())
                .unwrap_or_default();
            let found = ctx
                .snapshots
                .iter()
                .find(|d| d.name == name)
                .ok_or_else(|| {
                    fail(
                        FailureCode::InvalidParameter,
                        path,
                        &format!("unknown snapshot {name:?}"),
                    )
                })?;
            node.name = name.to_owned();
            node.unit = found.unit;
        }
        OpId::EntryPrice => node.unit = Unit::Price,
        OpId::Lag => {
            let (arg_unit, _, arg_lookback) = first(&node, path)?;
            if !numeric(arg_unit) {
                return Err(fail(
                    FailureCode::OperatorTypeMismatch,
                    path,
                    "lag needs a numeric input",
                ));
            }
            let periods = expr.params.periods.map_or(0, std::num::NonZeroU64::get);
            node.periods = bounded(periods, MAX_PERIODS, "periods", path)?;
            node.unit = arg_unit;
            node.lookback = arg_lookback.saturating_add(node.periods);
        }
        OpId::Sma => {
            let (arg_unit, arg_cost, arg_lookback) = first(&node, path)?;
            if !numeric(arg_unit) {
                return Err(fail(
                    FailureCode::OperatorTypeMismatch,
                    path,
                    "sma needs a numeric input",
                ));
            }
            let window = expr.params.window.map_or(0, std::num::NonZeroU64::get);
            node.window = bounded(window, MAX_WINDOW, "window", path)?;
            node.unit = arg_unit;
            node.cost = arg_cost.saturating_mul(window).saturating_add(1);
            node.lookback = arg_lookback.saturating_add(node.window.saturating_sub(1));
        }
        OpId::RsiSimple => {
            let (arg_unit, arg_cost, arg_lookback) = first(&node, path)?;
            if !numeric(arg_unit) {
                return Err(fail(
                    FailureCode::OperatorTypeMismatch,
                    path,
                    "rsi_simple needs a numeric input",
                ));
            }
            if arg_unit != Unit::Price {
                return Err(fail(
                    FailureCode::OperatorUnitMismatch,
                    path,
                    "rsi_simple needs a PRICE input",
                ));
            }
            let window = expr.params.window.map_or(0, std::num::NonZeroU64::get);
            node.window = bounded(window, MAX_WINDOW, "window", path)?;
            node.unit = Unit::Points;
            node.cost = arg_cost
                .saturating_mul(window.saturating_add(1))
                .saturating_add(1);
            node.lookback = arg_lookback.saturating_add(node.window);
        }
        OpId::AtrSimple => {
            let window = expr.params.window.map_or(0, std::num::NonZeroU64::get);
            node.window = bounded(window, MAX_WINDOW, "window", path)?;
            node.unit = Unit::Price;
            node.cost = window.saturating_mul(2).saturating_add(1);
            node.lookback = node.window;
        }
        OpId::Add | OpId::Sub => {
            let (a, b) = pair(&node, path)?;
            node.unit = same_numeric(a, b, path)?;
        }
        OpId::Mul => {
            let (a, b) = pair(&node, path)?;
            if !numeric(a.unit) || !numeric(b.unit) {
                return Err(fail(
                    FailureCode::OperatorTypeMismatch,
                    path,
                    "mul needs numeric operands",
                ));
            }
            node.unit = if a.unit == Unit::Ratio {
                b.unit
            } else if b.unit == Unit::Ratio {
                a.unit
            } else {
                return Err(fail(
                    FailureCode::OperatorUnitMismatch,
                    path,
                    "mul needs one RATIO factor",
                ));
            };
        }
        OpId::Div => {
            let (a, b) = pair(&node, path)?;
            if !numeric(a.unit) || !numeric(b.unit) {
                return Err(fail(
                    FailureCode::OperatorTypeMismatch,
                    path,
                    "div needs numeric operands",
                ));
            }
            node.unit = if a.unit == b.unit {
                Unit::Ratio
            } else if b.unit == Unit::Ratio {
                a.unit
            } else {
                return Err(fail(
                    FailureCode::OperatorUnitMismatch,
                    path,
                    "div needs equal units or a RATIO divisor",
                ));
            };
        }
        OpId::Gt | OpId::Gte | OpId::Lt | OpId::Lte => {
            let (a, b) = pair(&node, path)?;
            same_numeric(a, b, path)?;
            node.unit = Unit::Flag;
        }
        OpId::And | OpId::Or => {
            if node.args.iter().any(|a| a.unit != Unit::Flag) {
                return Err(fail(
                    FailureCode::OperatorTypeMismatch,
                    path,
                    "and/or need FLAG operands",
                ));
            }
            node.unit = Unit::Flag;
        }
    }
    if node.cost > MAX_COST {
        return Err(fail(
            FailureCode::InvalidParameter,
            path,
            &format!("evaluation cost {} exceeds the limit {MAX_COST}", node.cost),
        ));
    }
    if node.depth > MAX_EVAL_DEPTH {
        return Err(fail(
            FailureCode::InvalidParameter,
            path,
            &format!(
                "evaluation depth {} (including referenced indicators) exceeds the limit {MAX_EVAL_DEPTH}",
                node.depth
            ),
        ));
    }
    Ok(node)
}

fn first(node: &Node, path: &str) -> Result<(Unit, u64, usize)> {
    node.args
        .first()
        .map(|arg| (arg.unit, arg.cost, arg.lookback))
        .ok_or_else(|| fail(FailureCode::InvalidParameter, path, "missing argument"))
}

fn pair<'a>(node: &'a Node, path: &str) -> Result<(&'a Node, &'a Node)> {
    match (node.args.first(), node.args.get(1)) {
        (Some(a), Some(b)) => Ok((a, b)),
        _ => Err(fail(
            FailureCode::InvalidParameter,
            path,
            "two arguments are required",
        )),
    }
}
