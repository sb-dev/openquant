// The route manifest as the API serves it (OQ-05 section 7): packages/api-contracts/routes/v1.json is the source, read
// at build time. This module checks its shape once, so the route layer works from typed data and a route that the
// code does not know fails at start, not on a request.

import type { ContractName } from '@openquant/api-contracts';
import { isContractName } from '@openquant/api-contracts';
import manifestJson from '../../../packages/api-contracts/routes/v1.json' with { type: 'json' };

export const ROLES = ['Viewer', 'Researcher', 'Steward', 'Administrator'] as const;
export type Role = (typeof ROLES)[number];

export const SERVICE_KINDS = ['batch', 'runner', 'workflows', 'deploy'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export type AuthRule =
  | { readonly kind: 'human_credential' }
  | { readonly kind: 'human'; readonly roles: readonly Role[] }
  | { readonly kind: 'service'; readonly principals: readonly ServiceKind[] }
  | { readonly kind: 'attempt'; readonly principals: readonly ServiceKind[] };

export type RequestSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'bytes' }
  | {
      readonly kind: 'contract';
      readonly contract: ContractName;
      readonly form?: string;
      readonly command_kind?: string;
    };

export interface RouteSpec {
  readonly id: string;
  readonly host: 'api' | 'agent-runner';
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly auth: readonly AuthRule[];
  readonly request: RequestSpec;
  readonly max_body_bytes?: number;
  readonly response: { readonly kind: string; readonly [field: string]: unknown };
  readonly success_status: number;
  readonly errors: readonly string[];
}

export interface Manifest {
  readonly version: string;
  readonly base_path: string;
  readonly common_errors: readonly string[];
  readonly error_status: Readonly<Record<string, number>>;
  readonly routes: readonly RouteSpec[];
}

function fail(message: string): never {
  throw new Error(`routes/v1.json: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    fail(`${what} must be a list of strings`);
  return value as string[];
}

function parseAuth(value: unknown, route: string): AuthRule {
  if (!isRecord(value)) fail(`${route}: an auth entry must be an object`);
  switch (value.kind) {
    case 'human_credential':
      return { kind: 'human_credential' };
    case 'human': {
      const roles = stringList(value.roles, `${route}: roles`);
      if (!roles.every((role): role is Role => (ROLES as readonly string[]).includes(role)))
        fail(`${route}: unknown role`);
      return { kind: 'human', roles: roles as Role[] };
    }
    case 'service':
    case 'attempt': {
      const principals = stringList(value.principals, `${route}: principals`);
      if (!principals.every((kind) => (SERVICE_KINDS as readonly string[]).includes(kind)))
        fail(`${route}: unknown principal`);
      return { kind: value.kind, principals: principals as ServiceKind[] };
    }
    default:
      return fail(`${route}: unknown auth kind ${String(value.kind)}`);
  }
}

function parseRequest(value: unknown, route: string): RequestSpec {
  if (!isRecord(value)) fail(`${route}: request must be an object`);
  if (value.kind === 'none' || value.kind === 'bytes') return { kind: value.kind };
  if (value.kind !== 'contract') return fail(`${route}: unknown request kind ${String(value.kind)}`);
  const contract = value.contract;
  if (typeof contract !== 'string' || !isContractName(contract)) fail(`${route}: unknown contract ${String(contract)}`);
  return {
    kind: 'contract',
    contract: contract as ContractName,
    ...(typeof value.form === 'string' ? { form: value.form } : {}),
    ...(typeof value.command_kind === 'string' ? { command_kind: value.command_kind } : {}),
  };
}

function parseRoute(value: unknown): RouteSpec {
  if (!isRecord(value) || typeof value.id !== 'string') return fail('a route needs an id');
  const id = value.id;
  const { host, method, path } = value;
  if (host !== 'api' && host !== 'agent-runner') fail(`${id}: unknown host`);
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT') fail(`${id}: unknown method`);
  if (typeof path !== 'string' || !path.startsWith('/')) fail(`${id}: path must start with /`);
  if (!Array.isArray(value.auth) || value.auth.length === 0) fail(`${id}: auth must list a credential`);
  const request = parseRequest(value.request, id);
  const limit = value.max_body_bytes;
  if (
    request.kind === 'none'
      ? limit !== undefined
      : typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1
  ) {
    fail(`${id}: max_body_bytes is required exactly when the route has a request body`);
  }
  if (!isRecord(value.response) || typeof value.response.kind !== 'string') fail(`${id}: response must name a kind`);
  if (typeof value.success_status !== 'number') fail(`${id}: success_status must be a number`);
  return {
    id,
    host: host as 'api' | 'agent-runner',
    method: method as 'GET' | 'POST' | 'PUT',
    path: path as string,
    auth: (value.auth as unknown[]).map((entry) => parseAuth(entry, id)),
    request,
    ...(typeof limit === 'number' ? { max_body_bytes: limit } : {}),
    response: value.response as RouteSpec['response'],
    success_status: value.success_status as number,
    errors: stringList(value.errors, `${id}: errors`),
  };
}

export function parseManifest(json: unknown): Manifest {
  if (!isRecord(json) || json.schema !== 'api-route-manifest/1') fail('schema must be api-route-manifest/1');
  if (typeof json.version !== 'string' || typeof json.base_path !== 'string')
    fail('version and base_path are required');
  if (!isRecord(json.error_status)) fail('error_status must be an object');
  const statuses: Record<string, number> = {};
  for (const [code, status] of Object.entries(json.error_status)) {
    if (typeof status !== 'number') fail(`error_status of ${code} must be a number`);
    statuses[code] = status;
  }
  if (!Array.isArray(json.routes)) fail('routes must be a list');
  const routes = json.routes.map(parseRoute);
  if (new Set(routes.map((route) => route.id)).size !== routes.length) fail('route ids must be unique');
  return {
    version: json.version,
    base_path: json.base_path,
    common_errors: stringList(json.common_errors, 'common_errors'),
    error_status: statuses,
    routes,
  };
}

export const manifest: Manifest = parseManifest(manifestJson);

/** The routes that this host serves. The agent-runner dispatch endpoint belongs to the runner, not to the API. */
export const apiRoutes: readonly RouteSpec[] = manifest.routes.filter((route) => route.host === 'api');

/** `/v1/attempts/{attempt_id}/claim` as a Hono path: `/v1/attempts/:attempt_id/claim`. */
export function honoPath(path: string): string {
  return path.replace(/\{([a-z_]+)\}/g, ':$1');
}

/** The HTTP status of an error code, as the manifest maps it. */
export function statusOf(code: string): number {
  const status = manifest.error_status[code];
  if (status === undefined) throw new Error(`routes/v1.json maps no status to ${code}`);
  return status;
}

/** The error codes that a route may answer with: its own and the common ones (README of the route manifest). */
export function allowedErrors(route: RouteSpec): ReadonlySet<string> {
  return new Set([...route.errors, ...manifest.common_errors]);
}
