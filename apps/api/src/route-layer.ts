// The chain that every route of the manifest runs, in this order (OQ-05 sections 7 and 9):
//
//   1. authenticate: a missing, malformed, unknown, expired or revoked credential is UNAUTHENTICATED;
//   2. authorise by the credentials and roles that the manifest lists for the route: FORBIDDEN, or for an attempt
//      capability that lost its lease LEASE_EXPIRED or STALE_OWNERSHIP, with the rejection recorded;
//   3. refuse a body above the route's max_body_bytes with LIMIT_EXCEEDED, before any parse;
//   4. parse the body as the contract of the route, on bytes (parseContract), and map a ContractError onto api-error/1;
//   5. check the form and the command kind that the route accepts;
//   6. call the handler of the route (every route of the manifest that the API host serves has one).
//
// A caller that fails step 1 or 2 never has its body read, with one exception: a capability that lost its lease on a
// route that has a late handler (the agent result). Its body is read for the one thing that a late report can still do,
// carry the usage of a host that stopped, and the answer stays the refusal. The manifest, not this file, says which
// routes exist.

import { parseContract } from '@openquant/api-contracts';
import { writeAudit } from './audit.ts';
import { authenticate, type Caller } from './auth/authenticate.ts';
import { authorize } from './auth/authorize.ts';
import { readBounded } from './body.ts';
import type { Queryable } from './db/database.ts';
import type { RequestContext } from './env.ts';
import { ApiFailure, fromContractError } from './errors.ts';
import type { Handler, LateHandler, ParsedBody } from './handlers/context.ts';
import type { RouteSpec } from './manifest.ts';

export async function readBody(route: RouteSpec, request: Request): Promise<ParsedBody> {
  const spec = route.request;
  if (spec.kind === 'none') return { kind: 'none' };
  const limit = route.max_body_bytes;
  if (limit === undefined) throw new Error(`Route ${route.id} has a request body and no max_body_bytes.`);
  const bytes = await readBounded(request, limit);
  if (spec.kind === 'bytes') return { kind: 'bytes', bytes };
  const parsed = parseContract(spec.contract, bytes);
  if (!parsed.ok) throw fromContractError(parsed.error);
  const value = parsed.value as { form?: unknown; payload?: { kind?: unknown } };
  if (spec.form !== undefined && value.form !== spec.form) {
    throw new ApiFailure('SCHEMA_VIOLATION', 'The request body is not the form that this route accepts.', {
      violations: [{ pointer: '/form', message: `The route accepts the ${spec.form} form only.` }],
    });
  }
  if (spec.command_kind !== undefined && value.payload?.kind !== spec.command_kind) {
    throw new ApiFailure('SCHEMA_VIOLATION', 'The command is not the kind that this route accepts.', {
      violations: [{ pointer: '/payload/kind', message: `The route accepts ${spec.command_kind} only.` }],
    });
  }
  return { kind: 'contract', contract: spec.contract, value: parsed.value, bytes };
}

type AttemptCaller = Extract<Caller, { kind: 'attempt' }>;

function writeRejection(
  tx: Queryable,
  context: RequestContext,
  route: RouteSpec,
  caller: AttemptCaller,
  failure: ApiFailure,
): Promise<void> {
  return writeAudit(tx, context.env.clock(), {
    eventType: 'attempt.late_submission_rejected',
    actor: caller.principal.id,
    subject: caller.attempt.attemptId,
    diagnosticRef: context.diagnosticRef,
    detail: { route: route.id, code: failure.code, ownership_revision: caller.attempt.ownershipRevision },
  });
}

async function recordRejection(
  context: RequestContext,
  route: RouteSpec,
  caller: Caller,
  failure: ApiFailure,
): Promise<void> {
  if (caller.kind !== 'attempt') return;
  await context.db.transaction((tx) => writeRejection(tx, context, route, caller, failure));
}

/**
 * Record the refusal of a late submission and give the route the chance to use what the submission carries (a usage that
 * settles a reservation). The body is read within the limit of the route and parsed as its contract; a body that does not
 * parse, or a late handler that fails, leaves only the refusal recorded, as for every other route.
 */
async function refuseLate(
  context: RequestContext,
  route: RouteSpec,
  caller: AttemptCaller,
  failure: ApiFailure,
  params: Readonly<Record<string, string>>,
  request: Request,
  late: LateHandler,
): Promise<void> {
  let body: ParsedBody | undefined;
  try {
    body = await readBody(route, request);
  } catch {
    await request.body?.cancel().catch(() => undefined);
  }
  if (body === undefined || body.kind !== 'contract') {
    await recordRejection(context, route, caller, failure);
    return;
  }
  const parsed = body;
  try {
    await context.db.transaction(async (tx) => {
      await writeRejection(tx, context, route, caller, failure);
      await late(tx, { ...context, route, caller, params, body: parsed, request });
    });
  } catch (error) {
    context.env.log({
      level: 'error',
      message: 'late submission: its usage was not settled',
      diagnostic_ref: context.diagnosticRef,
      attempt_id: caller.attempt.attemptId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    await recordRejection(context, route, caller, failure);
  }
}

export async function serveRoute(
  route: RouteSpec,
  context: RequestContext,
  request: Request,
  params: Readonly<Record<string, string>>,
  registry: Readonly<Record<string, Handler>>,
  late: Readonly<Record<string, LateHandler>> = {},
): Promise<Response> {
  const caller = await authenticate(context.env, context.db, request.headers.get('authorization'));
  if (caller === null) {
    await request.body?.cancel().catch(() => undefined);
    throw new ApiFailure('UNAUTHENTICATED', 'A valid credential is required.');
  }
  const denied = authorize(route, caller, params);
  if (denied !== undefined) {
    const fenced = denied.code === 'STALE_OWNERSHIP' || denied.code === 'LEASE_EXPIRED';
    const lateHandler = late[route.id];
    if (fenced && caller.kind === 'attempt' && lateHandler !== undefined) {
      await refuseLate(context, route, caller, denied, params, request, lateHandler);
      throw denied;
    }
    await request.body?.cancel().catch(() => undefined);
    if (fenced) await recordRejection(context, route, caller, denied);
    throw denied;
  }
  const body = await readBody(route, request);
  const handler = registry[route.id];
  if (handler === undefined) throw new Error(`The route ${route.id} has no handler.`);
  return handler({ ...context, route, caller, params, body, request });
}
