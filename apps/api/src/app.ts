// The Hono application of the control API. createApp takes the host's environment, or a function that builds it from
// the Worker's bindings, and registers every route of the manifest that the API host serves. Every response carries
// `cache-control: no-store` and `x-content-type-options: nosniff`. Every error is api-error/1 with a diagnostic
// reference that is also in the log line (OQ-05 section 10).

import { Hono } from 'hono';
import { type ApiEnv, type RequestContext, randomIds, redact, type WorkerBindings } from './env.ts';
import { ApiFailure, errorBody } from './errors.ts';
import { type Handler, json } from './handlers/context.ts';
import { handlers } from './handlers/index.ts';
import { apiRoutes, honoPath } from './manifest.ts';
import { serveRoute } from './route-layer.ts';

export type EnvSource = ApiEnv | ((bindings: WorkerBindings) => ApiEnv | Promise<ApiEnv>);

/** The part of a Worker's execution context that the app uses. */
interface BackgroundWork {
  waitUntil(promise: Promise<unknown>): void;
}

interface AppTypes {
  Bindings: WorkerBindings;
  Variables: { context: RequestContext };
}

function respond(failure: ApiFailure, diagnosticRef: string): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  if (failure.code === 'UNAUTHENTICATED') headers.set('www-authenticate', 'Bearer');
  return new Response(JSON.stringify(errorBody(failure, diagnosticRef)), { status: failure.status, headers });
}

export function createApp(source: EnvSource, registry: Readonly<Record<string, Handler>> = handlers): Hono<AppTypes> {
  const app = new Hono<AppTypes>();

  app.use('*', async (c, next) => {
    let executionContext: BackgroundWork | undefined;
    try {
      executionContext = c.executionCtx;
    } catch {
      // A test calls the app without a Worker execution context.
    }
    const env = typeof source === 'function' ? await source(c.env) : source;
    const db = env.database();
    c.set('context', { env, db, diagnosticRef: env.ids.next('diag') });
    try {
      await next();
    } finally {
      // The connection closes after the response is sent: waitUntil keeps the Worker alive for it.
      const closing = db.close();
      if (executionContext) executionContext.waitUntil(closing);
      else await closing;
    }
    c.res.headers.set('cache-control', 'no-store');
    c.res.headers.set('x-content-type-options', 'nosniff');
  });

  // Not part of the route manifest: a liveness check with no authentication and no data. It reads one row, so it
  // also shows that the database answers.
  app.get('/health', async (c) => {
    const { db } = c.get('context');
    try {
      await db.query('SELECT 1');
    } catch {
      throw new ApiFailure('UNAVAILABLE', 'The database does not answer.', { retrySafe: true });
    }
    return json(200, { status: 'ok' });
  });

  for (const route of apiRoutes) {
    app.on(route.method, honoPath(route.path), (c) =>
      serveRoute(route, c.get('context'), c.req.raw, c.req.param(), registry),
    );
  }

  app.notFound((c) => {
    const ref = c.get('context')?.diagnosticRef ?? randomIds().next('diag');
    return respond(new ApiFailure('NOT_FOUND', 'No route matches this method and path.'), ref);
  });

  app.onError((error, c) => {
    const context = c.get('context');
    const ref = context?.diagnosticRef ?? randomIds().next('diag');
    if (error instanceof ApiFailure) return respond(error, ref);
    // The cause stays in the log, with the same reference. The response says nothing about it.
    const log = context?.env.log ?? ((entry) => console.error(JSON.stringify(entry)));
    log({
      level: 'error',
      message: 'unhandled error',
      diagnostic_ref: ref,
      error: error.name,
      detail: redact(error.message).slice(0, 300),
    });
    return respond(
      new ApiFailure('INTERNAL', 'The API could not complete the request.', {
        stateChanged: 'UNKNOWN',
        retrySafe: false,
      }),
      ref,
    );
  });

  return app;
}
