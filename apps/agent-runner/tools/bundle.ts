// Builds the deployable runner: one ES module and the behaviour bundle next to it (OQ-03 section 3).
//
//   dist/agent-runner.mjs   the runner and its two workspace dependencies, bundled for Node 24
//   dist/bundle/            the behaviour bundle, exactly the files of packages/agents/bundle.manifest.json
//
// The module imports only Node built-in modules, so the image needs no `node_modules`. The step then loads the
// bundle directory with the runner's own check, so a build that placed a wrong or extra file fails here.

import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { stageBundle, verifyBundle } from '../src/bundle.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Build into `dist`. Tests build into a directory of their own, so they never race with the `build` task. */
export async function bundleRunner(
  dist = resolve(root, 'dist'),
): Promise<{ readonly problems: readonly string[]; readonly kib: number }> {
  rmSync(dist, { recursive: true, force: true });
  const result = await build({
    entryPoints: [resolve(root, 'src/main.ts')],
    outfile: resolve(dist, 'agent-runner.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    write: true,
    metafile: true,
    logLevel: 'silent',
    // The runner has no third-party dependency: everything but a Node built-in is bundled.
    banner: { js: '// The OpenQuant agent runner, bundled by apps/agent-runner/tools/bundle.ts.' },
  });
  const problems: string[] = [];
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.path.startsWith('node:'))
        problems.push(`the bundle imports ${imported.path}, which is not a Node built-in`);
    }
  }
  for (const input of Object.keys(result.metafile.inputs)) {
    if (/(^|\/)node_modules\//.test(input)) problems.push(`the bundle includes a dependency: ${input}`);
    if (/(^|\/)apps\/engine\//.test(input) || /broker/i.test(input)) problems.push(`the bundle includes ${input}`);
  }
  stageBundle(resolve(root, '../../packages/agents'), resolve(dist, 'bundle'));
  const staged = verifyBundle(resolve(dist, 'bundle'));
  if (!staged.ok) problems.push(...staged.problems.map((problem) => `dist/bundle: ${problem}`));
  const size = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
  return { problems, kib: Math.round(size / 1024) };
}

if (import.meta.main) {
  const { problems, kib } = await bundleRunner();
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('Agent runner bundle failed.');
    process.exit(1);
  }
  console.log(
    `Agent runner bundle passed: dist/agent-runner.mjs (${kib} KiB) and dist/bundle, with no dependency other than Node built-in modules.`,
  );
}
