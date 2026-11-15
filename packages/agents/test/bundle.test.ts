// The behaviour bundle (OQ-03 section 3): an exact allowlist of paths and content hashes, a generated module with the
// shipped text and the bundle hash, and a build that refuses any difference between the manifest and the files.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, test } from 'vitest';
import { byContract } from '../dist/generated/validators-first.js';
import {
  BUNDLE_HASH,
  BUNDLE_ID,
  BUNDLE_VERSION,
  DERIVED,
  FILES,
  MANIFEST_TEXT,
  PROCEDURES,
  RESULT_SCHEMAS,
  SUPPLIED_METHODS,
} from '../src/index.ts';
import { bundleCheck } from '../tools/bundle-check.ts';
import { bundleRoleSchemas, readSchemas, selfContainedSchema } from '../tools/bundle-lib.ts';
import { verifiedManifest } from '../tools/generate.ts';
import { packageRoot, sha256File, sha256Text } from './support/oracle.ts';
import { critiqueOutput, finding, revisionOutput } from './support/requests.ts';

// The bundle hash is the SHA-256 of the manifest bytes. Any change of a shipped file, of the file list or of a derived
// result schema changes it, through a reviewed `bundle:update`. This golden value pins the reviewed bundle: a change
// to it is a change of behaviour that needs the same review as a change of the engine (OQ-03 section 6, OQ-02 section 7).
const GOLDEN_BUNDLE_HASH = 'sha256:b5188bec9e95a3481dc2ece0c7f5729ac62baef18aee1208324a6563029f72a6';

interface Manifest {
  format: string;
  id: string;
  version: number;
  methods: unknown[];
  skills: { id: string; role: string; procedure: string; request_contract: string; result_contract: string }[];
  files: { path: string; sha256: string }[];
  derived: { name: string; sha256: string }[];
}

const manifestBytes = readFileSync(resolve(packageRoot, 'bundle.manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest;

describe('the manifest and the generated module', () => {
  test('the bundle hash is the SHA-256 of the manifest bytes and equals the reviewed golden value', () => {
    expect(BUNDLE_HASH).toBe(sha256Text(manifestBytes.toString('utf8')));
    expect(BUNDLE_HASH).toBe(GOLDEN_BUNDLE_HASH);
    expect(MANIFEST_TEXT).toBe(manifestBytes.toString('utf8'));
  });

  test('is the baseline bundle with no method note', () => {
    expect(manifest.format).toBe('openquant-agent-bundle/1');
    expect([BUNDLE_ID, BUNDLE_VERSION]).toEqual(['baseline', 1]);
    expect(manifest.methods).toEqual([]);
    expect(SUPPLIED_METHODS).toEqual([]);
    expect(manifest.files.some((file) => file.path.startsWith('src/methods/'))).toBe(false);
  });

  test('lists the two procedures and the five role schemas, sorted and unique', () => {
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toEqual([
      'schemas/role-common.schema.json',
      'schemas/strategy-critique.request.schema.json',
      'schemas/strategy-critique.result.schema.json',
      'schemas/strategy-formulation.request.schema.json',
      'schemas/strategy-formulation.result.schema.json',
      'src/skills/strategy-critique/procedure.md',
      'src/skills/strategy-formulation/procedure.md',
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('records the SHA-256 of each file as it is on disk', () => {
    for (const file of manifest.files) expect(file.sha256, file.path).toBe(sha256File(resolve(packageRoot, file.path)));
    expect(FILES).toEqual(manifest.files);
  });

  test('inlines the procedure text exactly', () => {
    for (const skill of manifest.skills) {
      expect(PROCEDURES[skill.id as keyof typeof PROCEDURES], skill.id).toBe(
        readFileSync(resolve(packageRoot, skill.procedure), 'utf8'),
      );
    }
  });

  test('holds no evaluation material, no method rule and no link in the shipped text', () => {
    for (const text of Object.values(PROCEDURES)) {
      expect(text).not.toMatch(/\b[A-Z]{3,}-\d{2}\b/);
      expect(text).not.toMatch(/\bS[FC]-\d{2}\b|evals\/|fixtures\/agent-results/);
      expect(text).not.toMatch(/\]\(/);
      expect(text).not.toMatch(/^\s*>/m);
    }
  });

  test('records the digest of each derived result schema', () => {
    expect(DERIVED).toEqual(manifest.derived);
    expect(manifest.derived.map((item) => item.name)).toEqual([
      'strategy-formulation.result/1',
      'strategy-critique.result/1',
    ]);
  });

  test('is not stale: the build accepts the manifest against the files and the shared schemas', async () => {
    const bundle = bundleRoleSchemas(readSchemas(packageRoot));
    const verified = await verifiedManifest(packageRoot, bundle);
    expect(sha256Text(Buffer.from(verified.bytes).toString('utf8'))).toBe(BUNDLE_HASH);
  });
});

describe('a manifest that does not match the files fails the build', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  // A copy of the package files that the build reads, beside a copy of the shared schemas.
  function copy(): string {
    const base = mkdtempSync(resolve(tmpdir(), 'openquant-bundle-'));
    directories.push(base);
    const root = resolve(base, 'packages/agents');
    mkdirSync(resolve(root, 'src/skills'), { recursive: true });
    cpSync(resolve(packageRoot, 'schemas'), resolve(root, 'schemas'), { recursive: true });
    cpSync(resolve(packageRoot, 'src/skills'), resolve(root, 'src/skills'), { recursive: true });
    cpSync(resolve(packageRoot, '../api-contracts/schemas'), resolve(base, 'packages/api-contracts/schemas'), {
      recursive: true,
    });
    writeFileSync(resolve(root, 'bundle.manifest.json'), manifestBytes);
    return root;
  }

  const check = async (root: string) => verifiedManifest(root, bundleRoleSchemas(readSchemas(root)));
  const edit = (root: string, path: string, change: (text: string) => string) =>
    writeFileSync(resolve(root, path), change(readFileSync(resolve(root, path), 'utf8')));

  test('the copy itself passes', async () => {
    await expect(check(copy())).resolves.toBeDefined();
  });

  test('a missing manifest', async () => {
    const root = copy();
    rmSync(resolve(root, 'bundle.manifest.json'));
    await expect(check(root)).rejects.toThrow(/bundle\.manifest\.json is missing/);
  });

  test('a changed procedure', async () => {
    const root = copy();
    edit(root, 'src/skills/strategy-critique/procedure.md', (text) => `${text}\nOne more line.\n`);
    await expect(check(root)).rejects.toThrow(
      /src\/skills\/strategy-critique\/procedure\.md changed after bundle\.manifest\.json recorded it/,
    );
  });

  test('a changed role schema', async () => {
    const root = copy();
    edit(root, 'schemas/strategy-critique.result.schema.json', (text) =>
      text.replace('"maxItems": 64', '"maxItems": 65'),
    );
    await expect(check(root)).rejects.toThrow(/schemas\/strategy-critique\.result\.schema\.json changed/);
  });

  test('an unlisted file among the shipped files', async () => {
    const root = copy();
    writeFileSync(
      resolve(root, 'schemas/extra.schema.json'),
      '{"$id":"urn:openquant:schema:extra:1","title":"Extra","$defs":{}}\n',
    );
    await expect(check(root)).rejects.toThrow(/the listed files differ from the shipped files/);
  });

  test('a listed file that is gone', async () => {
    const root = copy();
    rmSync(resolve(root, 'src/skills/strategy-formulation/procedure.md'));
    await expect(check(root)).rejects.toThrow(/ENOENT/);
  });

  test('a role schema that is gone breaks the schema bundle', async () => {
    const root = copy();
    rmSync(resolve(root, 'schemas/role-common.schema.json'));
    await expect(check(root)).rejects.toThrow(/unknown schema in reference/);
  });

  test('a method note in the manifest', async () => {
    const root = copy();
    edit(root, 'bundle.manifest.json', (text) => text.replace('"methods": []', '"methods": ["CHAN-01"]'));
    await expect(check(root)).rejects.toThrow(/adopts no method note/);
  });

  test('another set of skills', async () => {
    const root = copy();
    edit(root, 'bundle.manifest.json', (text) => text.replace('"id": "strategy-critique"', '"id": "strategy-sizing"'));
    await expect(check(root)).rejects.toThrow(/exactly the two pilot role modules/);
  });

  test('a change of a shared schema that a result schema reaches changes the derived digest', async () => {
    const root = copy();
    const shared = resolve(root, '../api-contracts/schemas/strategy-artefact.schema.json');
    const schema = JSON.parse(readFileSync(shared, 'utf8')) as { $defs: { TextList: { maxItems: number } } };
    schema.$defs.TextList.maxItems = 31;
    writeFileSync(shared, `${JSON.stringify(schema, null, 2)}\n`);
    await expect(check(root)).rejects.toThrow(/a derived result schema changed/);
  });
});

describe('the derived result schemas that the executor receives', () => {
  const names = ['strategy-formulation.result', 'strategy-critique.result'] as const;
  const bundle = bundleRoleSchemas(readSchemas(packageRoot));

  test.each(names)('%s is self-contained: no urn reference, every local reference defined, no $id', (name) => {
    const schema = RESULT_SCHEMAS[name] as unknown as Record<string, unknown>;
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/urn:/);
    expect(schema.$id).toBeUndefined();
    const defs = schema.$defs as Record<string, unknown>;
    const references = [...text.matchAll(/"\$ref":"([^"]+)"/g)].map((match) => match[1] as string);
    expect(references.length).toBeGreaterThan(4);
    for (const reference of references) {
      expect(reference, reference).toMatch(/^#\/\$defs\/[A-Za-z0-9]+$/);
      expect(Object.hasOwn(defs, reference.slice('#/$defs/'.length)), reference).toBe(true);
    }
  });

  test.each(names)('%s equals the schema that the tools derive, and keeps only what it reaches', (name) => {
    expect(RESULT_SCHEMAS[name]).toEqual(selfContainedSchema(bundle, name));
    const defs = Object.keys((RESULT_SCHEMAS[name] as unknown as { $defs: object }).$defs);
    expect(defs.includes('Expr')).toBe(name === 'strategy-formulation.result');
    expect(defs).not.toContain('AgentDispatch');
    expect(defs).not.toContain('CohortPolicy');
  });

  // The generated validators and the self-contained schema, compiled by an independent validator, give one verdict.
  const ajv = new Ajv2020({ strict: true, allErrors: false, unicodeRegExp: true });
  const validators = new Map(names.map((name) => [name, ajv.compile(RESULT_SCHEMAS[name] as unknown as object)]));

  test('they agree on valid and invalid proposer and critic results', async () => {
    const valid = await revisionOutput();
    const cases: [(typeof names)[number], unknown][] = [
      ['strategy-formulation.result', valid],
      ['strategy-formulation.result', { ...valid, approved: true }],
      ['strategy-formulation.result', { ...valid, rule_changes: [] }],
      ['strategy-formulation.result', { ...valid, parent_hash: 'sha256:xyz' }],
      [
        'strategy-formulation.result',
        { ...valid, strategy: { ...(valid.strategy as object), operator_set: 'other@1' } },
      ],
      ['strategy-formulation.result', { ...valid, proposal_kind: 'new_family' }],
      ['strategy-critique.result', critiqueOutput(finding())],
      ['strategy-critique.result', critiqueOutput()],
      ['strategy-critique.result', critiqueOutput(finding({ category: 'lookahead_bias' }))],
      ['strategy-critique.result', critiqueOutput(finding({ approved: true }))],
      ['strategy-critique.result', critiqueOutput(finding({ location: { area: 'holdout' } }))],
      ['strategy-critique.result', { ...critiqueOutput(), schema_version: 'strategy-critique.result/2' }],
    ];
    const verdicts = cases.map(([name, value]) => [validators.get(name)?.(value), byContract[name](value)]);
    for (const [independent, generated] of verdicts) expect(independent).toBe(generated);
    expect(verdicts.filter(([verdict]) => verdict === true)).toHaveLength(3);
  });
});

describe('the Worker bundle', () => {
  test('src bundles for the neutral platform with no Node import, no third-party dependency and no code generation', async () => {
    const result = await bundleCheck(resolve(packageRoot, 'src/index.ts'));
    expect(result.problems).toEqual([]);
    expect(result.code.length).toBeGreaterThan(10_000);
  });
});
