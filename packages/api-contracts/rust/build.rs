//! Generates Rust bindings from the shared JSON Schemas at build time.
//!
//! The schemas stay the single source: nothing generated is committed, so bindings cannot drift.
//! typify cannot resolve cross-file references, so every file's `$defs` merge into one
//! `definitions` map and each root object becomes a definition named by its `title`.

use std::{env, error::Error, fs, path::PathBuf};

use serde_json::{Map, Value, json};

const SCHEMAS: &[&str] = &[
    "common",
    "strategy-artefact",
    "evaluation-input",
    "evaluation-result",
    "checkpoint",
];

fn rewrite_refs(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get_mut("$ref")
                && let Some(index) = reference.find("#/$defs/")
            {
                let name = reference
                    .get(index + "#/$defs/".len()..)
                    .unwrap_or_default();
                *reference = format!("#/definitions/{name}");
            }
            for child in map.values_mut() {
                rewrite_refs(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                rewrite_refs(child);
            }
        }
        _ => {}
    }
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

fn main() -> Result<(), Box<dyn Error>> {
    let schema_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("../schemas");
    let mut definitions = Map::new();

    for name in SCHEMAS {
        let path = schema_dir.join(format!("{name}.schema.json"));
        println!("cargo:rerun-if-changed={}", path.display());
        let mut schema: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
        rewrite_refs(&mut schema);
        let Some(object) = schema.as_object_mut() else {
            return Err(format!("{name}: schema root must be an object").into());
        };
        if let Some(Value::Object(defs)) = object.remove("$defs") {
            for (def_name, def) in defs {
                insert_unique(&mut definitions, def_name, def)?;
            }
        }
        if *name != "common" {
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
