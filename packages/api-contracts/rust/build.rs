//! Generates Rust bindings from the shared JSON Schemas at build time.
//!
//! The schemas stay the single source: nothing generated is committed, so bindings cannot drift.
//! typify cannot resolve cross-file references, so every file's `$defs` merge into one
//! `definitions` map and each root object becomes a definition named by its `title`. Definition
//! names must be unique across all files. A reference to a whole schema by its `$id` points at the
//! definition of that schema's root.

use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    error::Error,
    fs,
    path::PathBuf,
};

use serde_json::{Map, Value, json};

/// Every schema file, by name. The engine-scope files come first, then the S1 connected files
/// (OQ-05 section 7). The build fails when the directory holds a file that is not listed here.
const SCHEMAS: &[&str] = &[
    "common",
    "strategy-artefact",
    "evaluation-input",
    "evaluation-result",
    "checkpoint",
    "connected-common",
    "evaluation-plan",
    "evaluation-request",
    "evaluation-submission",
    "job-dispatch",
    "attempt-claim",
    "command",
    "research-profile",
    "cohort-policy",
    "dataset-manifest",
    "retrieval-request",
    "retrieval-result",
    "validation-result",
    "evaluation-metrics",
    "gate-report",
    "agent-dispatch",
    "agent-attempt-result",
    "api-error",
    "release-manifest",
];

/// Files that hold shared definitions only. Their roots are not types.
const DEFINITIONS_ONLY: &[&str] = &["common", "connected-common"];

const SUFFIX: &str = ".schema.json";

/// Rewrite every `$ref` to the merged `definitions` map. `roots` maps a schema `$id` to the title
/// of its root, for references to a whole schema. Any other reference is an error.
fn rewrite_refs(value: &mut Value, roots: &BTreeMap<String, String>) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get_mut("$ref") {
                if let Some(index) = reference.find("#/$defs/") {
                    let name = reference
                        .get(index + "#/$defs/".len()..)
                        .unwrap_or_default();
                    *reference = format!("#/definitions/{name}");
                } else if let Some(title) = roots.get(reference.as_str()) {
                    *reference = format!("#/definitions/{title}");
                } else {
                    return Err(format!("cannot resolve reference {reference}"));
                }
            }
            for child in map.values_mut() {
                rewrite_refs(child, roots)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                rewrite_refs(child, roots)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn insert_unique(
    definitions: &mut Map<String, Value>,
    name: String,
    schema: Value,
) -> Result<(), Box<dyn Error>> {
    if definitions.contains_key(&name) {
        return Err(format!("schema definition name collision: {name}").into());
    }
    definitions.insert(name, schema);
    Ok(())
}

fn text_field<'a>(schema: &'a Value, name: &str, field: &str) -> Result<&'a str, String> {
    schema
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{name}: root schema needs a {field}"))
}

/// Fail when the schema directory and [`SCHEMAS`] disagree, so no file is silently left out.
fn check_listed(schema_dir: &PathBuf) -> Result<(), Box<dyn Error>> {
    let mut on_disk = BTreeSet::new();
    for entry in fs::read_dir(schema_dir)? {
        let file = entry?.file_name();
        if let Some(name) = file.to_str().and_then(|f| f.strip_suffix(SUFFIX)) {
            on_disk.insert(name.to_owned());
        }
    }
    let listed: BTreeSet<String> = SCHEMAS.iter().map(|name| (*name).to_owned()).collect();
    if listed.len() != SCHEMAS.len() {
        return Err("build.rs lists a schema twice".into());
    }
    if on_disk != listed {
        let unlisted: Vec<_> = on_disk.difference(&listed).collect();
        let missing: Vec<_> = listed.difference(&on_disk).collect();
        return Err(format!(
            "schema files and build.rs disagree: not listed {unlisted:?}, missing {missing:?}"
        )
        .into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let schema_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("../schemas");
    println!("cargo:rerun-if-changed={}", schema_dir.display());
    check_listed(&schema_dir)?;

    let mut schemas = Vec::new();
    for name in SCHEMAS {
        let path = schema_dir.join(format!("{name}{SUFFIX}"));
        println!("cargo:rerun-if-changed={}", path.display());
        let schema: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
        schemas.push((*name, schema));
    }

    let mut roots = BTreeMap::new();
    for (name, schema) in &schemas {
        if !DEFINITIONS_ONLY.contains(name) {
            let id = text_field(schema, name, "$id")?;
            let title = text_field(schema, name, "title")?;
            roots.insert(id.to_owned(), title.to_owned());
        }
    }

    let mut definitions = Map::new();
    for (name, mut schema) in schemas {
        rewrite_refs(&mut schema, &roots).map_err(|e| format!("{name}: {e}"))?;
        let Some(object) = schema.as_object_mut() else {
            return Err(format!("{name}: schema root must be an object").into());
        };
        if let Some(Value::Object(defs)) = object.remove("$defs") {
            for (def_name, def) in defs {
                insert_unique(&mut definitions, def_name, def)?;
            }
        }
        if !DEFINITIONS_ONLY.contains(&name) {
            let title = object
                .get("title")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{name}: root schema needs a title"))?
                .to_owned();
            object.remove("$schema");
            object.remove("$id");
            insert_unique(&mut definitions, title, schema)?;
        }
    }

    let root: schemars::schema::RootSchema = serde_json::from_value(json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": definitions,
    }))?;
    let mut space = typify::TypeSpace::new(
        typify::TypeSpaceSettings::default()
            .with_derive("PartialEq".to_owned())
            .with_derive("Eq".to_owned()),
    );
    space.add_root_schema(root)?;
    let file = syn::parse2::<syn::File>(space.to_stream())?;
    let out = PathBuf::from(env::var("OUT_DIR")?).join("generated.rs");
    fs::write(out, prettyplease::unparse(&file))?;
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
