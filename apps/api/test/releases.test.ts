// releases.record (OQ-05 sections 9 and 11, OQ-06 section 3, decision D23): the protected delivery job records the release
// manifest of an environment with the `deploy` credential, or an Administrator does. The route answers with the system
// identity that it now serves. Expected digests come from node:crypto over the canonical JSON of the contract package;
// the migration level comes from the directory of migrations.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actors, accessTokenFor, seedActors } from './support/actors.ts';
import { bearer, bodyOf, createTestApp, type TestApp } from './support/app.ts';

const directory = resolve(fileURLToPath(import.meta.url), '..');
const level = readdirSync(resolve(directory, '../migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .at(-1)
  ?.replace(/\.sql$/, '') as string;

// biome-ignore lint/suspicious/noExplicitAny: the test edits a fixture document by path.
type Doc = Record<string, any>;

function manifest(edit?: (document: Doc) => void): Doc {
  const document = JSON.parse(
    readFileSync(resolve(directory, '../../../fixtures/protocol/valid/release-manifest.staging.json'), 'utf8'),
  ) as Doc;
  document.environment = 'DEVELOPMENT';
  document.migration_level = level;
  edit?.(document);
  return document;
}

const digestOf = (document: Doc): string =>
  `sha256:${createHash('sha256').update(canonicalJson(document)).digest('hex')}`;

let testApp: TestApp;
let actors: Actors;

beforeAll(async () => {
  testApp = await createTestApp();
  actors = await seedActors(testApp);
});
afterAll(async () => {
  await testApp.drop();
});

const post = (token: string | undefined, body: unknown) =>
  testApp.request('/v1/releases', {
    method: 'POST',
    headers: { ...(token === undefined ? {} : bearer(token)), 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const records = () =>
  testApp.database.sql<{ manifest_digest: string; migration_level: string; recorded_by: string; document: Doc }>(
    'SELECT manifest_digest, migration_level, recorded_by, document FROM release_records ORDER BY release_id',
  );

describe('a release that the delivery job records', () => {
  it('is stored with its digest, answered as the system identity, and shown by system.identity afterwards', async () => {
    const release = manifest();
    const response = await post(actors.services.full.deploy, release);
    expect(response.status).toBe(200);
    const view = await bodyOf<{
      environment: string;
      migration_level: string;
      release: { release_id: string; manifest_digest: string; manifest: Doc };
      release_note: string | null;
    }>(response);
    expect(view).toMatchObject({ environment: 'DEVELOPMENT', migration_level: level, release_note: null });
    expect(view.release.manifest_digest).toBe(digestOf(release));
    expect(view.release.manifest).toEqual(release);

    const stored = await records();
    expect(stored).toEqual([
      { manifest_digest: digestOf(release), migration_level: level, recorded_by: 'svc-deploy', document: release },
    ]);
    // The same view is what a Viewer reads back.
    const read = await testApp.request('/v1/system/identity', {
      headers: bearer(await accessTokenFor(testApp, actors.people.viewer)),
    });
    expect((await bodyOf<{ release: { manifest_digest: string } }>(read)).release.manifest_digest).toBe(
      digestOf(release),
    );
    // The record is audited, with the principal and the digest but never the manifest.
    const audit = await testApp.database.sql<{ actor: string; subject: string; detail: Doc }>(
      `SELECT actor, subject, detail FROM audit_events WHERE event_type = 'release.recorded'`,
    );
    expect(audit).toEqual([
      {
        actor: 'svc-deploy',
        subject: digestOf(release),
        detail: { environment: 'DEVELOPMENT', source_commit: release.source_commit },
      },
    ]);
  });

  it('is one record however often the same manifest is recorded, and the newest manifest is the current release', async () => {
    const release = manifest();
    const again = await post(actors.services.full.deploy, release);
    expect(again.status).toBe(200);
    expect(await records()).toHaveLength(1);
    expect(await testApp.database.sql(`SELECT 1 FROM audit_events WHERE event_type = 'release.recorded'`)).toHaveLength(
      1,
    );

    // An Administrator records the next release, by an access token: another source commit, another digest.
    const next = manifest((document) => {
      document.source_commit = 'b'.repeat(40);
    });
    const access = await accessTokenFor(testApp, actors.people.admin);
    const response = await post(access, next);
    expect(response.status).toBe(200);
    expect((await bodyOf<{ release: { manifest_digest: string } }>(response)).release.manifest_digest).toBe(
      digestOf(next),
    );
    expect((await records()).map((row) => row.recorded_by)).toEqual(['svc-deploy', 'human-admin']);
    // The earlier record is not replaced or removed.
    expect((await records()).map((row) => row.manifest_digest)).toEqual([digestOf(release), digestOf(next)]);
  });

  it('is refused for another environment or another migration level, and nothing is stored', async () => {
    const before = await records();
    const wrongEnvironment = await post(
      actors.services.full.deploy,
      manifest((document) => {
        document.environment = 'PRODUCTION';
      }),
    );
    expect(wrongEnvironment.status).toBe(422);
    expect((await bodyOf<{ code: string }>(wrongEnvironment)).code).toBe('IDENTITY_MISMATCH');
    const wrongLevel = await post(
      actors.services.full.deploy,
      manifest((document) => {
        document.migration_level = '0001_identity';
      }),
    );
    expect(wrongLevel.status).toBe(422);
    expect((await bodyOf<{ code: string }>(wrongLevel)).code).toBe('IDENTITY_MISMATCH');
    expect(await records()).toEqual(before);
  });

  it('is refused for a body that is not a release manifest, with the code of the contract layer', async () => {
    const cases: [string, unknown, number, string][] = [
      [
        'a manifest of another version',
        manifest((document) => (document.schema_version = 'release-manifest/2')),
        400,
        'UNSUPPORTED_SCHEMA_VERSION',
      ],
      ['a manifest with an unknown member', manifest((document) => (document.note = 'x')), 400, 'SCHEMA_VIOLATION'],
      ['text that is not JSON', 'not json', 400, 'SCHEMA_VIOLATION'],
    ];
    for (const [label, body, status, code] of cases) {
      const response = await post(actors.services.full.deploy, body);
      expect(response.status, label).toBe(status);
      expect((await bodyOf<{ code: string }>(response)).code, label).toBe(code);
    }
    expect(await records()).toHaveLength(2);
  });

  it('is open to an Administrator and to the deploy credential only, and to no one else', async () => {
    const before = await records();
    const release = manifest((document) => {
      document.source_commit = 'c'.repeat(40);
    });
    for (const name of ['viewer', 'researcher', 'steward'] as const) {
      const access = await accessTokenFor(testApp, actors.people[name]);
      expect((await post(access, release)).status, name).toBe(403);
    }
    for (const kind of ['batch', 'runner', 'workflows'] as const) {
      expect((await post(actors.services.full[kind], release)).status, kind).toBe(403);
    }
    // A deploy credential scoped to some other operation is not scoped to this route.
    expect((await post(actors.services.none.deploy, release)).status).toBe(403);
    // A person's long-lived credential is for the token route only.
    expect((await post(actors.people.admin, release)).status).toBe(403);
    expect((await post(undefined, release)).status).toBe(401);
    expect(await records()).toEqual(before);
  });
});
