// The Cloudflare Worker entry (OQ-05 section 1): Hono on Workers, Neon through Hyperdrive, artefacts in R2. It builds
// the ApiEnv from the bindings of wrangler.jsonc on each request and keeps no state between requests.
//
// Not verified here: running this module under workerd with a real Hyperdrive binding. wrangler, miniflare and the
// Workers Vitest pool cannot join this repository's lockfile (README, "Why the tests run in Node"), so P6's deployment
// probe is the first run of this entry in the Workers runtime.

import { createApp } from './app.ts';
import { parseSigningKey } from './auth/tokens.ts';
import { createPgDatabase } from './db/pg.ts';
import {
  type ApiEnv,
  DEPLOYMENT_ENVIRONMENTS,
  type DeploymentEnvironment,
  randomIds,
  type WorkerBindings,
} from './env.ts';
import { createR2ObjectStore } from './store/objects.ts';

/** Throws, naming the binding but never its value, when a binding is missing or unusable. */
export function workerEnv(bindings: WorkerBindings): ApiEnv {
  const environment = bindings.OPENQUANT_ENVIRONMENT;
  if (!(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new Error('The variable OPENQUANT_ENVIRONMENT must be DEVELOPMENT, STAGING or PRODUCTION.');
  }
  const connectionString = bindings.HYPERDRIVE?.connectionString;
  if (typeof connectionString !== 'string' || connectionString === '')
    throw new Error('The binding HYPERDRIVE is missing.');
  if (bindings.ARTEFACTS === undefined) throw new Error('The binding ARTEFACTS is missing.');
  let tokenSigningKey: Uint8Array;
  try {
    tokenSigningKey = parseSigningKey(bindings.TOKEN_SIGNING_KEY);
  } catch {
    throw new Error('The secret TOKEN_SIGNING_KEY is missing or too short.');
  }
  return {
    environment: environment as DeploymentEnvironment,
    database: () => createPgDatabase(connectionString),
    objects: createR2ObjectStore(bindings.ARTEFACTS),
    clock: () => new Date(),
    ids: randomIds(),
    secrets: { tokenSigningKey },
    // One JSON line: Workers Logs makes it searchable (workers-best-practices).
    log: (entry) => (entry.level === 'error' ? console.error : console.log)(JSON.stringify(entry)),
  };
}

const app = createApp((bindings) => workerEnv(bindings));

export default {
  fetch(request: Request, env: WorkerBindings, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerBindings>;
