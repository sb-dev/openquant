//! Strategy validation: one validator for every Strategy Definition (OQ-02 sections 2.1-2.2).
//!
//! The four seed variants and any later revision pass through this function. There is no
//! variant-specific code anywhere in the engine.

use openquant_contracts::{StrategyArtefact, generated::StrategyDefinition, payload_digest};

use crate::{
    model::{Failure, FailureCode, Result, Unit},
    operators::{
        OPERATOR_SET, Scope,
        compile::{Ctx, Defined, Node, compile_expr},
    },
};

/// A named compiled expression.
#[derive(Clone, Debug)]
pub struct NamedNode {
    pub name: String,
    pub node: Node,
}

/// A one-time stop change.
#[derive(Clone, Debug)]
pub struct Adjustment {
    pub id: String,
    pub trigger: Node,
    pub new_level: Node,
}

/// A strategy that passed validation, ready for evaluation.
#[derive(Clone, Debug)]
pub struct ValidatedStrategy {
    pub hash: String,
    pub strategy_id: String,
    pub version: u64,
    pub slots: usize,
    pub indicators: Vec<NamedNode>,
    pub condition: Node,
    pub rank: Node,
    pub snapshots: Vec<NamedNode>,
    pub stop: Node,
    pub target: Node,
    pub adjustments: Vec<Adjustment>,
    /// Sessions of history needed before the first possible decision.
    pub max_lookback: usize,
    /// Upper bound on node evaluations for one decision (all signal expressions together).
    pub cost: u64,
}

const MAX_TOTAL_LOOKBACK: usize = 400;
/// Limit on the node evaluations of one decision, summed over every signal expression. The
/// seed family needs a few hundred.
pub const MAX_STRATEGY_COST: u64 = 1_000_000;

fn fail(code: FailureCode, path: &str, message: &str) -> Failure {
    Failure::new(code, format!("{path}: {message}"))
}

fn unique(names: &[&str], path: &str) -> Result<()> {
    for (index, name) in names.iter().enumerate() {
        if names.iter().take(index).any(|earlier| earlier == name) {
            return Err(fail(
                FailureCode::InvalidParameter,
                path,
                &format!("duplicate name {name:?}"),
            ));
        }
    }
    Ok(())
}

/// A stop, target or new stop level is a price: a flag is the wrong type, any other unit the
/// wrong unit.
fn require_price_level(path: &str, node: &Node) -> Result<()> {
    match node.unit {
        Unit::Price => Ok(()),
        Unit::Flag => Err(fail(
            FailureCode::OperatorTypeMismatch,
            path,
            "a level must be a PRICE, found a FLAG",
        )),
        other => Err(fail(
            FailureCode::OperatorUnitMismatch,
            path,
            &format!("a level must be a PRICE, found {other:?}"),
        )),
    }
}

/// Validate and compile a Strategy Artefact.
///
/// # Errors
/// A typed [`Failure`] before any evaluation: unknown operators, invalid units or types,
/// invalid parameters, unsupported operator set.
pub fn validate_strategy(artefact: &StrategyArtefact) -> Result<ValidatedStrategy> {
    if artefact.operator_set.to_string() != OPERATOR_SET {
        return Err(fail(
            FailureCode::UnsupportedOperator,
            "/operator_set",
            "unsupported operator set",
        ));
    }
    let definition: &StrategyDefinition = &artefact.definition;
    let slots = usize::try_from(definition.selection.slots.get()).map_err(|_| {
        fail(
            FailureCode::InvalidParameter,
            "/definition/selection/slots",
            "too large",
        )
    })?;

    let names: Vec<&str> = definition
        .indicators
        .iter()
        .map(|i| i.name.as_str())
        .collect();
    unique(&names, "/definition/indicators")?;
    let snapshot_names: Vec<&str> = definition
        .entry
        .snapshots
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    unique(&snapshot_names, "/definition/entry/snapshots")?;
    let adjustment_ids: Vec<&str> = definition
        .exits
        .stop_adjustments
        .iter()
        .map(|a| a.id.as_str())
        .collect();
    unique(&adjustment_ids, "/definition/exits/stop_adjustments")?;

    let mut defined: Vec<Defined> = Vec::new();
    let mut indicators = Vec::new();
    for (index, item) in definition.indicators.iter().enumerate() {
        let path = format!("/definition/indicators/{index}/expr");
        let ctx = Ctx {
            scope: Scope::Signal,
            indicators: &defined,
            snapshots: &[],
        };
        let node = compile_expr(&item.expr, ctx, &path, &mut 0)?;
        defined.push(Defined {
            name: item.name.to_string(),
            unit: node.unit,
            cost: node.cost,
            lookback: node.lookback,
            depth: node.depth,
        });
        indicators.push(NamedNode {
            name: item.name.to_string(),
            node,
        });
    }

    let signal_ctx = Ctx {
        scope: Scope::Signal,
        indicators: &defined,
        snapshots: &[],
    };
    let condition = compile_expr(
        &definition.entry.condition,
        signal_ctx,
        "/definition/entry/condition",
        &mut 0,
    )?;
    if condition.unit != Unit::Flag {
        return Err(fail(
            FailureCode::OperatorTypeMismatch,
            "/definition/entry/condition",
            "the entry condition must be a FLAG",
        ));
    }
    let rank = compile_expr(
        &definition.entry.rank,
        signal_ctx,
        "/definition/entry/rank",
        &mut 0,
    )?;
    if rank.unit == Unit::Flag {
        return Err(fail(
            FailureCode::OperatorTypeMismatch,
            "/definition/entry/rank",
            "the rank must be numeric",
        ));
    }

    let mut snapshots = Vec::new();
    let mut snapshot_defs: Vec<Defined> = Vec::new();
    for (index, item) in definition.entry.snapshots.iter().enumerate() {
        let path = format!("/definition/entry/snapshots/{index}/expr");
        let node = compile_expr(&item.expr, signal_ctx, &path, &mut 0)?;
        if node.unit == Unit::Flag {
            return Err(fail(
                FailureCode::OperatorTypeMismatch,
                &path,
                "a snapshot must be numeric",
            ));
        }
        snapshot_defs.push(Defined {
            name: item.name.to_string(),
            unit: node.unit,
            cost: node.cost,
            lookback: node.lookback,
            depth: node.depth,
        });
        snapshots.push(NamedNode {
            name: item.name.to_string(),
            node,
        });
    }

    let level_ctx = Ctx {
        scope: Scope::Level,
        indicators: &[],
        snapshots: &snapshot_defs,
    };
    let trigger_ctx = Ctx {
        scope: Scope::Trigger,
        indicators: &[],
        snapshots: &snapshot_defs,
    };
    let stop = compile_expr(
        &definition.exits.stop,
        level_ctx,
        "/definition/exits/stop",
        &mut 0,
    )?;
    let target = compile_expr(
        &definition.exits.target,
        level_ctx,
        "/definition/exits/target",
        &mut 0,
    )?;
    require_price_level("/definition/exits/stop", &stop)?;
    require_price_level("/definition/exits/target", &target)?;
    let mut adjustments = Vec::new();
    for (index, item) in definition.exits.stop_adjustments.iter().enumerate() {
        let base = format!("/definition/exits/stop_adjustments/{index}");
        let trigger = compile_expr(
            &item.trigger,
            trigger_ctx,
            &format!("{base}/trigger"),
            &mut 0,
        )?;
        if trigger.unit != Unit::Flag {
            return Err(fail(
                FailureCode::OperatorTypeMismatch,
                &format!("{base}/trigger"),
                "a trigger must be a FLAG",
            ));
        }
        let new_level = compile_expr(
            &item.new_level,
            trigger_ctx,
            &format!("{base}/new_level"),
            &mut 0,
        )?;
        require_price_level(&format!("{base}/new_level"), &new_level)?;
        adjustments.push(Adjustment {
            id: item.id.to_string(),
            trigger,
            new_level,
        });
    }

    let max_lookback = indicators
        .iter()
        .map(|i| i.node.lookback)
        .chain([condition.lookback, rank.lookback])
        .chain(snapshots.iter().map(|s| s.node.lookback))
        .max()
        .unwrap_or(0);
    if max_lookback > MAX_TOTAL_LOOKBACK {
        return Err(fail(
            FailureCode::InvalidParameter,
            "/definition",
            "the strategy needs more history than the supported limit",
        ));
    }

    // One decision evaluates every indicator, the condition, the rank and every snapshot. Each
    // expression is limited on its own; this bounds the sum, so a definition of many
    // individually allowed expressions cannot make a decision take minutes.
    let cost = indicators
        .iter()
        .map(|i| i.node.cost)
        .chain([condition.cost, rank.cost])
        .chain(snapshots.iter().map(|s| s.node.cost))
        .fold(0, u64::saturating_add);
    if cost > MAX_STRATEGY_COST {
        return Err(fail(
            FailureCode::InvalidParameter,
            "/definition",
            &format!(
                "one decision needs {cost} node evaluations, more than the limit {MAX_STRATEGY_COST}"
            ),
        ));
    }

    Ok(ValidatedStrategy {
        hash: payload_digest(artefact)?,
        strategy_id: artefact.strategy_id.to_string(),
        version: artefact.version.get(),
        slots,
        indicators,
        condition,
        rank,
        snapshots,
        stop,
        target,
        adjustments,
        max_lookback,
        cost,
    })
}
