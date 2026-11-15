// Rewrites bundle.manifest.json from the files (`pnpm --filter @openquant/agents run bundle:update`).
//
// The manifest is the exact allowlist of what ships (OQ-03 section 3): each role module's procedure and every role
// schema, with the SHA-256 of each file and the digest of each derived result schema. This tool refreshes those
// values and the file list; the skills and the empty method list are written by hand. Run it after a reviewed change
// to a shipped file or to a shared schema that a result schema references, and review the manifest change: the bundle
// hash is the SHA-256 of the manifest bytes, so every such change gives a new bundle hash.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleRoleSchemas,
  derivedEntries,
  fileDigest,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  type Manifest,
  manifestText,
  PILOT_SKILLS,
  readSchemas,
  sha256,
  shippedPaths,
} from './bundle-lib.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(packageRoot, MANIFEST_FILE);
const previous = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Manifest) : undefined;
const bundle = bundleRoleSchemas(readSchemas(packageRoot));
const manifest: Manifest = {
  format: MANIFEST_FORMAT,
  id: previous?.id ?? 'baseline',
  version: previous?.version ?? 1,
  methods: [],
  skills: PILOT_SKILLS,
  files: shippedPaths(packageRoot, PILOT_SKILLS).map((file) => ({ path: file, sha256: fileDigest(packageRoot, file) })),
  derived: await derivedEntries(bundle),
};
const text = manifestText(manifest);
const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
writeFileSync(path, text);
console.log(
  before === text
    ? `${MANIFEST_FILE} is up to date; bundle hash ${sha256(Buffer.from(text))}.`
    : `Updated ${MANIFEST_FILE}; bundle hash ${sha256(Buffer.from(text))}. Review the change.`,
);
