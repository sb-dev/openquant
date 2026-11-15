// The registered documents that commands and attempts read: research profile revisions, cohort policy revisions and
// the release of the environment. Each is immutable, so a document read inside a transaction can be kept for the rest
// of it. The key of the cache is the transaction handle: a new transaction starts with an empty cache.

import type { CohortPolicy, EvaluationPlan, ReleaseManifest, ResearchProfile } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';
import { loadDocument } from './store.ts';

const caches = new WeakMap<object, Map<string, Promise<unknown>>>();

export function memo<T>(scope: object, key: string, load: () => Promise<T>): Promise<T> {
  let cache = caches.get(scope);
  if (cache === undefined) {
    cache = new Map();
    caches.set(scope, cache);
  }
  let entry = cache.get(key) as Promise<T> | undefined;
  if (entry === undefined) {
    entry = load();
    cache.set(key, entry);
    // A failed load is not kept: the next caller tries again.
    entry.catch(() => cache.delete(key));
  }
  return entry;
}

export interface Registered<T> {
  readonly id: string;
  readonly revision: number;
  readonly digest: string;
  readonly document: T;
}

export async function loadProfile(
  tx: Queryable,
  env: Pick<ApiEnv, 'objects'>,
  profileId: string,
  revision: number,
): Promise<Registered<ResearchProfile> | undefined> {
  return memo(tx, `profile:${profileId}:${revision}`, async () => {
    const { rows } = await tx.query<{ document_digest: string }>(
      'SELECT document_digest FROM research_profiles WHERE profile_id = $1 AND revision = $2',
      [profileId, revision],
    );
    const digest = rows[0]?.document_digest;
    if (digest === undefined) return undefined;
    return { id: profileId, revision, digest, document: await loadDocument(env, 'research-profile', digest) };
  });
}

export async function loadPolicy(
  tx: Queryable,
  env: Pick<ApiEnv, 'objects'>,
  policyId: string,
  revision: number,
): Promise<Registered<CohortPolicy> | undefined> {
  return memo(tx, `policy:${policyId}:${revision}`, async () => {
    const { rows } = await tx.query<{ document_digest: string }>(
      'SELECT document_digest FROM cohort_policies WHERE policy_id = $1 AND revision = $2',
      [policyId, revision],
    );
    const digest = rows[0]?.document_digest;
    if (digest === undefined) return undefined;
    return { id: policyId, revision, digest, document: await loadDocument(env, 'cohort-policy', digest) };
  });
}

export async function loadPlan(
  tx: Queryable,
  env: Pick<ApiEnv, 'objects'>,
  planDigest: string,
): Promise<EvaluationPlan> {
  return memo(tx, `plan:${planDigest}`, () => loadDocument(env, 'evaluation-plan', planDigest));
}

/**
 * The release recorded for this environment (OQ-05 section 11): the highest release id. It names the engine digest and
 * the method identity that every evaluation request requires of the batch worker. Undefined when none is recorded.
 */
export async function currentRelease(tx: Queryable, environment: string): Promise<ReleaseManifest | undefined> {
  return memo(tx, `release:${environment}`, async () => {
    const { rows } = await tx.query<{ document: ReleaseManifest }>(
      'SELECT document FROM release_records WHERE environment = $1 ORDER BY release_id DESC LIMIT 1',
      [environment],
    );
    return rows[0]?.document;
  });
}
