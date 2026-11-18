// Builds the openquant binary: one ES module for Node 24, dist/openquant.mjs, with Ink, React and the workspace
// packages bundled in, so the installed CLI needs no node_modules. The module may import Node built-in modules only.
// Ink's optional React DevTools hook imports `react-devtools-core`, which is not a dependency: the build replaces it
// with an empty module, and Ink, which first checks that the package resolves, never starts it. Anything else that the
// bundle would load at run time fails the build.

import { chmodSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTINS = new Set(builtinModules);

const withoutDevtools: Plugin = {
  name: 'without-react-devtools',
  setup(context) {
    context.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
    context.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

/** Build into `dist`. Tests build into a directory of their own, so they never race with the `build` task. */
export async function bundleCli(
  dist = resolve(root, 'dist'),
): Promise<{ readonly problems: readonly string[]; readonly file: string; readonly kib: number }> {
  rmSync(dist, { recursive: true, force: true });
  const file = resolve(dist, 'openquant.mjs');
  const result = await build({
    entryPoints: [resolve(root, 'src/main.ts')],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    write: true,
    metafile: true,
    logLevel: 'silent',
    plugins: [withoutDevtools],
    define: { 'process.env.NODE_ENV': '"production"' },
    // Bundled CommonJS modules (React) call require for Node built-ins; an ES module has no require of its own.
    banner: {
      js: [
        '#!/usr/bin/env node',
        '// The OpenQuant operator CLI, bundled by apps/cli/tools/bundle.ts.',
        "import { createRequire as __openquantRequire } from 'node:module';",
        'const require = __openquantRequire(import.meta.url);',
      ].join('\n'),
    },
  });
  const problems: string[] = [];
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      const name = imported.path.replace(/^node:/, '');
      if (!BUILTINS.has(name)) problems.push(`the bundle loads ${imported.path} at run time`);
    }
  }
  for (const input of Object.keys(result.metafile.inputs)) {
    if (/(^|\/)apps\/api\//.test(input)) problems.push(`the bundle includes ${input}`);
  }
  chmodSync(file, 0o755);
  const size = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
  return { problems, file, kib: Math.round(size / 1024) };
}

if (import.meta.main) {
  const { problems, kib } = await bundleCli();
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('CLI bundle failed.');
    process.exit(1);
  }
  console.log(`CLI bundle passed: dist/openquant.mjs (${kib} KiB), loading only Node built-in modules.`);
}
