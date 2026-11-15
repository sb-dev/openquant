// API-owned read models (routes/v1.json, "views"). They are not cross-runtime contracts: this module owns their shape.
// The client package cannot import apps/api, so a shared home for these types is an open point for the lead (see the
// README). A view never carries a credential other than the one that it exists to hand out once.

import type { DeploymentEnvironment } from './env.ts';
import type { Role } from './manifest.ts';

/** The answer of auth.token: a 15-minute access token and who it names. */
export interface AccessTokenView {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly issued_at: string;
  readonly expires_at: string;
  readonly principal: { readonly id: string; readonly display_name: string; readonly kind: 'HUMAN' };
  readonly roles: readonly Role[];
}

/** The recorded release of an environment, repeated from its release-manifest/1 with the record's own identity. */
export interface RecordedRelease {
  readonly release_id: string;
  readonly manifest_digest: string;
  readonly recorded_at: string;
  readonly manifest: unknown;
}

/** The answer of system.identity (and of releases.record, which returns it after it records a manifest). */
export interface SystemIdentityView {
  readonly environment: DeploymentEnvironment;
  readonly protocol: {
    readonly route_manifest: string;
    /** The contract tags that this API accepts and returns, as the route manifest names them. */
    readonly contracts: readonly string[];
  };
  /** The id of the last applied migration, such as 0007_control. */
  readonly migration_level: string;
  /** The current release of this environment, or null with the reason when none is recorded. */
  readonly release: RecordedRelease | null;
  readonly release_note: string | null;
  readonly generated_at: string;
}

/** A UTC instant with second precision, as the contracts write it: YYYY-MM-DDTHH:MM:SSZ. */
export function utcTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
