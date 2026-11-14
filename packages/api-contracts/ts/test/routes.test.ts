// The route manifest names contracts by short name (OQ-05 §7). Each one must be a generated
// contract, and each form a route selects must be a form of that contract.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  type ContractFailureCode,
  contracts,
  isContractName,
  MAX_PAYLOAD_BYTES,
  workerBodyLimit,
} from '../src/index.ts';
import { repositoryRoot } from './support/manifest.ts';

interface Body {
  readonly kind: string;
  readonly contract?: string;
  readonly form?: string;
}
interface Route {
  readonly id: string;
  readonly method: string;
  readonly auth: readonly { readonly kind: string; readonly roles?: readonly string[] }[];
  readonly request: Body;
  readonly response: Body;
  readonly errors: readonly string[];
  readonly max_body_bytes?: number;
}

const contractsDir = resolve(repositoryRoot, 'packages/api-contracts');
const manifest = JSON.parse(readFileSync(resolve(contractsDir, 'routes/v1.json'), 'utf8')) as {
  error_body: string;
  error_status: Record<string, number>;
  routes: Route[];
};

// The form values of a contract: the `form` enum of each oneOf branch of its root.
function forms(name: string): string[] {
  const schema = JSON.parse(readFileSync(resolve(contractsDir, `schemas/${name}.schema.json`), 'utf8'));
  const branches: { $ref: string }[] = schema.oneOf ?? [];
  return branches.flatMap(({ $ref }) => schema.$defs[$ref.replace('#/$defs/', '')]?.properties?.form?.enum ?? []);
}

test('every route body names a generated contract and an existing form', () => {
  expect(isContractName(manifest.error_body)).toBe(true);
  const bodies = manifest.routes.flatMap(
    (route) =>
      [
        [route.id, route.request],
        [route.id, route.response],
      ] as const,
  );
  const contractBodies = bodies.filter(([, body]) => body.kind === 'contract');
  expect(contractBodies.length).toBeGreaterThan(0);
  for (const [id, body] of contractBodies) {
    expect(body.contract !== undefined && isContractName(body.contract), `${id}: ${body.contract}`).toBe(true);
    if (body.form !== undefined) expect(forms(body.contract ?? ''), `${id}: form ${body.form}`).toContain(body.form);
  }
});

test('the contract-layer codes are 400 errors of every route manifest', () => {
  const codes: ContractFailureCode[] = ['SCHEMA_VIOLATION', 'UNSUPPORTED_SCHEMA_VERSION', 'INVALID_DECIMAL'];
  for (const code of codes) expect(manifest.error_status[code], code).toBe(400);
  expect(Object.keys(contracts)).toContain('api-error');
});

test('every route with a request body limits it to the Worker byte limit of its contract', () => {
  expect(manifest.error_status.LIMIT_EXCEEDED).toBe(413);
  const withBody = manifest.routes.filter((route) => route.request.kind !== 'none');
  expect(withBody.map((route) => route.request.kind).sort()).toContain('bytes');
  for (const route of withBody) {
    const name = route.request.contract;
    // test/memory.test.ts parses the densest bodies of each contract at its limit within 64 MiB.
    // A bytes body is hashed and stored, not parsed.
    const limit =
      route.request.kind === 'bytes'
        ? MAX_PAYLOAD_BYTES
        : name !== undefined && isContractName(name)
          ? workerBodyLimit(name)
          : undefined;
    expect(limit, `${route.id}: ${route.request.kind} ${name}`).toBeDefined();
    expect(route.max_body_bytes, route.id).toBe(limit);
    expect(route.errors, route.id).toContain('LIMIT_EXCEEDED');
  }
  for (const route of manifest.routes) {
    if (route.request.kind === 'none') expect(route.max_body_bytes, route.id).toBeUndefined();
  }
  // The routes that accept command/1, which holds a recursive Expr tree, get the small limit.
  const commandRoutes = withBody.filter((route) => route.request.contract === 'command');
  expect(commandRoutes.length).toBeGreaterThan(0);
  for (const route of commandRoutes) expect(route.max_body_bytes, route.id).toBe(512 * 1024);
});

// OQ-04 §5: the CLI shows each candidate's D, V and H runs with the base and cost-stress cases,
// both benchmarks and the policy's uncertainty limitation, as official values that it never
// recomputes (OQ-05 §7). Every metric OQ-02 §3.6 defines must therefore come from a contract body
// that a Viewer can read, not from a view or from arithmetic on other values.
describe('official run values are served as contract bodies', () => {
  type Schema = Record<string, unknown>;
  const bundle = JSON.parse(readFileSync(resolve(contractsDir, 'ts/dist/generated/bundle.json'), 'utf8')) as {
    $defs: Record<string, Schema>;
  };

  // The schemas a value at `path` can have, through references and oneOf forms.
  function at(schema: Schema, path: readonly string[]): Schema[] {
    if (typeof schema.$ref === 'string') return at(bundle.$defs[schema.$ref.replace('#/$defs/', '')] ?? {}, path);
    if (Array.isArray(schema.oneOf)) return (schema.oneOf as Schema[]).flatMap((form) => at(form, path));
    const [head, ...rest] = path;
    if (head === undefined) return [schema];
    const child = (schema.properties as Record<string, Schema> | undefined)?.[head];
    return child === undefined ? [] : at(child, rest);
  }

  const viewerRoute = (contract: string) =>
    manifest.routes.find(
      (route) =>
        route.method === 'GET' &&
        route.response.kind === 'contract' &&
        route.response.contract === contract &&
        route.auth.some((auth) => auth.kind === 'human' && auth.roles?.includes('Viewer')),
    );

  test('a Viewer reads the committed metrics and result of a run', () => {
    expect(viewerRoute('evaluation-metrics')?.id).toBe('runs.metrics');
    expect(viewerRoute('evaluation-result')?.id).toBe('runs.result');
  });

  // Where evaluation-metrics/1 carries each metric that a gate threshold can name.
  const served: Record<string, readonly string[]> = {
    net_return: ['strategy', 'net_return', 'value'],
    max_drawdown: ['strategy', 'max_drawdown', 'value'],
    worst_session_return: ['strategy', 'worst_session_return', 'value'],
    turnover: ['strategy', 'turnover', 'value'],
    trade_count: ['strategy', 'trade_count', 'value'],
    scored_session_count: ['strategy', 'scored_session_count', 'value'],
    execution_cost: ['strategy', 'execution_cost', 'total', 'value'],
    exposure: ['strategy', 'exposure', 'value'],
    buy_and_hold_return: ['benchmarks', 'buy_and_hold', 'net_return', 'value'],
    excess_return_over_buy_and_hold: ['benchmarks', 'buy_and_hold', 'excess_return', 'value'],
  };

  test('every metric name has a place in evaluation-metrics/1', () => {
    const names = (bundle.$defs.MetricName?.enum ?? []) as string[];
    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(served).sort()).toEqual([...names].sort());
    const root = bundle.$defs.EvaluationMetrics ?? {};
    for (const [name, path] of Object.entries(served)) expect(at(root, path), name).not.toEqual([]);
  });

  test('the window, cost case, cash benchmark and uncertainty limitation come with them', () => {
    const root = bundle.$defs.EvaluationMetrics ?? {};
    for (const path of [
      ['window', 'role'],
      ['window', 'cost_scenario'],
      ['window', 'scored'],
      ['benchmarks', 'cash', 'net_return', 'value'],
      ['benchmarks', 'cash', 'excess_return', 'value'],
      ['uncertainty', 'limitation'],
    ]) {
      expect(at(root, path), path.join('/')).not.toEqual([]);
    }
  });
});
