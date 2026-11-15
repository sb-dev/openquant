// What a route handler receives. The route layer has already authenticated and authorised the caller, enforced the body
// limit and parsed the body as the contract of the route, so a handler works from checked input.

import type { ContractName, ContractTypes } from '@openquant/api-contracts';
import type { Caller } from '../auth/authenticate.ts';
import type { Queryable } from '../db/database.ts';
import type { RequestContext } from '../env.ts';
import type { RouteSpec } from '../manifest.ts';

export type ParsedBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'contract';
      readonly contract: ContractName;
      readonly value: ContractTypes[ContractName];
      readonly bytes: Uint8Array;
    };

export interface HandlerContext extends RequestContext {
  readonly route: RouteSpec;
  readonly caller: Caller;
  readonly params: Readonly<Record<string, string>>;
  readonly body: ParsedBody;
  readonly request: Request;
}

export type Handler = (context: HandlerContext) => Promise<Response>;

/**
 * What a route does with a submission from an attempt whose lease ended, besides the typed refusal that the route layer
 * answers (LEASE_EXPIRED or STALE_OWNERSHIP). It runs in the transaction that records the refusal and never changes the
 * answer: if it throws, only the refusal is recorded. The body is the one that the route's contract parsed.
 */
export type LateHandler = (tx: Queryable, context: HandlerContext) => Promise<void>;

export function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
