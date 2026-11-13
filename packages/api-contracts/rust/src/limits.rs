//! Structural limits that gate the full diagnostic pass of schema validation.
//!
//! The JSON Schema validator's `iter_errors` costs memory in proportion to the violations in the
//! document, even when the caller reads only the first few: about 4 KiB for an empty object that
//! misses ten required properties, however few bytes that object takes on the wire. A payload
//! under the byte limit can hold millions of such objects.
//!
//! [`crate::validate`] therefore asks the validator for one error first, which is cheap at any
//! size, and only a document that stays under these limits goes on to the full pass. The worst
//! such document, 20,000 empty records that each miss their required properties, peaked at 79 MB
//! in a release build.
//!
//! The limits come from the schema maxima with generous headroom: the largest `maxItems` is
//! 4,000, the widest object has 12 properties and the longest `maxLength` is 2,000 characters,
//! or 8,000 bytes. They never limit a valid document, because a valid document leaves
//! `validate` before this check.
//!
//! The value limit is per document, not per contract. A schema-valid evaluation result or
//! checkpoint can hold more than [`MAX_NODES`] values (4,000 ledger entries alone hold about
//! 36,000). Such a document is accepted when it is valid. When it is invalid, it reports
//! `SCHEMA_VIOLATION` with the first violation, even if that violation is a decimal-grammar one.
//!
//! The depth limit does not protect the first-error pass. That pass recurses over the depth of a
//! recursive schema such as an expression. A [`serde_json::Value`] built by hand and nested
//! about 2,000 levels deep can overflow the stack there. The strict text parser refuses depth
//! above 128 first, so a document that comes from text is safe.

use std::{iter::Enumerate, slice::Iter as SliceIter};

use serde_json::{Value, map::Iter as MapIter};

use crate::error::SchemaViolation;

/// Values in the whole document. The largest valid evaluation input holds about 5,400. A valid
/// result or checkpoint can hold more, and the limit then applies only if the document is invalid.
pub(crate) const MAX_NODES: usize = 20_000;
/// Nesting depth. This is the recursion limit of the strict parser.
pub(crate) const MAX_DEPTH: usize = 128;
/// Items in one array. Twice the schema maximum.
pub(crate) const MAX_ARRAY_LEN: usize = 8_192;
/// Properties in one object. More than five times the schema maximum.
pub(crate) const MAX_OBJECT_KEYS: usize = 64;
/// Bytes in one string. Twice the UTF-8 size of the longest string the schemas admit.
pub(crate) const MAX_STRING_BYTES: usize = 16_384;

enum Segment<'a> {
    Index(usize),
    Key(&'a str),
}

enum Children<'a> {
    Array(Enumerate<SliceIter<'a, Value>>),
    Object(MapIter<'a>),
}

impl<'a> Iterator for Children<'a> {
    type Item = (Segment<'a>, &'a Value);

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Array(items) => items
                .next()
                .map(|(index, value)| (Segment::Index(index), value)),
            Self::Object(entries) => entries
                .next()
                .map(|(key, value)| (Segment::Key(key.as_str()), value)),
        }
    }
}

/// A container being walked, with the segment that led to it from its parent.
struct Frame<'a> {
    via: Option<Segment<'a>>,
    children: Children<'a>,
}

fn pointer(frames: &[Frame<'_>], last: Option<&Segment<'_>>) -> String {
    let mut out = String::new();
    for segment in frames
        .iter()
        .filter_map(|frame| frame.via.as_ref())
        .chain(last)
    {
        out.push('/');
        match segment {
            Segment::Index(index) => out.push_str(&index.to_string()),
            Segment::Key(key) => out.push_str(&key.replace('~', "~0").replace('/', "~1")),
        }
    }
    out
}

fn exceeded(value: &Value, nodes: usize, depth: usize) -> Option<String> {
    if depth >= MAX_DEPTH {
        return Some(format!("nesting is deeper than {MAX_DEPTH} levels"));
    }
    if nodes > MAX_NODES {
        return Some(format!("document has more than {MAX_NODES} values"));
    }
    match value {
        Value::String(text) if text.len() > MAX_STRING_BYTES => Some(format!(
            "string of {} bytes is longer than {MAX_STRING_BYTES}",
            text.len()
        )),
        Value::Array(items) if items.len() > MAX_ARRAY_LEN => Some(format!(
            "array of {} items is longer than {MAX_ARRAY_LEN}",
            items.len()
        )),
        Value::Object(entries) if entries.len() > MAX_OBJECT_KEYS => Some(format!(
            "object of {} properties is wider than {MAX_OBJECT_KEYS}",
            entries.len()
        )),
        _ => None,
    }
}

/// Walk the document without recursion and report the first value that exceeds a limit.
///
/// The walk visits values in document order and stops at the first excess, so its cost is
/// bounded by the limits themselves, not by the size of the document.
pub(crate) fn first_excess(root: &Value) -> Option<SchemaViolation> {
    let mut frames: Vec<Frame<'_>> = Vec::new();
    let mut nodes = 0_usize;
    let mut next: Option<(Option<Segment<'_>>, &Value)> = Some((None, root));
    loop {
        if let Some((via, value)) = next.take() {
            nodes = nodes.saturating_add(1);
            if let Some(message) = exceeded(value, nodes, frames.len()) {
                return Some(SchemaViolation {
                    pointer: pointer(&frames, via.as_ref()),
                    message: format!("{message}; the document is not examined further"),
                    decimal_grammar: false,
                });
            }
            match value {
                Value::Array(items) => frames.push(Frame {
                    via,
                    children: Children::Array(items.iter().enumerate()),
                }),
                Value::Object(entries) => frames.push(Frame {
                    via,
                    children: Children::Object(entries.iter()),
                }),
                _ => {}
            }
        }
        let frame = frames.last_mut()?;
        next = frame
            .children
            .next()
            .map(|(segment, value)| (Some(segment), value));
        if next.is_none() {
            frames.pop();
        }
    }
}
