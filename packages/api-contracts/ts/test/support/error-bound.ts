// Upper bounds on the work of the generated Ajv validators per JSON value, derived from the bundled
// schema (OQ-05 §7). test/errors.test.ts checks them against the validators and against the
// listing threshold MAX_LISTED_VALUES.
//
// The schemas applied to a value depend only on the schemas applied to its parent and on the key or
// index that leads to it. A schema applies to a value through its parent's properties,
// additionalProperties, items or contains, and through $ref, oneOf, anyOf, allOf and not on the
// value itself. A schema under `not` is silent: Ajv runs it but keeps none of its errors. The
// analysis walks these multisets from the contract root: a definition reached through two branches
// is validated twice and counts twice. Each distinct multiset is expanded once, so the walk ends
// when they repeat. It ends for every contract: the only recursive definition, Expr, is reached
// through no oneOf, anyOf, allOf or not, so its multiset does not grow with depth. If a schema change
// made a multiset grow without end, the walk would fail at MAX_APPLICATIONS.
//
// For one value, an all-errors validator creates at most, per applied schema that is not silent:
// - one type error if the value does not have the schema's type, and then none of the type-specific
//   errors below;
// - otherwise one error per required property (all may be missing), and one each for minItems,
//   maxItems, contains, minLength, maxLength, pattern, minimum and maximum, when the value has the
//   keyword's type;
// - whatever the type, one each for enum, const, not, oneOf and anyOf. Their branches are applied
//   schemas of their own and count their own errors;
// - and an error about an extra property, which Ajv reports on the parent, counts against that
//   property's value: one per parent schema with additionalProperties false and no property of that
//   name.
// Any other keyword makes the analysis fail, so a new keyword cannot slip past the bound.

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json;
}

/** Applied schemas past which the analysis reports a multiset that grows without end. */
export const MAX_APPLICATIONS = 10_000;

const KINDS = ['object', 'array', 'string', 'integer', 'boolean', 'null'] as const;
type Kind = (typeof KINDS)[number];

const ANNOTATIONS = new Set(['title', 'description']);
const ONE_ERROR: Readonly<Record<string, Kind | 'any'>> = {
  enum: 'any',
  const: 'any',
  not: 'any',
  oneOf: 'any',
  anyOf: 'any',
  minItems: 'array',
  maxItems: 'array',
  contains: 'array',
  minLength: 'string',
  maxLength: 'string',
  pattern: 'string',
  minimum: 'integer',
  maximum: 'integer',
};
// Keywords with no error of their own: they apply schemas, which count their own, or modify another
// keyword (minContains sets the count of the contains error).
const STRUCTURAL = new Set([
  '$ref',
  'type',
  'properties',
  'additionalProperties',
  'items',
  'allOf',
  'required',
  'minContains',
]);

export interface ValueBound {
  /** The most errors one value can carry under the all-errors validator. */
  readonly errorsPerValue: number;
  /**
   * The most schemas applied to one value, silent ones included. Every validator call is one
   * application of a referenced definition, so a document of v values makes at most
   * v × applicationsPerValue calls, in either validator, at any depth.
   */
  readonly applicationsPerValue: number;
  /** Distinct multisets of applied schemas the walk expanded. */
  readonly states: number;
  /** A value with errorsPerValue errors: its path (`*` is any other key, `[]` an item) and type. */
  readonly worstValue: string;
  /**
   * The value with the most errors among those inside an array, the only values a document can
   * repeat: its path segments and type, and its bound. Undefined when the contract has no array.
   */
  readonly worstItem: { readonly path: readonly string[]; readonly kind: Kind; readonly errors: number } | undefined;
}

interface Applied {
  readonly schema: JsonObject;
  readonly silent: boolean;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`error bound: ${message}`);
}

function typesOf(schema: JsonObject): readonly string[] | undefined {
  const { type } = schema;
  if (type === undefined) return undefined;
  return Array.isArray(type) ? type.map(String) : [String(type)];
}

function hasType(schema: JsonObject, kind: Kind): boolean {
  const types = typesOf(schema);
  return types === undefined || types.includes(kind) || (kind === 'integer' && types.includes('number'));
}

function ownErrors(schema: JsonObject, kind: Kind): number {
  const matches = hasType(schema, kind);
  let errors = matches ? 0 : 1;
  for (const [keyword, applies] of Object.entries(ONE_ERROR)) {
    if (schema[keyword] !== undefined && (applies === 'any' || (matches && applies === kind))) errors += 1;
  }
  if (matches && kind === 'object' && Array.isArray(schema.required)) errors += schema.required.length;
  return errors;
}

/** The bounds for the contract whose root definition is `rootName` in the bundle's `defs`. */
export function errorBound(defs: JsonObject, rootName: string): ValueBound {
  const ids = new Map<JsonObject, number>();
  const idOf = ({ schema, silent }: Applied) => {
    let id = ids.get(schema);
    if (id === undefined) {
      id = ids.size;
      ids.set(schema, id);
    }
    return silent ? -1 - id : id;
  };
  const asSchema = (schema: Json | undefined): JsonObject => {
    if (!isObject(schema)) fail(`only object schemas are supported: ${JSON.stringify(schema)}`);
    for (const key of Object.keys(schema)) {
      if (!ANNOTATIONS.has(key) && !STRUCTURAL.has(key) && !Object.hasOwn(ONE_ERROR, key)) {
        fail(`keyword ${key} is not covered by the bound`);
      }
    }
    return schema;
  };
  const resolveRef = (ref: Json): JsonObject => {
    const name = typeof ref === 'string' ? /^#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/.exec(ref)?.[1] : undefined;
    return asSchema(name === undefined ? undefined : defs[name]);
  };
  // Every schema applied to the same value as `applied`, with multiplicity.
  const closure = (applied: readonly Applied[]): Applied[] => {
    const out: Applied[] = [];
    const stack = [...applied];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      out.push(next);
      if (out.length > MAX_APPLICATIONS) fail(`more than ${MAX_APPLICATIONS} schemas apply to one value`);
      const { schema, silent } = next;
      if (schema.$ref !== undefined) stack.push({ schema: resolveRef(schema.$ref), silent });
      for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        const branches = schema[key];
        if (Array.isArray(branches)) for (const branch of branches) stack.push({ schema: asSchema(branch), silent });
      }
      if (schema.not !== undefined) stack.push({ schema: asSchema(schema.not), silent: true });
    }
    return out;
  };

  const seen = new Set<string>();
  let errorsPerValue = 0;
  let applicationsPerValue = 0;
  let worstValue = '';
  let worstItem: ValueBound['worstItem'];
  const pending: { applied: Applied[]; extra: number; path: readonly string[] }[] = [
    { applied: [{ schema: asSchema(defs[rootName]), silent: false }], extra: 0, path: [] },
  ];
  for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
    const ordered = state.applied.map(idOf).sort((a, b) => a - b);
    const key = `${state.extra}|${ordered.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const schemas = closure(state.applied);
    applicationsPerValue = Math.max(applicationsPerValue, schemas.length);
    const loud = schemas.filter((applied) => !applied.silent).map((applied) => applied.schema);
    for (const kind of KINDS) {
      const errors = state.extra + loud.reduce((sum, schema) => sum + ownErrors(schema, kind), 0);
      if (errors > errorsPerValue) {
        errorsPerValue = errors;
        worstValue = `/${state.path.join('/')} (${kind})`;
      }
      if (state.path.at(-1) === '[]' && errors > (worstItem?.errors ?? 0))
        worstItem = { path: state.path, kind, errors };
    }
    // The children of an object value: each named property, and any other key.
    const objects = schemas.filter((applied) => hasType(applied.schema, 'object'));
    const names = new Set<string>();
    for (const { schema } of objects) {
      if (isObject(schema.properties)) for (const name of Object.keys(schema.properties)) names.add(name);
    }
    for (const name of [...names, '*']) {
      const applied: Applied[] = [];
      let extra = 0;
      for (const { schema, silent } of objects) {
        const properties = isObject(schema.properties) ? schema.properties : {};
        if (name !== '*' && Object.hasOwn(properties, name))
          applied.push({ schema: asSchema(properties[name]), silent });
        else if (schema.additionalProperties === false) extra += silent ? 0 : 1;
        else if (schema.additionalProperties !== undefined) {
          applied.push({ schema: asSchema(schema.additionalProperties), silent });
        }
      }
      pending.push({ applied, extra, path: [...state.path, name] });
    }
    // The items of an array value: items and contains apply to each.
    const items: Applied[] = [];
    for (const { schema, silent } of schemas) {
      if (!hasType(schema, 'array')) continue;
      if (schema.items !== undefined) items.push({ schema: asSchema(schema.items), silent });
      if (schema.contains !== undefined) items.push({ schema: asSchema(schema.contains), silent });
    }
    if (items.length > 0) pending.push({ applied: items, extra: 0, path: [...state.path, '[]'] });
  }
  return { errorsPerValue, applicationsPerValue, states: seen.size, worstValue, worstItem };
}
