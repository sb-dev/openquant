// The chain that every route of the manifest runs, in this order (OQ-05 sections 7 and 9):
//
//   1. authenticate: a missing, malformed, unknown, expired or revoked credential is UNAUTHENTICATED;
//   2. authorise by the credentials and roles that the manifest lists for the route: FORBIDDEN, or for an attempt
//      capability that lost its lease LEASE_EXPIRED or STALE_OWNERSHIP, with the rejection recorded;
//   3. refuse a body above the route's max_body_bytes with LIMIT_EXCEEDED, before any parse;
//   4. parse the body as the contract of the route, on bytes (parseContract), and map a ContractError onto api-error/1;
//   5. check the form and the command kind that the route accepts;
//   6. call the handler of the route, or the deferred answer of a route that a later part builds.
//
// A caller that fails step 1 or 2 never has its body read. The manifest, not this file, says which routes exist.

import { parseContract } from '@openquant/api-contracts';
import { writeAudit } from './audit.ts';
import { authenticate, type Caller } from './auth/authenticate.ts';
import { authorize } from './auth/authorize.ts';
import { readBounded } from './body.ts';
import type { RequestContext } from './env.ts';
import { ApiFailure, fromContractError } from './errors.ts';
import type { Handler, ParsedBody } from './handlers/context.ts';
import { deferredHandler } from './handlers/deferred.ts';
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

async function recordRejection(
  context: RequestContext,
  route: RouteSpec,
  caller: Caller,
  failure: ApiFailure,
): Promise<void> {
  if (caller.kind !== 'attempt') return;
  await context.db.transaction((tx) =>
    writeAudit(tx, context.env.clock(), {
      eventType: 'attempt.late_submission_rejected',
      actor: caller.principal.id,
      subject: caller.attempt.attemptId,
      diagnosticRef: context.diagnosticRef,
      detail: { route: route.id, code: failure.code, ownership_revision: caller.attempt.ownershipRevision },
    }),
  );
}

export async function serveRoute(
  route: RouteSpec,
  context: RequestContext,
  request: Request,
  params: Readonly<Record<string, string>>,
  registry: Readonly<Record<string, Handler>>,
): Promise<Response> {
  const caller = await authenticate(context.env, context.db, request.headers.get('authorization'));
  if (caller === null) {
    await request.body?.cancel().catch(() => undefined);
    throw new ApiFailure('UNAUTHENTICATED', 'A valid credential is required.');
  }
  const denied = authorize(route, caller, params);
  if (denied !== undefined) {
    await request.body?.cancel().catch(() => undefined);
    if (denied.code === 'STALE_OWNERSHIP' || denied.code === 'LEASE_EXPIRED')
      await recordRejection(context, route, caller, denied);
    throw denied;
  }
  const body = await readBody(route, request);
  const handler = registry[route.id] ?? deferredHandler(route.id);
  return handler({ ...context, route, caller, params, body, request });
}
