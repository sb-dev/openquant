// The schema bundle, the generated validators and the Worker bundle check.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { bundleCheck } from '../tools/bundle-check.ts';
import { bundleSchemas, type SchemaSource } from '../tools/generate.ts';
import { fixturesDir } from './support/manifest.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = (file: string) => readFileSync(resolve(packageRoot, 'dist/generated', file), 'utf8');

const common: SchemaSource = {
  file: 'common.schema.json',
  schema: {
    $id: 'urn:openquant:schema:common:1',
    title: 'Common',
    $defs: {
      Decimal: { type: 'string', pattern: '^[0-9]+$' },
      Exact: { type: 'string', maxLength: 80, pattern: '^[0-9/]+$' },
    },
  },
};

const root = (name: string, tag: string, properties: Record<string, unknown> = {}): SchemaSource => ({
  file: `${name}.schema.json`,
  schema: {
    $id: `urn:openquant:schema:${name}:1`,
    title: name.replace(/(^|-)([a-z])/g, (_m, _d, c: string) => c.toUpperCase()),
    type: 'object',
    properties: { schema_version: { type: 'string', enum: [tag] }, ...properties },
  } as SchemaSource['schema'],
});

describe('the schema bundle', () => {
  test('rewrites every reference to a local definition and names each root by its title', () => {
    const bundle = bundleSchemas([
      common,
      root('first', 'first/1', { price: { $ref: 'urn:openquant:schema:common:1#/$defs/Decimal' } }),
      root('second', 'second/1', { inner: { $ref: 'urn:openquant:schema:first:1' } }),
    ]);
    expect(bundle.contracts.map((c) => [c.name, c.versionTag, c.typeName])).toEqual([
      ['first', 'first/1', 'First'],
      ['second', 'second/1', 'Second'],
    ]);
    const defs = bundle.document.$defs as Record<string, { properties: Record<string, unknown> }>;
    expect(defs.First?.properties.price).toEqual({ $ref: '#/$defs/Decimal' });
    expect(defs.Second?.properties.inner).toEqual({ $ref: '#/$defs/First' });
    expect(bundle.exactMaxLength).toBe(80);
  });

  test.each<[string, SchemaSource[], RegExp]>([
    [
      'a definition name used twice',
      [
        common,
        {
          ...common,
          file: 'other.schema.json',
          schema: { ...(common.schema as object), $id: 'urn:openquant:schema:other:1' },
        },
      ],
      /collision: Decimal/,
    ],
    [
      'an unknown schema',
      [common, root('first', 'first/1', { x: { $ref: 'urn:openquant:schema:missing:1#/$defs/X' } })],
      /unknown schema/,
    ],
    [
      'a definition missing from the named schema',
      [common, root('first', 'first/1', { x: { $ref: 'urn:openquant:schema:common:1#/$defs/First' } })],
      /is not defined in common/,
    ],
    [
      'a deeper reference',
      [common, root('first', 'first/1', { x: { $ref: '#/$defs/A/properties/b' } })],
      /unsupported reference/,
    ],
    ['a version tag that does not match the $id', [common, root('first', 'first/2')], /schema_version to "first\/1"/],
    [
      'a file name that does not match the $id',
      [common, { ...root('first', 'first/1'), file: 'other.schema.json' }],
      /does not match/,
    ],
  ])('fails on %s', (_label, sources, message) => {
    expect(() => bundleSchemas(sources)).toThrow(message);
  });
});

describe('the generated validators', () => {
  test.each(['validators-first.js', 'validators-all.js'])('%s needs no module and compiles no code', (file) => {
    const code = generated(file);
    expect(code).not.toMatch(/\brequire\s*\(|\bimport\b/);
    expect(code).not.toMatch(/\bnew Function\b|\beval\s*\(/);
  });

  test('the types brand Exact', () => {
    expect(generated('types.ts')).toMatch(/^export type Exact = string & \{\s*readonly __brand: ["']Exact["']\s*\};$/m);
  });
});

describe('the Worker bundle check', () => {
  test('src/index.ts bundles for the neutral platform and runs on its own', async () => {
    const { problems, code } = await bundleCheck(resolve(packageRoot, 'src/index.ts'));
    expect(problems).toEqual([]);
    const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    const text = readFileSync(resolve(fixturesDir, 'protocol/valid/api-error.stale-ownership.json'), 'utf8');
    const result = module.parseContract('api-error', text);
    expect(result.ok).toBe(true);
    expect(await module.digest(result.value)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('rejects a Node import, a dependency and run-time code generation', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'openquant-bundle-'));
    try {
      const check = async (source: string) => {
        const entry = resolve(directory, 'entry.ts');
        writeFileSync(entry, source);
        return (await bundleCheck(entry)).problems.join('\n');
      };
      expect(await check("import { readFileSync } from 'node:fs'; export const f = readFileSync;")).toMatch(/node:fs/);
      expect(await check("export const f = new Function('return 1');")).toMatch(/compiles code at run time/);
      expect(await check('export const size = Buffer.byteLength("x");')).toMatch(/Node-only name: Buffer/);
      expect(
        await check(`export * from ${JSON.stringify(resolve(packageRoot, 'node_modules/ajv/dist/2020.js'))};`),
      ).toMatch(/dependency/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
