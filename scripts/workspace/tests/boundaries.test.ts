import test from 'node:test';
import assert from 'node:assert/strict';
import { root } from '../../repository.ts';
import { boundaryErrors, boundaryViolations, importSpecifiers } from '../boundaries.ts';

test('the live sources keep the import boundaries', () => assert.deepEqual(boundaryErrors(root), []));

test('import specifiers are read from every import form and not from comments', () => {
  const source = [
    "import { a } from './a.ts';",
    "import type { B } from '../b.ts';",
    "import {\n  c,\n  type D,\n} from 'c-package';",
    "import 'side-effect';",
    "export * from './e.ts';",
    "export { f } from \"./f.ts\";",
    "const g = await import('./g.ts');",
    "const h = require('h');",
    "// import { x } from 'node:fs';",
    "/* import 'node:child_process'; */",
    "export const text = 'from here';",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), ['./a.ts', '../b.ts', 'c-package', 'side-effect', './e.ts', './f.ts', './g.ts', 'h']);
});

test('the CLI and the API client cannot import apps/api', () => {
  assert.match(boundaryViolations('apps/cli/src/main.tsx', "import { app } from '../../api/src/app.ts';").join('\n'), /client code reaches the API only through Hono\): apps\/cli\/src\/main\.tsx imports apps\/api/);
  assert.match(boundaryViolations('packages/api-client/src/index.ts', "import type { Routes } from '@openquant/api';").join('\n'), /imports apps\/api: @openquant\/api/);
  assert.match(boundaryViolations('packages/api-client/src/index.ts', "export * from '@openquant/api/routes';").join('\n'), /imports apps\/api/);
  assert.deepEqual(boundaryViolations('apps/cli/src/main.tsx', "import { parseContract } from '@openquant/api-contracts';\nimport { client } from '@openquant/api-client';"), []);
  assert.deepEqual(boundaryViolations('apps/cli/src/main.tsx', "// import { app } from '../../api/src/app.ts';"), []);
});

test('Worker code cannot import Node built-ins', () => {
  for (const specifier of ['node:fs', 'node:child_process', 'child_process', 'fs/promises', 'crypto']) {
    assert.match(boundaryViolations('packages/api-contracts/ts/src/platform.ts', `import x from '${specifier}';`).join('\n'), /Worker code uses no Node built-ins/, specifier);
  }
  assert.match(boundaryViolations('apps/api/src/index.ts', "const cp = await import('node:child_process');").join('\n'), /imports the Node built-in node:child_process/);
  assert.match(boundaryViolations('packages/agents/src/runtime.ts', "const fs = require('fs');").join('\n'), /imports the Node built-in fs/);
  assert.deepEqual(boundaryViolations('apps/api/src/index.ts', "import { Hono } from 'hono';\nimport { digest } from '@openquant/api-contracts';"), []);
  assert.deepEqual(boundaryViolations('packages/api-contracts/ts/tools/generate.ts', "import { readFileSync } from 'node:fs';"), [], 'build tools are not Worker code');
});

test('the agent runner cannot import broker or engine code', () => {
  assert.match(boundaryViolations('apps/agent-runner/src/run.ts', "import { evaluate } from '../../engine/src/lib.ts';").join('\n'), /holds no broker or engine code\): .* imports apps\/engine/);
  assert.match(boundaryViolations('apps/agent-runner/src/run.ts', "import { submit } from './broker/orders.ts';").join('\n'), /imports broker code/);
  assert.match(boundaryViolations('apps/agent-runner/src/run.ts', "import Alpaca from '@alpacahq/alpaca-trade-api';").join('\n'), /imports broker code/);
  assert.match(boundaryViolations('apps/agent-runner/src/run.ts', "import { engine } from '@openquant/engine';").join('\n'), /imports apps\/engine/);
  assert.deepEqual(boundaryViolations('apps/agent-runner/src/run.ts', "import { parseContract } from '@openquant/api-contracts';\nimport { spawn } from 'node:child_process';"), []);
});
