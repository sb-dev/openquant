// The route manifest names contracts by short name (OQ-05 §7). Each one must be a generated
// contract, and each form a route selects must be a form of that contract.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { type ContractFailureCode, contracts, isContractName } from '../src/index.ts';
import { repositoryRoot } from './support/manifest.ts';

interface Body {
  readonly kind: string;
  readonly contract?: string;
  readonly form?: string;
}
interface Route {
  readonly id: string;
  readonly request: Body;
  readonly response: Body;
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
