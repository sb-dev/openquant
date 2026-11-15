// The route manifest names contracts by short name (OQ-05 §7). Each one must be a generated
// contract, and each form a route selects must be a form of that contract.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  type ContractFailureCode,
  type ContractName,
  contracts,
  DECIMAL_PATTERN,
  EXACT_PATTERN,
  isContractName,
  MAX_PAYLOAD_BYTES,
  parseContract,
  workerBodyLimit,
} from '../src/index.ts';
import { fixturesDir, readManifest, repositoryRoot } from './support/manifest.ts';

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

// OQ-05 §7: a malformed decimal is INVALID_DECIMAL only when it is the document's only kind of
// violation. Under a failing oneOf the other branches add violations, so the code is
// SCHEMA_VIOLATION. A route therefore lists INVALID_DECIMAL only when its request contract has a
// decimal field that no oneOf lies above: command/1, for one, has a oneOf root and never gives it.
describe('INVALID_DECIMAL in the route manifest', () => {
  type Schema = Record<string, unknown>;
  const bundle = JSON.parse(readFileSync(resolve(contractsDir, 'ts/dist/generated/bundle.json'), 'utf8')) as {
    $defs: Record<string, Schema>;
  };
  const refName = (schema: Schema) =>
    typeof schema.$ref === 'string' ? schema.$ref.replace('#/$defs/', '') : undefined;

  // True when a Decimal or Exact value can be reached from the contract without a oneOf or anyOf on the way.
  function reachesDecimal(schema: Schema, seen: Set<string> = new Set()): boolean {
    const name = refName(schema);
    if (name === 'Decimal' || name === 'Exact') return true;
    if (name !== undefined) {
      if (seen.has(name)) return false;
      seen.add(name);
      if (reachesDecimal(bundle.$defs[name] ?? {}, seen)) return true;
    }
    const children: Schema[] = [
      ...((schema.allOf as Schema[] | undefined) ?? []),
      ...Object.values((schema.properties as Record<string, Schema> | undefined) ?? {}),
    ];
    for (const key of ['items', 'additionalProperties'] as const) {
      const child = schema[key];
      if (typeof child === 'object' && child !== null) children.push(child as Schema);
    }
    return children.some((child) => reachesDecimal(child, seen));
  }

  const MALFORMED = ['1e5', '01.5', 'abc'];
  const decimal = new RegExp(DECIMAL_PATTERN, 'u');
  const exact = new RegExp(EXACT_PATTERN, 'u');

  // The codes that the contract layer gives when one decimal-shaped string of a valid fixture of the
  // contract is replaced by a malformed one, for each such string in turn.
  function codesOfMutations(contract: ContractName): Set<string> {
    const codes = new Set<string>();
    const walk = (root: unknown, node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const holder = node as Record<string, unknown>;
      for (const key of Object.keys(holder)) {
        const value = holder[key];
        if (typeof value === 'string' && (decimal.test(value) || exact.test(value))) {
          for (const text of MALFORMED) {
            holder[key] = text;
            const result = parseContract(contract, JSON.stringify(root));
            if (!result.ok) codes.add(result.error.code);
          }
          holder[key] = value;
        } else {
          walk(root, value);
        }
      }
    };
    for (const entry of readManifest().entries) {
      if (entry.contract !== contract || entry.expect !== 'valid') continue;
      const document = JSON.parse(readFileSync(resolve(fixturesDir, entry.path), 'utf8')) as unknown;
      walk(document, document);
    }
    return codes;
  }

  const requestContracts = [
    ...new Set(manifest.routes.flatMap((route) => (route.request.contract ? [route.request.contract] : []))),
  ].filter(isContractName);
  const reaches = new Map(
    requestContracts.map((name) => [name, reachesDecimal({ $ref: `#/$defs/${contracts[name].typeName}` })]),
  );

  test('a route lists it exactly when its request contract has a decimal that no oneOf lies above', () => {
    expect(requestContracts).toContain('command');
    expect(requestContracts).toContain('agent-dispatch');
    expect(reaches.get('command')).toBe(false);
    expect(reaches.get('agent-dispatch')).toBe(true);
    for (const route of manifest.routes) {
      const name = route.request.contract;
      const listed = route.errors.includes('INVALID_DECIMAL');
      if (name === undefined || !isContractName(name)) expect(listed, route.id).toBe(false);
      else expect(listed, `${route.id} (${name})`).toBe(reaches.get(name));
    }
  });

  test('a malformed decimal in a valid body of a request contract gives INVALID_DECIMAL exactly when the manifest lists it', () => {
    for (const name of requestContracts) {
      const codes = codesOfMutations(name);
      // Every other code is SCHEMA_VIOLATION: a mutation never changes the version tag.
      expect(
        [...codes].filter((code) => code !== 'INVALID_DECIMAL' && code !== 'SCHEMA_VIOLATION'),
        name,
      ).toEqual([]);
      expect(codes.has('INVALID_DECIMAL'), name).toBe(reaches.get(name));
    }
  });
});
