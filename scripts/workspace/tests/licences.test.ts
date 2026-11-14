import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { root } from '../../repository.ts';
import { installedPackages, licenceErrors } from '../licences.ts';

test('every installed package has an allowed licence', () => {
  const packages = installedPackages(root);
  assert.ok(packages.some((item) => item.name === 'yaml'), 'the walk must find the installed packages');
  assert.deepEqual(licenceErrors(packages), []);
});

test('a licence outside the allowlist fails', () => {
  assert.deepEqual(licenceErrors([{ name: 'copyleft', version: '1.0.0', licence: 'GPL-3.0-only' }]), ['Licence not on the allowlist: copyleft@1.0.0 is GPL-3.0-only']);
  assert.deepEqual(licenceErrors([{ name: 'unlicensed', version: '1.0.0', licence: undefined }]), ['Installed package has no licence: unlicensed@1.0.0']);
});

test('a reviewed licence is accepted only for the named packages', () => {
  assert.deepEqual(licenceErrors([{ name: 'lightningcss-darwin-arm64', version: '1.33.0', licence: 'MPL-2.0' }, { name: 'argparse', version: '2.0.1', licence: 'Python-2.0' }]), []);
  assert.deepEqual(licenceErrors([{ name: 'other', version: '1.0.0', licence: 'MPL-2.0' }]), ['Licence not on the allowlist: other@1.0.0 is MPL-2.0']);
});

test('an empty install fails', () => assert.deepEqual(licenceErrors([]), ['No installed npm packages were found to check']));

test('the walk reads each package once, skips its dependency links and reads legacy licence arrays', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'openquant-licences-'));
  try {
    const store = resolve(temporary, 'node_modules/.pnpm');
    const write = (id: string, name: string, manifest: object) => {
      mkdirSync(resolve(store, id, 'node_modules', name), { recursive: true });
      writeFileSync(resolve(store, id, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
    };
    write('a@1.0.0', 'a', { license: 'MIT' });
    write('@scope+b@1.0.0', '@scope/b', { licenses: [{ type: 'GPL-2.0' }] });
    symlinkSync(resolve(store, '@scope+b@1.0.0/node_modules/@scope/b'), resolve(store, 'a@1.0.0/node_modules/b-link'), 'dir');
    writeFileSync(resolve(store, 'lock.yaml'), 'lockfileVersion: 9.0\n');
    const packages = installedPackages(temporary);
    assert.deepEqual(packages.map((item) => `${item.name}:${item.licence}`), ['@scope/b:GPL-2.0', 'a:MIT']);
    assert.deepEqual(licenceErrors(packages), ['Licence not on the allowlist: @scope/b@1.0.0 is GPL-2.0']);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
