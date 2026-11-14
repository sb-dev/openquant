// Proves that src/ runs in a Worker: esbuild bundles it for the neutral platform, which knows no
// Node built-in module, so a `node:` import fails the build. The bundle must also be self-contained
// (this package has no run-time dependency) and must not compile code at run time.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BuildResult, build } from 'esbuild';

export interface BundleCheck {
  readonly problems: readonly string[];
  readonly code: string;
}

const RUNTIME_CODE = /\bnew Function\b|\beval\s*\(/;
const NODE_ONLY = /\brequire\s*\(|\bprocess\.|\bBuffer\b|\b__dirname\b|\b__filename\b/;

export async function bundleCheck(entry: string): Promise<BundleCheck> {
  let result: BuildResult<{ write: false; metafile: true }>;
  try {
    result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
  } catch (error) {
    const errors = (error as { errors?: { text: string }[] }).errors ?? [{ text: String(error) }];
    return { problems: errors.map((e) => `esbuild: ${e.text}`), code: '' };
  }
  const problems: string[] = [];
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.startsWith('node:')) problems.push(`the bundle includes the Node module ${input}`);
    if (/(^|\/)node_modules\//.test(input)) problems.push(`the bundle includes a dependency: ${input}`);
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) problems.push(`the bundle imports ${imported.path}`);
  }
  const code = result.outputFiles[0]?.text ?? '';
  if (RUNTIME_CODE.test(code)) problems.push('the bundle compiles code at run time (new Function or eval)');
  const nodeOnly = NODE_ONLY.exec(code);
  if (nodeOnly) problems.push(`the bundle uses a Node-only name: ${nodeOnly[0]}`);
  return { problems, code };
}

if (import.meta.main) {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
  const { problems, code } = await bundleCheck(entry);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('Worker bundle check failed.');
    process.exit(1);
  }
  console.log(
    `Worker bundle check passed: src/index.ts bundles for the neutral platform (${Math.round(code.length / 1024)} KiB), with no Node import, no dependency and no run-time code generation.`,
  );
}
