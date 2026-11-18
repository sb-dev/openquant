// The read routes against their contracts: every body is the view contract that the route manifest names for its route
// (routes/v1.json), such as mission-view/1. A test calls readViews on a mission in the state that it built.

import { type ContractName, validateContract } from '@openquant/api-contracts';
import { expect } from 'vitest';
import { apiRoutes } from '../../src/manifest.ts';
import { type Flow, json, type Started } from './flow.ts';
import type { Doc } from './world.ts';

/** The contract that the route manifest names for the response of a route. */
export function responseContractOf(routeId: string): ContractName {
  const route = apiRoutes.find((entry) => entry.id === routeId);
  if (route?.response.kind !== 'contract' || typeof route.response.contract !== 'string') {
    throw new Error(`The route ${routeId} returns no contract.`);
  }
  return route.response.contract as ContractName;
}

/** Check a response body against the contract of its route, and its version tag. */
export function expectContract(routeId: string, body: unknown, where = routeId): void {
  const contract = responseContractOf(routeId);
  const checked = validateContract(contract, body);
  expect(checked.ok ? 'valid' : checked.error.message, where).toBe('valid');
  expect((body as Doc).schema_version, where).toBe(`${contract}/1`);
}

/**
 * Read every read route of a mission (and system.identity) as a Viewer, and check each body against the contract of its
 * route. A job route is read for the first job and the first run when they exist. Returns the bodies by path.
 */
export async function readViews(flow: Flow & Started): Promise<Record<string, Doc>> {
  const viewer = await flow.person('viewer');
  const mission = flow.missionId;
  const routes: [string, string][] = [
    ['missions.show', `/v1/missions/${mission}`],
    ['missions.lineage', `/v1/missions/${mission}/lineage`],
    ['missions.trials', `/v1/missions/${mission}/trials`],
    ['missions.findings', `/v1/missions/${mission}/findings`],
    ['missions.gates', `/v1/missions/${mission}/gates`],
    ['missions.decisions', `/v1/missions/${mission}/decisions`],
    ['system.identity', '/v1/system/identity'],
  ];
  const jobs = await flow.world.sql<{ id: string }>(
    `(SELECT job_id AS id FROM jobs WHERE mission_id = $1 ORDER BY created_at, job_id LIMIT 1)
     UNION ALL (SELECT run_id AS id FROM runs WHERE mission_id = $1 ORDER BY run_slot LIMIT 1)`,
    [mission],
  );
  for (const job of jobs) routes.push(['jobs.show', `/v1/jobs/${job.id}`]);
  const views: Record<string, Doc> = {};
  for (const [routeId, path] of routes) {
    const response = await flow.send('GET', path, viewer);
    expect(response.status, path).toBe(200);
    const body = await json<Doc>(response);
    expectContract(routeId, body, path);
    views[path] = body;
  }
  return views;
}
