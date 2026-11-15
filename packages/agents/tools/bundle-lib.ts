// Build-time helpers shared by tools/generate.ts and tools/update-manifest.ts (Node only, never part of src).
//
// Two jobs:
//
// 1. Bundle the role schemas (packages/agents/schemas) with the shared schemas they reference
//    (packages/api-contracts/schemas) into one document with local references, as the shared generator does
//    for its own schemas. The shared generator cannot take the role schemas as they are: its $id grammar has no
//    dot, and the role contracts are named strategy-formulation.request and so on (OQ-05 section 7).
//    Everything after the bundle (types, validators, contract table) reuses the shared generator.
// 2. Describe the behaviour bundle (OQ-03 section 3): the exact files that ship, their SHA-256 values and the
//    digest of each derived, self-contained result schema, all recorded in bundle.manifest.json.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, digest } from '../../api-contracts/ts/src/canonical.ts';
import { BUNDLE_ID, type Bundle, type Contract, maxValues } from '../../api-contracts/ts/tools/generate.ts';

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

export interface SchemaFile {
  readonly directory: 'shared' | 'role';
  readonly file: string;
  readonly schema: JsonObject;
}

export const MANIFEST_FORMAT = 'openquant-agent-bundle/1';
export const MANIFEST_FILE = 'bundle.manifest.json';
/** The role contracts, in the order of the registry. The result schemas are what the model's output must satisfy. */
export const ROLE_CONTRACTS = [
  'strategy-formulation.request',
  'strategy-formulation.result',
  'strategy-critique.request',
  'strategy-critique.result',
] as const;
export const RESULT_CONTRACTS = ['strategy-formulation.result', 'strategy-critique.result'] as const;

const ROLE_SCHEMA_ID = /^urn:openquant:schema:([a-z][a-z0-9.-]*):([1-9][0-9]*)$/;
const DEF_REF = /^#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/;
const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;
const NON_VALIDATING = new Set(['$schema', '$id', '$defs', 'title', 'description']);
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export function fail(message: string): never {
  throw new Error(`agent bundle: ${message}`);
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function readSchemas(packageRoot: string): SchemaFile[] {
  const read = (directory: SchemaFile['directory'], path: string): SchemaFile[] =>
    readdirSync(path)
      .filter((file) => file.endsWith('.schema.json'))
      .sort()
      .map((file) => ({
        directory,
        file,
        schema: JSON.parse(readFileSync(resolve(path, file), 'utf8')) as JsonObject,
      }));
  return [
    ...read('shared', resolve(packageRoot, '../api-contracts/schemas')),
    ...read('role', resolve(packageRoot, 'schemas')),
  ];
}

interface Parsed {
  readonly source: SchemaFile;
  readonly name: string;
  readonly id: string;
  readonly title: string;
  readonly defs: JsonObject;
  readonly isRoot: boolean;
}

function parseSource(source: SchemaFile): Parsed {
  const { file, schema } = source;
  const id = schema.$id;
  const match = typeof id === 'string' ? ROLE_SCHEMA_ID.exec(id) : null;
  if (typeof id !== 'string' || !match) fail(`${file}: $id must be urn:openquant:schema:<name>:<version>`);
  const name = match[1] ?? '';
  if (file !== `${name}.schema.json`) fail(`${file}: the file name does not match $id ${id}`);
  const title = schema.title;
  if (typeof title !== 'string' || !TYPE_NAME.test(title)) fail(`${file}: the title must be a type name`);
  const defs = schema.$defs ?? {};
  if (!isObject(defs)) fail(`${file}: $defs must be an object`);
  return { source, name, id, title, defs, isRoot: Object.keys(schema).some((key) => !NON_VALIDATING.has(key)) };
}

function rewriteRef(ref: string, owner: Parsed, documents: ReadonlyMap<string, Parsed>): string {
  const hash = ref.indexOf('#');
  const base = hash < 0 ? ref : ref.slice(0, hash);
  const fragment = hash < 0 ? '' : ref.slice(hash);
  const target = base === '' ? owner : documents.get(base);
  if (!target) fail(`${owner.source.file}: unknown schema in reference ${ref}`);
  if (fragment === '') {
    if (!target.isRoot) fail(`${owner.source.file}: ${ref} names a schema that has no root`);
    return `#/$defs/${target.title}`;
  }
  const name = DEF_REF.exec(fragment)?.[1];
  if (name === undefined) fail(`${owner.source.file}: unsupported reference ${ref}`);
  if (!Object.hasOwn(target.defs, name)) fail(`${owner.source.file}: ${ref} is not defined in ${target.source.file}`);
  return `#/$defs/${name}`;
}

function rewrite(value: Json, owner: Parsed, documents: ReadonlyMap<string, Parsed>): Json {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, owner, documents));
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref') {
      if (typeof child !== 'string') fail(`${owner.source.file}: $ref must be a string`);
      out[key] = rewriteRef(child, owner, documents);
    } else {
      out[key] = rewrite(child, owner, documents);
    }
  }
  return out;
}

function versionTagOf(schema: Json | undefined): string | undefined {
  if (!isObject(schema) || !isObject(schema.properties)) return undefined;
  const version = schema.properties.schema_version;
  if (!isObject(version) || !Array.isArray(version.enum) || version.enum.length !== 1) return undefined;
  const [tag] = version.enum;
  return typeof tag === 'string' ? tag : undefined;
}

// The schema_version tag of every form of a root: the root itself, or each oneOf branch.
function versionTags(source: Parsed): (string | undefined)[] {
  const branches = source.source.schema.oneOf;
  if (!Array.isArray(branches)) return [versionTagOf(source.source.schema)];
  return branches.map((branch) => {
    const ref = isObject(branch) ? branch.$ref : undefined;
    const name = typeof ref === 'string' ? DEF_REF.exec(ref)?.[1] : undefined;
    return name === undefined ? undefined : versionTagOf(source.defs[name]);
  });
}

/** The definitions that `roots` reach through $ref, the roots included. */
export function reachable(defs: JsonObject, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (value: Json): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && typeof child === 'string') {
          const name = DEF_REF.exec(child)?.[1];
          if (name === undefined || !Object.hasOwn(defs, name)) fail(`unresolved reference ${child}`);
          if (!seen.has(name)) {
            seen.add(name);
            visit(defs[name] ?? null);
          }
        } else {
          visit(child);
        }
      }
    }
  };
  for (const root of roots) {
    if (!Object.hasOwn(defs, root)) fail(`unknown definition ${root}`);
    seen.add(root);
    visit(defs[root] ?? null);
  }
  return [...seen].sort();
}

export interface RoleBundle extends Bundle {
  /** Every definition of every shared and role schema, with local references: the source of the derived schemas. */
  readonly all: JsonObject;
}

/**
 * Bundle the shared and role schemas into one document with local references, then keep what the four role
 * contracts reach. Definition names must be unique across both directories, as in the shared generator.
 */
export function bundleRoleSchemas(sources: readonly SchemaFile[]): RoleBundle {
  const parsed = sources.map(parseSource);
  const documents = new Map(parsed.map((source) => [source.id, source]));
  if (documents.size !== parsed.length) fail('two schemas share an $id');
  const defs = new Map<string, Json>();
  const add = (name: string, schema: Json, file: string) => {
    if (defs.has(name)) fail(`definition name collision: ${name} (${file})`);
    defs.set(name, schema);
  };
  const roles = new Map<string, Parsed>();
  for (const source of parsed) {
    for (const [name, def] of Object.entries(source.defs))
      add(name, rewrite(def, source, documents), source.source.file);
    if (!source.isRoot) continue;
    const { $schema: _schema, $id: _id, $defs: _defs, ...root } = source.source.schema;
    add(source.title, rewrite(root, source, documents), source.source.file);
    if (source.source.directory === 'role') {
      roles.set(source.name, source);
      const versionTag = `${source.name}/${source.id.slice(source.id.lastIndexOf(':') + 1)}`;
      if (versionTags(source).some((tag) => tag !== versionTag)) {
        fail(`${source.source.file}: every form must fix schema_version to ${JSON.stringify(versionTag)}`);
      }
    }
  }
  const all = Object.fromEntries(defs);
  const rootTypes = ROLE_CONTRACTS.map((name) => {
    const role = roles.get(name);
    if (!role) fail(`the role contract ${name} has no root schema`);
    return role.title;
  });
  const kept = reachable(all, [...rootTypes, 'Decimal', 'Exact']);
  const definitions = Object.fromEntries(kept.map((name) => [name, all[name] as Json]));
  const contracts: Contract[] = ROLE_CONTRACTS.map((name) => {
    const role = roles.get(name) as Parsed;
    const bound = maxValues(definitions, { $ref: `#/$defs/${role.title}` });
    return {
      name,
      schemaId: role.id,
      versionTag: `${name}/${role.id.slice(role.id.lastIndexOf(':') + 1)}`,
      typeName: role.title,
      maxValues: Number.isFinite(bound) ? bound : null,
    };
  });
  const exact = definitions.Exact;
  const decimal = definitions.Decimal;
  const pattern = (def: Json | undefined, name: string): string => {
    const value = isObject(def) ? def.pattern : undefined;
    if (typeof value !== 'string') fail(`definition ${name} needs a string pattern`);
    return value;
  };
  const exactMaxLength = isObject(exact) ? exact.maxLength : undefined;
  if (typeof exactMaxLength !== 'number') fail('definition Exact needs maxLength');
  return {
    document: { $schema: DRAFT_2020_12, $id: BUNDLE_ID, title: 'OpenQuantRoleContracts', $defs: definitions },
    contracts,
    decimalPattern: pattern(decimal, 'Decimal'),
    exactPattern: pattern(exact, 'Exact'),
    exactMaxLength,
    all,
  };
}

/** The proposal forms of the proposer result: each is a oneOf branch, validated alone for a precise diagnostic. */
export const FORMULATION_BRANCHES = [
  'SeedTranslationProposal',
  'ControlledRevisionProposal',
  'NewFamilyProposal',
] as const;

/**
 * The same bundle with the three proposal forms as extra validator roots. A failing oneOf lists the first error of
 * every branch, so the diagnostic of a proposal is taken from the branch that its `proposal_kind` selects.
 */
export function withBranchValidators(bundle: RoleBundle): RoleBundle {
  const defs = bundle.document.$defs;
  if (!isObject(defs)) fail('the bundle has no definitions');
  const branches: Contract[] = FORMULATION_BRANCHES.map((typeName) => {
    if (!Object.hasOwn(defs, typeName)) fail(`the bundle has no definition ${typeName}`);
    return { name: `strategy-formulation.result#${typeName}`, schemaId: '', versionTag: '', typeName, maxValues: null };
  });
  return { ...bundle, contracts: [...bundle.contracts, ...branches] };
}

/**
 * The result schema of a role contract with everything it references, and nothing else: the schema that the
 * delegated executor receives (OQ-05 section 7). Its references are local, so it needs no other file.
 */
export function selfContainedSchema(bundle: RoleBundle, contract: string): JsonObject {
  const found = bundle.contracts.find((item) => item.name === contract);
  if (!found) fail(`unknown contract ${contract}`);
  const root = bundle.all[found.typeName];
  if (!isObject(root)) fail(`the root of ${contract} is not an object`);
  const names = reachable(bundle.all, [found.typeName]).filter((name) => name !== found.typeName);
  return {
    $schema: DRAFT_2020_12,
    ...root,
    $defs: Object.fromEntries(names.map((name) => [name, bundle.all[name] as Json])),
  };
}

export async function derivedDigest(schema: JsonObject): Promise<string> {
  return digest(schema);
}

export interface ManifestSkill {
  readonly id: string;
  readonly version: string;
  readonly role: 'proposer' | 'critic';
  readonly procedure: string;
  readonly request_contract: string;
  readonly result_contract: string;
}

export interface Manifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly id: string;
  readonly version: number;
  readonly methods: readonly never[];
  readonly skills: readonly ManifestSkill[];
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly derived: readonly { readonly name: string; readonly sha256: string }[];
}

export const PILOT_SKILLS: readonly ManifestSkill[] = [
  {
    id: 'strategy-formulation',
    version: '1',
    role: 'proposer',
    procedure: 'src/skills/strategy-formulation/procedure.md',
    request_contract: 'strategy-formulation.request/1',
    result_contract: 'strategy-formulation.result/1',
  },
  {
    id: 'strategy-critique',
    version: '1',
    role: 'critic',
    procedure: 'src/skills/strategy-critique/procedure.md',
    request_contract: 'strategy-critique.request/1',
    result_contract: 'strategy-critique.result/1',
  },
];

/** The shipped files: each skill's procedure and every role schema, sorted by path. */
export function shippedPaths(packageRoot: string, skills: readonly ManifestSkill[]): string[] {
  const schemas = readdirSync(resolve(packageRoot, 'schemas'))
    .filter((file) => file.endsWith('.schema.json'))
    .map((file) => `schemas/${file}`);
  return [...skills.map((skill) => skill.procedure), ...schemas].sort();
}

export function fileDigest(packageRoot: string, path: string): string {
  return sha256(readFileSync(resolve(packageRoot, path)));
}

export async function derivedEntries(bundle: RoleBundle): Promise<{ name: string; sha256: string }[]> {
  const entries: { name: string; sha256: string }[] = [];
  for (const contract of RESULT_CONTRACTS) {
    const found = bundle.contracts.find((item) => item.name === contract);
    entries.push({
      name: found?.versionTag ?? fail(`unknown contract ${contract}`),
      sha256: await derivedDigest(selfContainedSchema(bundle, contract)),
    });
  }
  return entries;
}

export function manifestText(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export { canonicalJson };
