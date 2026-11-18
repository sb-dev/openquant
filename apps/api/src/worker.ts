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
import { createFlyTerminationProbe, validFlyAppName } from './fly-probe.ts';
import { createAgentRunnerClient, type Dispatchers } from './outbox.ts';
import { type RecoverySummary, runRecovery, type TerminationProbe, unwiredProbe } from './recovery.ts';
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
    researchExecution: bindings.OPENQUANT_RESEARCH_EXECUTION === 'enabled',
    ...(bindings.AGENT_EXECUTOR_VERSION ? { agentExecutorVersion: bindings.AGENT_EXECUTOR_VERSION } : {}),
    orchestrate: true,
    secrets: { tokenSigningKey },
    // One JSON line: Workers Logs makes it searchable (workers-best-practices).
    log: (entry) => (entry.level === 'error' ? console.error : console.log)(JSON.stringify(entry)),
  };
}

const app = createApp((bindings) => workerEnv(bindings));

/** The queue and the runner that the dispatcher sends to. A destination without its binding is left alone (logged). */
export function dispatchersOf(bindings: WorkerBindings, log: ApiEnv['log']): Dispatchers {
  const queue = bindings.BATCH_QUEUE;
  let runner: Dispatchers['runner'];
  if (bindings.AGENT_RUNNER_URL && bindings.AGENT_RUNNER_CREDENTIAL) {
    try {
      runner = createAgentRunnerClient(bindings.AGENT_RUNNER_URL, bindings.AGENT_RUNNER_CREDENTIAL);
    } catch {
      log({ level: 'error', message: 'the agent runner is not configured: its URL is not an https URL' });
    }
  }
  return {
    batch:
      queue === undefined
        ? undefined
        : { send: async (message) => void (await queue.send(message, { contentType: 'json' })) },
    runner,
  };
}

/**
 * The termination probe of recovery. It asks Fly only when the read token and both app names are set; otherwise, or
 * when an app name is not a Fly app name, it is `unwiredProbe`, which confirms nothing (decision D22). Never logs a value.
 */
export function terminationProbeOf(bindings: WorkerBindings, log: ApiEnv['log']): TerminationProbe {
  const token = bindings.FLY_MACHINES_READ_TOKEN ?? '';
  const batch = bindings.FLY_ENGINE_BATCH_APP ?? '';
  const runner = bindings.FLY_AGENT_RUNNER_APP ?? '';
  if (token === '' || batch === '' || runner === '') {
    if (token !== '' || batch !== '' || runner !== '') {
      log({
        level: 'error',
        message:
          'the termination probe is not configured: FLY_MACHINES_READ_TOKEN, FLY_ENGINE_BATCH_APP and FLY_AGENT_RUNNER_APP are needed together',
      });
    }
    return unwiredProbe;
  }
  if (!validFlyAppName(batch) || !validFlyAppName(runner)) {
    log({ level: 'error', message: 'the termination probe is not configured: an app name is not a Fly app name' });
    return unwiredProbe;
  }
  return createFlyTerminationProbe({ token, apps: { BATCH_QUEUE: batch, AGENT_RUNNER: runner }, log });
}

/** One recovery pass (scheduled): expired leases, confirmed terminations and the dispatch of what is pending. */
export async function recover(bindings: WorkerBindings): Promise<RecoverySummary> {
  const env = workerEnv(bindings);
  const db = env.database();
  try {
    const summary = await runRecovery(env, db, {
      dispatchers: dispatchersOf(bindings, env.log),
      probe: terminationProbeOf(bindings, env.log),
    });
    env.log({ level: 'info', message: 'recovery pass', ...summary });
    return summary;
  } finally {
    await db.close();
  }
}

export default {
  fetch(request: Request, env: WorkerBindings, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  /** The cron trigger of wrangler.jsonc: recovery finds expired leases and missing dispatches with no client connected. */
  scheduled(_controller: ScheduledController, env: WorkerBindings, ctx: ExecutionContext): void {
    ctx.waitUntil(recover(env));
  },
} satisfies ExportedHandler<WorkerBindings>;
