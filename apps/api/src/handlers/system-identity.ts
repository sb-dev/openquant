// system.identity: which build and schema this API is (OQ-05 section 11). The view shows the environment, the protocol
// versions that the route manifest accepts and returns, the migration level read live from the database, and the
// current release recorded for this environment, or says that none is recorded. A release that was never recorded is
// not invented.

import { contracts } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import { readMigrationLevel } from '../db/migration-level.ts';
import type { ApiEnv } from '../env.ts';
import { apiRoutes, manifest } from '../manifest.ts';
import { type SystemIdentityView, utcTimestamp } from '../views.ts';
import { type Handler, json } from './context.ts';

/** The contract tags that the served routes accept and return, with the error body that every route may return. */
export function protocolContracts(): string[] {
  const names = new Set<string>(['api-error']);
  for (const route of apiRoutes) {
    if (route.request.kind === 'contract') names.add(route.request.contract);
    const response = route.response;
    if (response.kind === 'contract' && typeof response.contract === 'string') names.add(response.contract);
  }
  return [...names]
    .map((name) => (contracts as Record<string, { versionTag: string }>)[name]?.versionTag)
    .filter((tag): tag is string => tag !== undefined)
    .sort();
}

/** The view of system.identity: also what releases.record returns after it records a manifest. */
export async function buildSystemIdentity(env: ApiEnv, db: Queryable): Promise<SystemIdentityView> {
  const level = await readMigrationLevel(db);
  const { rows } = await db.query<{
    release_id: string;
    manifest_digest: string;
    recorded_at: Date;
    document: unknown;
  }>(
    `SELECT release_id::text AS release_id, manifest_digest, recorded_at, document
       FROM release_records WHERE environment = $1 ORDER BY release_id DESC LIMIT 1`,
    [env.environment],
  );
  const release = rows[0];
  const view: SystemIdentityView = {
    environment: env.environment,
    protocol: { route_manifest: manifest.version, contracts: protocolContracts() },
    migration_level: level,
    release:
      release === undefined
        ? null
        : {
            release_id: release.release_id,
            manifest_digest: release.manifest_digest,
            recorded_at: utcTimestamp(release.recorded_at),
            manifest: release.document,
          },
    release_note: release === undefined ? `No release manifest is recorded for ${env.environment}.` : null,
    generated_at: utcTimestamp(env.clock()),
  };
  return view;
}

export const systemIdentity: Handler = async ({ env, db }) => json(200, await buildSystemIdentity(env, db));
