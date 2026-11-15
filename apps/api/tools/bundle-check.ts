// Proves that src/ runs in a Worker (OQ-05 section 1; workers-best-practices): esbuild bundles the Worker entry for the
// neutral platform, which knows no Node built-in module, so a `node:` import or a built-in name fails the build.
//
// The bundle may import one package at run time, `pg`, which the Worker gets from wrangler's nodejs_compat bundling
// (not verified here: wrangler is not installed, README "Why the tests run in Node"), and may include one dependency,
// Hono. Everything else must be first-party source, which uses no Node-only name and compiles no code at run time.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { type BuildResult, build } from 'esbuild';

export interface BundleCheck {
  readonly problems: readonly string[];
  readonly code: string;
}

/** What the bundle may load from node_modules at run time (external) and what it may contain (bundled). */
export const externalPackages: readonly string[] = ['pg'];
export const bundledPackages: readonly string[] = ['hono'];

const RUNTIME_CODE = /\bnew Function\b|\beval\s*\(/;
const NODE_ONLY = /\brequire\s*\(|\bprocess\.|\bBuffer\b|\b__dirname\b|\b__filename\b/;

export function packageOf(input: string): string | undefined {
  const match = /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(input);
  return match?.[1];
}

/** The inputs of a bundle that may not be there: a Node module, or a dependency other than the allowed ones. */
export function inputProblems(inputs: readonly string[]): string[] {
  const problems: string[] = [];
  for (const input of inputs) {
    if (input.startsWith('node:')) problems.push(`the bundle includes the Node module ${input}`);
    const dependency = packageOf(input);
    if (dependency !== undefined && !bundledPackages.includes(dependency)) {
      problems.push(`the bundle includes a dependency that is not allowed: ${dependency}`);
    }
  }
  return problems;
}

export async function bundleCheck(
  entry: string,
  workingDirectory: string = resolve(dirname(entry), '..'),
): Promise<BundleCheck> {
  let result: BuildResult<{ write: false; metafile: true }>;
  try {
    result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      target: 'es2022',
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'worker', 'browser'],
      external: [...externalPackages, 'cloudflare:*'],
      absWorkingDir: workingDirectory,
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
  } catch (error) {
    const errors = (error as { errors?: { text: string }[] }).errors ?? [{ text: String(error) }];
    return { problems: errors.map((e) => `esbuild: ${e.text}`), code: '' };
  }
  const problems: string[] = [...inputProblems(Object.keys(result.metafile.inputs))];
  for (const input of Object.keys(result.metafile.inputs)) {
    if (packageOf(input) === undefined && /\.[cm]?[jt]s$/.test(input) && !input.startsWith('node:')) {
      // First-party source: the repository's own files, which must be Worker code.
      const text = readFileSync(resolve(workingDirectory, input), 'utf8');
      const nodeOnly = NODE_ONLY.exec(text);
      if (nodeOnly) problems.push(`${input} uses a Node-only name: ${nodeOnly[0]}`);
      if (RUNTIME_CODE.test(text)) problems.push(`${input} compiles code at run time`);
    }
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (!externalPackages.includes(imported.path) && !imported.path.startsWith('cloudflare:')) {
        problems.push(`the bundle imports ${imported.path}`);
      }
    }
  }
  const code = result.outputFiles[0]?.text ?? '';
  if (RUNTIME_CODE.test(code)) problems.push('the bundle compiles code at run time (new Function or eval)');
  return { problems, code };
}

if (import.meta.main) {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), '../src/worker.ts');
  const { problems, code } = await bundleCheck(entry);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('Worker bundle check failed.');
    process.exit(1);
  }
  const bytes = Buffer.byteLength(code);
  console.log(
    `Worker bundle check passed: src/worker.ts bundles for the neutral platform (${Math.round(bytes / 1024)} KiB, ${Math.round(gzipSync(code).length / 1024)} KiB gzip) with no Node module, Hono as the one bundled dependency and pg as the one import.`,
  );
}
