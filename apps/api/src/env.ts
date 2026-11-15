// What the control application needs from its host (OQ-05 sections 1 and 5). createApp takes an ApiEnv, so a test
// supplies a real Postgres connection and an in-memory object store, and the Worker supplies Hyperdrive and R2.
// Nothing here is module-level request state: every request gets its own database handle.

import type { Database, DatabaseFactory } from './db/database.ts';
import type { ObjectStore } from './store/objects.ts';

export type DeploymentEnvironment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

export const DEPLOYMENT_ENVIRONMENTS: readonly DeploymentEnvironment[] = ['DEVELOPMENT', 'STAGING', 'PRODUCTION'];

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly [field: string]: unknown;
}

export interface IdGenerator {
  /** A new identifier that matches the Identifier pattern of the contracts, such as `diag-0123abcd…`. */
  next(prefix: string): string;
}

export interface ApiEnv {
  readonly environment: DeploymentEnvironment;
  readonly database: DatabaseFactory;
  readonly objects: ObjectStore;
  readonly clock: () => Date;
  readonly ids: IdGenerator;
  /**
   * Whether research execution is on. It is off by default: a Researcher can register and create, and run_mission_now
   * is refused with EXECUTION_DISABLED until the deployment turns it on (OQ-05 section 4).
   */
  readonly researchExecution: boolean;
  readonly secrets: {
    /** HMAC key of access tokens and attempt capabilities: at least 32 bytes. */
    readonly tokenSigningKey: Uint8Array;
  };
  readonly log: (entry: LogEntry) => void;
}

/** What the Worker receives from the platform. Names must equal the bindings of wrangler.jsonc (a test checks it). */
export interface WorkerBindings {
  /** Hyperdrive, with query caching disabled on the resource (OQ-05 section 1). */
  readonly HYPERDRIVE: Hyperdrive;
  /** The R2 bucket of content-addressed artefacts. */
  readonly ARTEFACTS: R2Bucket;
  /** Secret: base64url of at least 32 random bytes. Set with `wrangler secret put`, never in a file. */
  readonly TOKEN_SIGNING_KEY: string;
  /** Plain variable: DEVELOPMENT, STAGING or PRODUCTION. */
  readonly OPENQUANT_ENVIRONMENT: string;
  /** Plain variable: `enabled` turns research execution on; any other value, or none, leaves it off. */
  readonly OPENQUANT_RESEARCH_EXECUTION: string;
  /** The Queue producer of the one batch queue (OQ-05 section 1). The scheduled dispatcher sends job-dispatch/1 to it. */
  readonly BATCH_QUEUE: Queue;
  /** Secret: the base URL (https) of the Fly agent runner. */
  readonly AGENT_RUNNER_URL: string;
  /** Secret: the credential of the workflows service principal, which the runner accepts for its dispatch route. */
  readonly AGENT_RUNNER_CREDENTIAL: string;
}

/** Identifiers from the platform's random source: 96 bits after the prefix. */
export function randomIds(): IdGenerator {
  return {
    next(prefix: string): string {
      return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    },
  };
}

/** One request's view of the application: the host's environment plus the database handle that it owns. */
export interface RequestContext {
  readonly env: ApiEnv;
  readonly db: Database;
  /** Correlates the response, the log line and the audit row of this request (OQ-05 section 10). */
  readonly diagnosticRef: string;
}

/** Text with credentials removed, for a log line. */
export function redact(text: string): string {
  return text
    .replace(/\boq[kap]1\.[A-Za-z0-9._~-]+/g, '[credential]')
    .replace(/\bpostgres(?:ql)?:\/\/[^\s'"`]+/gi, '[connection string]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [credential]');
}
