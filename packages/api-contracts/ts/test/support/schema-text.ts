// What the schemas allow in object keys and strings, derived from the bundled schema (OQ-05 §7).
//
// test/keys.test.ts checks that every contract admits only declared property names, so the key limit
// of limits.ts never refuses a valid document. test/result.test.ts bounds the decoded text of a valid
// result head against the text bound of result.ts. Both analyses over-approximate: they may call a
// schema open or unbounded that is not, never the reverse.

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json;
}

const DEF_REF = /^#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/;

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolve(defs: JsonObject, ref: Json): [string, Json] {
  const name = typeof ref === 'string' ? DEF_REF.exec(ref)?.[1] : undefined;
  if (name === undefined || !Object.hasOwn(defs, name)) throw new Error(`unresolved reference ${String(ref)}`);
  return [name, defs[name] ?? null];
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Every property name that a schema in the bundle declares. */
export function declaredNames(defs: JsonObject): Set<string> {
  const names = new Set<string>();
  const walk = (node: Json): void => {
    if (Array.isArray(node)) for (const item of node) walk(item);
    else if (isObject(node)) {
      if (isObject(node.properties)) for (const name of Object.keys(node.properties)) names.add(name);
      for (const child of Object.values(node)) walk(child);
    }
  };
  walk(defs);
  return names;
}

function literalKeysDeclared(value: Json, names: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.every((item) => literalKeysDeclared(item, names));
  if (isObject(value)) {
    return Object.entries(value).every(([key, item]) => names.has(key) && literalKeysDeclared(item, names));
  }
  return true;
}

/**
 * True when every document valid against `schema` holds only object keys from `names`. A schema
 * meets this through any keyword that every valid document must satisfy: a type without object or
 * array; a closed object, additionalProperties false without patternProperties, whose properties
 * all meet it; an array whose items meet it; a $ref, an allOf part, an enum or a const that meets
 * it; or a oneOf or anyOf whose branches all meet it. A definition being checked is assumed to meet
 * it: a finite document reaches a recursive definition only finitely often.
 */
export function onlyDeclaredKeys(
  defs: JsonObject,
  schema: Json,
  names: ReadonlySet<string>,
  checking: ReadonlySet<string> = new Set(),
): boolean {
  if (schema === false) return true;
  if (!isObject(schema)) return false;
  const holds = (child: Json) => onlyDeclaredKeys(defs, child, names, checking);
  if (typeof schema.$ref === 'string') {
    const [name, target] = resolve(defs, schema.$ref);
    if (checking.has(name) || onlyDeclaredKeys(defs, target, names, new Set([...checking, name]))) return true;
  }
  if (Array.isArray(schema.enum) && schema.enum.every((literal) => literalKeysDeclared(literal, names))) return true;
  if (Object.hasOwn(schema, 'const') && literalKeysDeclared(schema.const ?? null, names)) return true;
  if (Array.isArray(schema.allOf) && schema.allOf.some(holds)) return true;
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0 && branches.every(holds)) return true;
  }
  if (schema.type === undefined) return false;
  const types = Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type)];
  return types.every((type) => {
    if (type === 'object') {
      const properties = isObject(schema.properties) ? schema.properties : {};
      return (
        schema.additionalProperties === false &&
        schema.patternProperties === undefined &&
        Object.values(properties).every(holds)
      );
    }
    if (type === 'array') return schema.prefixItems === undefined && schema.items !== undefined && holds(schema.items);
    return true;
  });
}

/**
 * The most UTF-8 bytes of text that a regular expression of the form `^…$` matches, or Infinity. It
 * reads literal characters, escapes and bracket classes, each with an optional `?`, `{n}` or `{m,n}`;
 * any other construct gives Infinity. A class or escape counts the bytes of its longest member: one
 * for an ASCII-only class, four otherwise.
 */
export function patternMaxBytes(pattern: string): number {
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) return Number.POSITIVE_INFINITY;
  const body = pattern.slice(1, -1);
  let total = 0;
  let index = 0;
  while (index < body.length) {
    const char = body[index] ?? '';
    let atom: number;
    if (char === '[') {
      let close = index + 1;
      while (close < body.length && body[close] !== ']') close += body[close] === '\\' ? 2 : 1;
      if (close >= body.length) return Number.POSITIVE_INFINITY;
      const members = body.slice(index + 1, close);
      // A class of ASCII members without a class escape or negation matches one byte.
      atom = /^[\x20-\x7e]*$/.test(members) && !members.startsWith('^') && !/\\[pPuxdDwWsS]/.test(members) ? 1 : 4;
      index = close + 1;
    } else if (char === '\\') {
      const escaped = body[index + 1] ?? '';
      atom = /^[.\-/\\^$|?*+()[\]{}0-9]$/.test(escaped) || escaped === 'd' ? 1 : 4;
      if (/^[pPux]$/.test(escaped)) return Number.POSITIVE_INFINITY;
      index += 2;
    } else if ('()|*+.{}?'.includes(char)) {
      return Number.POSITIVE_INFINITY;
    } else {
      atom = utf8Bytes(char);
      index += 1;
    }
    let times = 1;
    const quantifier = /^(?:\?|\{([0-9]+)(?:,([0-9]+))?\})/.exec(body.slice(index));
    if (quantifier !== null) {
      times = quantifier[0] === '?' ? 1 : Number(quantifier[2] ?? quantifier[1]);
      index += quantifier[0].length;
    } else if (index < body.length && '*+{'.includes(body[index] ?? '')) {
      return Number.POSITIVE_INFINITY;
    }
    total += atom * times;
  }
  return total;
}

function literalText(value: Json): number {
  if (typeof value === 'string') return utf8Bytes(value);
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + literalText(item), 0);
  if (isObject(value)) {
    return Object.entries(value).reduce<number>((sum, [key, item]) => sum + utf8Bytes(key) + literalText(item), 0);
  }
  return 0;
}

/**
 * The most decoded UTF-8 bytes of the strings and object keys that a document valid against
 * `schema` holds, or Infinity. As in maxValues (tools/generate.ts): an object counts every property
 * as present, name and value, and is bounded only when closed; an array counts maxItems items; a
 * string is bounded by maxLength, at four bytes a code point, or by its pattern; enum and const count
 * their longest literal; $ref, type, enum, const and each allOf part each bound a value and the
 * smallest bound holds; oneOf and anyOf take their largest branch; a recursive schema is unbounded.
 */
export function maxText(defs: JsonObject, schema: Json, stack: readonly string[] = []): number {
  if (schema === true) return Number.POSITIVE_INFINITY;
  if (schema === false) return 0;
  if (!isObject(schema)) throw new Error(`a schema must be an object or a boolean: ${JSON.stringify(schema)}`);
  let bound = Number.POSITIVE_INFINITY;
  if (typeof schema.$ref === 'string') {
    const [name, target] = resolve(defs, schema.$ref);
    if (stack.includes(name)) return Number.POSITIVE_INFINITY;
    bound = Math.min(bound, maxText(defs, target, [...stack, name]));
  }
  if (Array.isArray(schema.enum)) bound = Math.min(bound, Math.max(...schema.enum.map(literalText)));
  if (Object.hasOwn(schema, 'const')) bound = Math.min(bound, literalText(schema.const ?? null));
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    let typed = 0;
    for (const type of types) {
      if (type === 'object') {
        const closed = schema.additionalProperties === false && schema.patternProperties === undefined;
        const properties = isObject(schema.properties) ? Object.entries(schema.properties) : [];
        typed = Math.max(
          typed,
          closed
            ? properties.reduce<number>(
                (sum, [name, property]) => sum + utf8Bytes(name) + maxText(defs, property, stack),
                0,
              )
            : Number.POSITIVE_INFINITY,
        );
      } else if (type === 'array') {
        const { maxItems, items } = schema;
        const bounded = typeof maxItems === 'number' && items !== undefined && schema.prefixItems === undefined;
        typed = Math.max(
          typed,
          bounded ? (maxItems === 0 ? 0 : maxItems * maxText(defs, items, stack)) : Number.POSITIVE_INFINITY,
        );
      } else if (type === 'string') {
        const byLength = typeof schema.maxLength === 'number' ? schema.maxLength * 4 : Number.POSITIVE_INFINITY;
        const byPattern =
          typeof schema.pattern === 'string' ? patternMaxBytes(schema.pattern) : Number.POSITIVE_INFINITY;
        typed = Math.max(typed, Math.min(byLength, byPattern));
      }
    }
    bound = Math.min(bound, typed);
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches))
      bound = Math.min(bound, Math.max(...branches.map((branch) => maxText(defs, branch, stack))));
  }
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) bound = Math.min(bound, maxText(defs, part, stack));
  return bound;
}
