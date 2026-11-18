// The routes this client calls, read from the route manifest packages/api-contracts/routes/v1.json (OQ-05 section 7).
// The manifest decides each route's method, path, success status and response body. This module checks once, at load,
// that every route the client names exists on the API host with the request and response it expects, so a manifest
// change that the client does not follow fails the client's own tests instead of a request.

import type { ContractName, ContractTypes } from '@openquant/api-contracts';
import manifestJson from '../../api-contracts/routes/v1.json' with { type: 'json' };

/** Each route the client calls and the contract of its success body. `access-token` is an API-owned view. */
export const CLIENT_ROUTES = {
  'auth.token': { method: 'POST', response: 'access-token' },
  'system.identity': { method: 'GET', response: 'system-identity-view' },
  'research-profiles.register': { method: 'POST', response: 'command', command: 'register_research_profile' },
  'cohort-policies.register': { method: 'POST', response: 'command', command: 'register_cohort_policy' },
  'budgets.register': { method: 'POST', response: 'command', command: 'register_budget' },
  'seeds.register': { method: 'POST', response: 'command', command: 'register_seed' },
  'missions.create': { method: 'POST', response: 'command', command: 'create_mission' },
  'missions.run-now': { method: 'POST', response: 'command', command: 'run_mission_now' },
  'missions.cancel': { method: 'POST', response: 'command', command: 'cancel_mission' },
  'missions.show': { method: 'GET', response: 'mission-view' },
  'missions.lineage': { method: 'GET', response: 'lineage-view' },
  'missions.trials': { method: 'GET', response: 'trials-view' },
  'missions.findings': { method: 'GET', response: 'findings-view' },
  'missions.gates': { method: 'GET', response: 'gates-view' },
  'missions.decisions': { method: 'GET', response: 'decisions-view' },
  'commands.show': { method: 'GET', response: 'command' },
  'jobs.show': { method: 'GET', response: 'job-view' },
} as const satisfies Record<
  string,
  { method: 'GET' | 'POST'; response: ContractName | 'access-token'; command?: string }
>;

export type RouteId = keyof typeof CLIENT_ROUTES;
export type CommandRouteId = {
  [K in RouteId]: (typeof CLIENT_ROUTES)[K] extends { command: string } ? K : never;
}[RouteId];
export type ViewRouteId = Exclude<RouteId, CommandRouteId | 'auth.token'>;
type ResponseName<K extends RouteId> = (typeof CLIENT_ROUTES)[K]['response'];
export type ViewOf<K extends ViewRouteId> =
  ResponseName<K> extends ContractName ? ContractTypes[ResponseName<K>] : never;

export interface Route {
  readonly id: RouteId;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly successStatus: number;
  /** The contract of the success body, or `access-token` for the token view. */
  readonly response: ContractName | 'access-token';
  readonly commandKind: string | undefined;
  /** Whether the route accepts a person's access token (any of `human`), or only a person's long-lived credential. */
  readonly humanAuth: 'access-token' | 'credential';
  readonly roles: readonly string[];
}

interface ManifestRoute {
  readonly id: string;
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly auth: readonly { readonly kind: string; readonly roles?: readonly string[] }[];
  readonly request: { readonly kind: string; readonly contract?: string; readonly command_kind?: string };
  readonly response: { readonly kind: string; readonly contract?: string; readonly view?: string; form?: string };
  readonly success_status: number;
}

const manifest = manifestJson as unknown as {
  readonly base_path: string;
  readonly error_status: Readonly<Record<string, number>>;
  readonly routes: readonly ManifestRoute[];
};

function load(): ReadonlyMap<RouteId, Route> {
  const routes = new Map<RouteId, Route>();
  for (const [id, expected] of Object.entries(CLIENT_ROUTES) as [
    RouteId,
    (typeof CLIENT_ROUTES)[RouteId] & { command?: string },
  ][]) {
    const found = manifest.routes.find((route) => route.id === id);
    if (found === undefined) throw new Error(`routes/v1.json has no route ${id}`);
    if (found.host !== 'api' || found.method !== expected.method || !found.path.startsWith(manifest.base_path)) {
      throw new Error(`routes/v1.json: ${id} is not the ${expected.method} route of the API that the client expects`);
    }
    const response =
      found.response.kind === 'view'
        ? found.response.view
        : found.response.kind === 'contract'
          ? found.response.contract
          : undefined;
    if (response !== expected.response) throw new Error(`routes/v1.json: ${id} does not return ${expected.response}`);
    if (expected.command !== undefined && found.request.command_kind !== expected.command) {
      throw new Error(`routes/v1.json: ${id} does not accept the command ${expected.command}`);
    }
    const human = found.auth.find((rule) => rule.kind === 'human');
    const credential = found.auth.some((rule) => rule.kind === 'human_credential');
    if (human === undefined && !credential) throw new Error(`routes/v1.json: ${id} accepts no person`);
    routes.set(id, {
      id,
      method: expected.method,
      path: found.path,
      successStatus: found.success_status,
      response: expected.response,
      commandKind: expected.command,
      humanAuth: human === undefined ? 'credential' : 'access-token',
      roles: human?.roles ?? [],
    });
  }
  return routes;
}

const routes = load();

export function route(id: RouteId): Route {
  const found = routes.get(id);
  if (found === undefined) throw new Error(`unknown route ${id}`);
  return found;
}

/** The path of a route with its parameters filled in, each encoded as one path segment. */
export function pathOf(id: RouteId, params: Readonly<Record<string, string>> = {}): string {
  return route(id).path.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new Error(`route ${id} needs the parameter ${name}`);
    return encodeURIComponent(value);
  });
}

/** The HTTP status the manifest gives an error code, or undefined for a code it does not list. */
export function statusOfCode(code: string): number | undefined {
  return manifest.error_status[code];
}
