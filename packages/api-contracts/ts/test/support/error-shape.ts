// The invalid document of a contract whose violation listing creates the most Ajv errors per value:
// copies of the value with the most errors among the values inside an array (error-bound.ts
// worstItem), the only values a document can repeat. For an object that is `{}`, which misses
// every required property of every schema applied to it. A contract without an array gets copies of
// 0 under one extra key instead, which costs one error in all.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ContractName, contracts } from '../../src/index.ts';
import { errorBound, type ValueBound } from './error-bound.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const bundlePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/generated/bundle.json');

/** The bundled schema definitions (tools/generate.ts). */
export function bundleDefs(): { [key: string]: Json } {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as { $defs: { [key: string]: Json } };
  return bundle.$defs;
}

const PROBES: Readonly<Record<string, string>> = {
  object: '{}',
  array: '[]',
  string: '""',
  integer: '0',
  boolean: 'true',
  null: 'null',
};

export interface ErrorShape {
  readonly bound: ValueBound;
  /** The text before the first item, ending in the array's `[`. */
  readonly open: string;
  /** One item. */
  readonly item: string;
  /** The text after the last item, ending in the root's `}`. */
  readonly close: string;
  /** The values of the document without items. */
  readonly skeleton: number;
}

function countValues(value: Json): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((sum, item) => sum + countValues(item), 0);
  if (typeof value === 'object' && value !== null) {
    return 1 + Object.values(value).reduce<number>((sum, item) => sum + countValues(item), 0);
  }
  return 1;
}

export function errorShape(contract: ContractName, defs = bundleDefs()): ErrorShape {
  const { typeName, versionTag } = contracts[contract];
  const bound = errorBound(defs, typeName);
  const worst = bound.worstItem;
  const path = worst === undefined ? ['*', '[]'] : worst.path;
  let open = `{"schema_version":${JSON.stringify(versionTag)}`;
  let close = '}';
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (segment === '[]') {
      // An item on the way to the site: one object holds the rest of the path.
      if (index < path.length - 1) {
        open += '[{';
        close = `}]${close}`;
      }
      continue;
    }
    const key = JSON.stringify(segment === '*' ? 'unlisted' : segment);
    const separator = open.endsWith('{') ? '' : ',';
    if (index === path.length - 2) {
      open += `${separator}${key}:[`;
      close = `]${close}`;
      break;
    }
    if (path[index + 1] === '[]') {
      open += `${separator}${key}:`;
    } else {
      open += `${separator}${key}:{`;
      close = `}${close}`;
    }
  }
  const item = worst === undefined ? '0' : (PROBES[worst.kind] ?? '0');
  const skeleton = countValues(JSON.parse(`${open}${close}`) as Json);
  return { bound, open, item, close, skeleton };
}

/** The shape's text with `values` values in all. */
export function errorShapeText(shape: ErrorShape, values: number): string {
  const items = values - shape.skeleton;
  if (items < 0) throw new Error(`the shape needs at least ${shape.skeleton} values`);
  return `${shape.open}${Array(items).fill(shape.item).join(',')}${shape.close}`;
}
