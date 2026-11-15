// The Worker bundle check (tools/bundle-check.ts): the live entry passes, and sources that a Worker cannot run fail.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { bundleCheck, inputProblems, packageOf } from '../tools/bundle-check.ts';

const api = resolve(fileURLToPath(import.meta.url), '../..');
const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

async function checkSource(files: Record<string, string>): Promise<readonly string[]> {
  const directory = mkdtempSync(join(tmpdir(), 'oq-bundle-'));
  scratch.push(directory);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(resolve(directory, name, '..'), { recursive: true });
    writeFileSync(resolve(directory, name), text);
  }
  return (await bundleCheck(resolve(directory, 'worker.ts'), directory)).problems;
}

describe('the Worker bundle', () => {
  it('bundles src/worker.ts with Hono inside, pg as its one import and nothing from Node', async () => {
    const { problems, code } = await bundleCheck(resolve(api, 'src/worker.ts'));
    expect(problems).toEqual([]);
    const imports = [...code.matchAll(/^import .* from "([^"]+)";?$/gm)].map((match) => match[1]);
    expect(imports).toEqual(['pg']);
    expect(code).toContain('x-content-type-options');
    expect(code).not.toMatch(/from "node:/);
    // The route manifest is inside the bundle: the Worker reads no file.
    expect(code).toContain('api-route-manifest/1');
  });

  it('refuses a source that imports a Node module, with or without the node: prefix', async () => {
    for (const specifier of ['node:fs', 'fs', 'node:crypto', 'child_process']) {
      const problems = await checkSource({ 'worker.ts': `import { x } from '${specifier}';\nexport default x;\n` });
      expect(problems.length, specifier).toBeGreaterThan(0);
    }
  });

  it('refuses a source that uses a Node-only name, or compiles code at run time', async () => {
    expect(await checkSource({ 'worker.ts': `export default process.env.SECRET;\n` })).toEqual([
      expect.stringContaining('uses a Node-only name: process.'),
    ]);
    expect(await checkSource({ 'worker.ts': `export default Buffer.from('x');\n` })).toEqual([
      expect.stringContaining('uses a Node-only name: Buffer'),
    ]);
    const evaluated = await checkSource({ 'worker.ts': `export default eval('1 + 1');\n` });
    expect(evaluated.join('\n')).toContain('compiles code at run time');
    const compiled = await checkSource({ 'worker.ts': `export default new Function('return 1');\n` });
    expect(compiled.join('\n')).toContain('compiles code at run time');
  });

  it('allows pg and the Workers runtime modules as imports, and refuses a file that it cannot resolve', async () => {
    expect(
      await checkSource({ 'worker.ts': `import 'pg';\nimport 'cloudflare:sockets';\nexport default 1;\n` }),
    ).toEqual([]);
    const unresolved = await checkSource({ 'worker.ts': `import x from './missing.ts';\nexport default x;\n` });
    expect(unresolved[0]).toMatch(/^esbuild: Could not resolve/);
  });

  it('accepts a plain Worker source', async () => {
    expect(
      await checkSource({
        'worker.ts': `import { x } from './x.ts';\nexport default { fetch: () => new Response(String(x)) };\n`,
        'x.ts': 'export const x = 1;\n',
      }),
    ).toEqual([]);
  });

  it('names the package of an installed file, and allows Hono and nothing else', () => {
    expect(packageOf('../../node_modules/.pnpm/hono@4.13.15/node_modules/hono/dist/hono.js')).toBe('hono');
    expect(packageOf('../../node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/index.js')).toBe('@scope/pkg');
    expect(packageOf('src/app.ts')).toBeUndefined();
    expect(packageOf('../../packages/api-contracts/ts/src/index.ts')).toBeUndefined();
    expect(inputProblems(['node_modules/.pnpm/hono@4.13.15/node_modules/hono/dist/hono.js', 'src/app.ts'])).toEqual([]);
    expect(inputProblems(['node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/ajv.js'])).toEqual([
      'the bundle includes a dependency that is not allowed: ajv',
    ]);
    expect(inputProblems(['node:fs'])).toEqual(['the bundle includes the Node module node:fs']);
  });
});
