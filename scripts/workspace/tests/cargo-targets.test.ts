import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { stepEnvironment } from '../../environment.ts';
import { paths, root } from '../../repository.ts';
import { cargoManifestErrors, cargoWorkspaceMembers } from '../../s0.ts';
import { cargoTestMessages, integrationTestFiles, noRunArguments, testTargetErrors } from '../cargo-targets.ts';

// G4 of the P1 review: Cargo must build a test target from every tracked integration test file of the workspace.
const members = cargoWorkspaceMembers(readFileSync(resolve(root, 'Cargo.toml'), 'utf8'));
const tracked = paths(root);
const integration = integrationTestFiles(tracked, members);
const missing = (file: string) => `${file} is a tracked integration test, but cargo ${noRunArguments.join(' ')} builds no test target from it, so cargo test does not run it`;
function artifact(file: string, kind = 'test', base = root) {
  return { reason: 'compiler-artifact', target: { kind: [kind], src_path: resolve(base, file) }, profile: { test: true }, executable: resolve(base, 'target/debug/deps/x') };
}

test('the integration test files are the tests/*.rs of each workspace member, without their support modules', () => {
  assert.ok(integration.includes('packages/api-contracts/rust/tests/registry.rs'));
  assert.ok(integration.includes('apps/engine/tests/s0_fixtures.rs'));
  assert.ok(integration.includes('packages/quant-core/tests/protocol.rs'));
  assert.ok(!integration.some((file) => file.endsWith('/mod.rs')), integration.join(', '));
  assert.ok(!integration.some((file) => file.startsWith('.agents/')), 'a vendored crate outside the workspace is not a member');
  assert.deepEqual(integrationTestFiles(['crate/tests/a.rs', 'crate/tests/b/main.rs', 'crate/tests/b/helper.rs', 'crate/src/tests/c.rs'], ['crate']), ['crate/tests/a.rs', 'crate/tests/b/main.rs']);
});
test('a tracked integration test without a test target fails, in the first, a middle or the last position', () => {
  assert.deepEqual(testTargetErrors(root, tracked, members, integration.map((file) => artifact(file))), []);
  for (const position of [0, Math.floor(integration.length / 2), integration.length - 1]) {
    const messages = integration.filter((_, index) => index !== position).map((file) => artifact(file));
    assert.deepEqual(testTargetErrors(root, tracked, members, messages), [missing(integration[position])], String(position));
  }
});
test('a library or binary target, or a test target that was not built, does not stand in for an integration test', () => {
  const [first, ...rest] = integration;
  const others = rest.map((file) => artifact(file));
  assert.deepEqual(testTargetErrors(root, tracked, members, [...others, artifact(first, 'lib')]), [missing(first)]);
  assert.deepEqual(testTargetErrors(root, tracked, members, [...others, { ...artifact(first), executable: null }]), [missing(first)]);
  assert.deepEqual(testTargetErrors(root, tracked, members, [...others, { ...artifact(first), profile: { test: false } }]), [missing(first)]);
  assert.match(testTargetErrors(root, [], members, [])[0] ?? '', /No tracked integration test file/);
});

// The reviewer's two manifests, built by the real Cargo in a small workspace with the pinned toolchain and its own
// target directory. Each leaves tests/alpha.rs out of `cargo test`, and Cargo still exits 0.
const probeFiles = ['probe/tests/alpha.rs', 'probe/tests/beta.rs'];
function probe(manifest: string): { errors: string[]; manifestErrors: string[] } {
  const directory = mkdtempSync(resolve(tmpdir(), 'openquant-cargo-targets-'));
  const saved = process.env.CARGO_TARGET_DIR;
  try {
    const files: Record<string, string> = {
      'Cargo.toml': '[workspace]\nresolver = "3"\nmembers = ["probe"]\n',
      'probe/Cargo.toml': `[package]\nname = "openquant-probe"\nversion = "0.0.0"\nedition = "2024"\n${manifest}`,
      'probe/src/lib.rs': 'pub fn one() -> u8 {\n    1\n}\n',
    };
    for (const file of probeFiles) files[file] = '#[test]\nfn runs() {\n    assert_eq!(openquant_probe::one(), 1);\n}\n';
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(resolve(directory, file)), { recursive: true });
      writeFileSync(resolve(directory, file), content);
    }
    copyFileSync(resolve(root, 'rust-toolchain.toml'), resolve(directory, 'rust-toolchain.toml'));
    process.env.CARGO_TARGET_DIR = resolve(directory, 'target');
    const lock = spawnSync('cargo', ['generate-lockfile', '--offline'], { cwd: directory, encoding: 'utf8', env: stepEnvironment() });
    assert.equal(lock.status, 0, lock.stderr);
    const errors = testTargetErrors(directory, Object.keys(files), cargoWorkspaceMembers(files['Cargo.toml']), cargoTestMessages(directory));
    return { errors, manifestErrors: cargoManifestErrors('probe/Cargo.toml', files['probe/Cargo.toml']) };
  } finally {
    if (saved === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = saved;
    rmSync(directory, { recursive: true, force: true });
  }
}
const probeMissing = (file: string) => missing(file);
test('Cargo builds a test target from every integration test of a plain manifest', () => {
  assert.deepEqual(probe(''), { errors: [], manifestErrors: [] });
});
test('G4: the reviewer\'s quoted "autotests" = false leaves every integration test out, and both checks fail', () => {
  const run = probe('"autotests" = false\n');
  assert.deepEqual(run.errors, probeFiles.map(probeMissing));
  assert.deepEqual(run.manifestErrors, ['probe/Cargo.toml must not set package.autotests = false: Cargo would leave tests unbuilt or unrun']);
});
test('G4: the reviewer\'s [[test]] with a required feature that is never enabled leaves that test out, and both checks fail', () => {
  const run = probe('\n[[test]]\nname = "alpha"\npath = "tests/alpha.rs"\nrequired-features = ["never"]\n\n[features]\nnever = []\n');
  assert.deepEqual(run.errors, [probeMissing('probe/tests/alpha.rs')]);
  assert.deepEqual(run.manifestErrors, ['probe/Cargo.toml must not set test[0].required-features: Cargo skips a target whose required features are not enabled, so its tests would not run']);
});
