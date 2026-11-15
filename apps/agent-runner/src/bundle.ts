// The behaviour bundle on the runner host (OQ-03 section 3).
//
// The bundle is an exact allowlist of paths and content hashes. The instructions that the runner gives the executor
// come from the module that `@openquant/agents` builds from that allowlist, never from a file the runner reads at
// dispatch time, so no local text can be substituted. This check proves that the installed copy of the bundle is the
// one the module was built from: the manifest bytes hash to the built-in bundle hash, every listed file has its listed
// SHA-256, the built-in procedure text equals the listed file, and the directory holds nothing that the manifest does
// not list (an evaluation file, an expected answer or a development script must never reach the host).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { BUNDLE_HASH, FILES, MANIFEST_TEXT, PROCEDURES, RESULT_SCHEMAS } from '@openquant/agents';
import { sha256Bytes } from './text.ts';

export const MANIFEST_FILE = 'bundle.manifest.json';

/**
 * The instructions of the executor for one role module: its procedure, and the result schema that the procedure's
 * Output section refers to, both from the built-in bundle module. The executor sees the schema in the prompt whether or
 * not the additional `--json-schema` guard is on, because the guard is not verified (README, spike). The text is a
 * function of the bundle alone, so the bundle hash binds it.
 */
export function instructionsFor(skill: keyof typeof PROCEDURES): string {
  const schema = RESULT_SCHEMAS[`${skill}.result`];
  return `${PROCEDURES[skill].trimEnd()}

## Result schema

Your output is one JSON document that is valid against this JSON Schema (draft 2020-12). The schema belongs to the same reviewed bundle as these instructions.

${JSON.stringify(schema)}
`;
}
/** More entries than this in the bundle directory is already a mismatch: the bundle holds 8 files. */
const MAX_ENTRIES = 256;

export type BundleCheck =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly installedHash: string | undefined; readonly problems: readonly string[] };

function listFiles(root: string, problems: string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (found.length > MAX_ENTRIES) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(relative(root, path).split(sep).join('/'));
      else problems.push(`${relative(root, path)} is neither a file nor a directory`);
    }
  };
  walk(root);
  return found;
}

/** Check the installed bundle directory against the manifest that this runner was built with. */
export function verifyBundle(directory: string): BundleCheck {
  const problems: string[] = [];
  const root = resolve(directory);
  let manifest: Uint8Array | undefined;
  try {
    manifest = readFileSync(join(root, MANIFEST_FILE));
  } catch {
    return { ok: false, installedHash: undefined, problems: [`${MANIFEST_FILE} is missing from the bundle directory`] };
  }
  const installedHash = sha256Bytes(manifest);
  if (installedHash !== BUNDLE_HASH) {
    problems.push(`the installed manifest has hash ${installedHash}, and this runner was built with ${BUNDLE_HASH}`);
  } else if (Buffer.from(manifest).toString('utf8') !== MANIFEST_TEXT) {
    problems.push('the installed manifest differs from the built-in manifest text');
  }
  const listed = new Set<string>([MANIFEST_FILE]);
  for (const file of FILES) {
    if (posix.isAbsolute(file.path) || file.path.split('/').includes('..')) {
      problems.push(`the manifest lists the path ${file.path}, which leaves the bundle`);
      continue;
    }
    listed.add(file.path);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(root, file.path));
    } catch {
      problems.push(`${file.path} is listed in the manifest and missing from the bundle directory`);
      continue;
    }
    const actual = sha256Bytes(bytes);
    if (actual !== file.sha256) problems.push(`${file.path} has hash ${actual}, and the manifest lists ${file.sha256}`);
  }
  for (const found of listFiles(root, problems)) {
    if (!listed.has(found)) problems.push(`${found} is in the bundle directory and not in the manifest`);
  }
  // The text that the runner supplies must be the text that the manifest lists.
  for (const [skill, text] of Object.entries(PROCEDURES)) {
    const listedFile = FILES.find((file) => file.path === `src/skills/${skill}/procedure.md`);
    const actual = sha256Bytes(Buffer.from(text, 'utf8'));
    if (listedFile === undefined) problems.push(`the manifest lists no procedure for ${skill}`);
    else if (listedFile.sha256 !== actual) problems.push(`the built-in procedure of ${skill} is not the listed file`);
  }
  return problems.length === 0 ? { ok: true, hash: installedHash } : { ok: false, installedHash, problems };
}

/**
 * Copy the bundle that the manifest lists, and nothing else, from a source tree (the `packages/agents` directory)
 * into a fresh directory. The build uses it to place the bundle next to the bundled runner; tests use it to make
 * an installed bundle that they can then damage.
 */
export function stageBundle(sourceRoot: string, target: string): void {
  const source = resolve(sourceRoot);
  mkdirSync(target, { recursive: true });
  const copy = (path: string): void => {
    const from = join(source, path);
    if (!existsSync(from) || !statSync(from).isFile())
      throw new Error(`the bundle file ${path} is missing from ${source}`);
    mkdirSync(dirname(join(target, path)), { recursive: true });
    cpSync(from, join(target, path));
  };
  copy(MANIFEST_FILE);
  for (const file of FILES) copy(file.path);
}
