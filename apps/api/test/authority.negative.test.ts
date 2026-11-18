// Authority that a service principal must not have (OQ-05 section 9, OQ-02 sections 1 and 4, R10): with the
// credentials that bootstrap issues (the operations of the route manifest, tools/bootstrap.ts) and with the attempt
// capabilities that real claims grant, not with test credentials scoped to every route.
//
//   - the runner, and the capability of an agent attempt, write no submission of the batch host, even a schema-valid
//     one for their own attempt;
//   - no service principal creates or enlarges a budget, and an agent's usage above its reservation enlarges no pool;
//   - the batch principal records no Decision, through any route or command.
//
// auth-matrix.test.ts already proves the route table with synthetic bodies; this file adds valid bodies, real claims
// and the budget and Decision records themselves.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueCredential } from '../src/auth/credentials.ts';
import type { ServiceKind } from '../src/manifest.ts';
import { serviceOperations } from '../tools/bootstrap.ts';
import {
  AGENT_RUNNER,
  claim,
  errorCode,
  type Flow,
  outboxOf,
  type Started,
  startAgent,
  startedFlow,
  submit,
} from './support/flow.ts';
import { ids } from './support/seed.ts';
import { agentResultDoc } from './support/steps.ts';
import { actorOf, type Doc, fixture } from './support/world.ts';

let flow: Flow & Started;
const bootstrapped = {} as Record<ServiceKind, string>;
const services = ['batch', 'runner', 'workflows', 'deploy'] as const;

beforeAll(async () => {
  flow = await startedFlow();
  const principal: Record<ServiceKind, string> = {
    batch: ids.batch,
    runner: ids.runner,
    workflows: ids.workflows,
    deploy: ids.deploy,
  };
  await flow.world.tx(async (tx) => {
    for (const kind of services) {
      bootstrapped[kind] = (
        await issueCredential(tx, flow.world.testApp.env.ids, flow.world.testApp.clock.now(), {
          principalId: principal[kind],
          principalKind: 'SERVICE',
          operations: serviceOperations(kind),
          issuedBy: ids.admin,
        })
      ).token;
    }
  });
});
afterAll(async () => {
  await flow.world.drop();
});

/** A body of each batch result route that its contract accepts, for the attempt of the path. */
function batchResults(attemptId: string): [string, Doc][] {
  const bodies: [string, Doc][] = [
    ['retrieval-result', fixture('retrieval-result.complete.json')],
    ['validation-result', fixture('validation-result.valid-seed.json')],
    ['evaluation-submission', fixture('evaluation-submission.not-prepared.json')],
    ['gate-report', fixture('gate-report.no-eligible-candidate.json')],
  ];
  for (const [, body] of bodies) body.attempt = { attempt_id: attemptId, ownership_revision: 1 };
  return bodies;
}

describe('the runner and the capability of an agent attempt', () => {
  it('write no batch submission, even a schema-valid one for their own claimed attempt, and change nothing', async () => {
    const agent = await startAgent(flow, { role: 'CRITIC' });
    const claimed = await claim(flow, agent.attemptId, 'runner', AGENT_RUNNER);
    const before = await flow.world.snapshot(['audit_events']);
    const problems: string[] = [];
    for (const [route, body] of batchResults(agent.attemptId)) {
      for (const [label, token] of [
        ['the live capability of the agent attempt', claimed.token],
        ['the runner credential of bootstrap', bootstrapped.runner],
      ] as const) {
        const response = await submit(flow, { attemptId: agent.attemptId, token }, route, body);
        if (response.status !== 403 || (await errorCode(response)) !== 'FORBIDDEN')
          problems.push(`${route} with ${label}: ${response.status}`);
      }
    }
    expect(problems).toEqual([]);
    expect(await flow.world.snapshot(['audit_events'])).toEqual(before);
    const [attempt] = await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [
      agent.attemptId,
    ]);
    expect(attempt?.status).toBe('CLAIMED');
  });
});

describe('budgets', () => {
  it('cannot be created or enlarged by any service principal, through the route or the command runner', async () => {
    const before = await flow.world.sql(`SELECT * FROM budget_caps ORDER BY budget_id, revision`);
    const pools = await flow.world.sql(`SELECT * FROM budget_pools ORDER BY pool_id`);
    const enlarged = structuredClone(flow.world.docs.budget) as Doc;
    enlarged.revision = 2;
    enlarged.provider_requests = 1_000_000;
    enlarged.model_spend = { amount: '100000.00', currency: enlarged.model_spend.currency };
    const created = { ...structuredClone(enlarged), budget_id: 'service-made-budget', revision: 1 };
    for (const kind of services) {
      for (const [budget, expected] of [
        [enlarged, 1],
        [created, 0],
      ] as const) {
        const request = flow.world.command({ kind: 'register_budget', budget }, { expectedRevision: expected });
        const response = await flow.send('POST', '/v1/budgets', bootstrapped[kind], request);
        expect([response.status, await errorCode(response)], `${kind}`).toEqual([403, 'FORBIDDEN']);
        await expect(flow.world.execute(kind, request), kind).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    expect(await flow.world.sql(`SELECT * FROM budget_caps ORDER BY budget_id, revision`)).toEqual(before);
    expect(await flow.world.sql(`SELECT * FROM budget_pools ORDER BY pool_id`)).toEqual(pools);
    expect(
      await flow.world.sql(`SELECT 1 FROM commands WHERE kind = 'register_budget' AND actor_id LIKE 'svc-%'`),
    ).toEqual([]);
  });

  it('are not enlarged by an agent that reports more than its reservation: the overrun blocks the mission', async () => {
    const agent = await startAgent(flow, { role: 'CRITIC' });
    const claimed = await claim(flow, agent.attemptId, 'runner', AGENT_RUNNER);
    const limits = () =>
      flow.world.sql<{ pool_id: number; limit_amount: string }>(
        'SELECT pool_id::int AS pool_id, limit_amount::text AS limit_amount FROM budget_pools ORDER BY pool_id',
      );
    const before = await limits();
    const { message } = await outboxOf(flow, agent.attemptId);
    const report = agentResultDoc(
      claimed,
      message,
      { outcome: 'timeout', diagnostic: 'Deadline reached.' },
      (result) => {
        result.usage.cost = { label: 'estimated', amount: '900.00', currency: 'USD' };
      },
    );
    const response = await submit(flow, claimed, 'agent-result', report);
    expect(response.status, await response.clone().text()).toBe(204);
    // No limit moved; the usage above the reservation is an overrun on the pool, and the mission is BLOCKED.
    expect(await limits()).toEqual(before);
    const [pool] = await flow.world.sql<{ committed: string; limit_amount: string; overrun: string }>(
      `SELECT committed::text AS committed, limit_amount::text AS limit_amount, overrun::text AS overrun
         FROM budget_pools WHERE mission_id = $1 AND configuration_id = 'critic'`,
      [flow.missionId],
    );
    expect(Number(pool?.committed)).toBeLessThanOrEqual(Number(pool?.limit_amount));
    expect(Number(pool?.overrun)).toBeGreaterThan(0);
    const [mission] = await flow.world.sql<{ status: string }>('SELECT status FROM missions WHERE mission_id = $1', [
      flow.missionId,
    ]);
    expect(mission?.status).toBe('BLOCKED');
  });
});

describe('the batch principal', () => {
  it('records no Decision: no command route takes its credential and the command runner refuses both Decision kinds', async () => {
    const before = await flow.world.sql('SELECT * FROM decisions ORDER BY decision_id');
    const routes: [string, Doc][] = [
      ['/v1/research-profiles', { kind: 'register_research_profile', profile: flow.world.docs.profile }],
      ['/v1/cohort-policies', { kind: 'register_cohort_policy', policy: flow.world.docs.policy }],
      ['/v1/missions', { kind: 'create_mission', mission: {} }],
      [`/v1/missions/${flow.missionId}/run-now`, { kind: 'run_mission_now', mission_id: flow.missionId }],
      [`/v1/missions/${flow.missionId}/cancel`, { kind: 'cancel_mission', mission_id: flow.missionId, reason: 'x' }],
    ];
    for (const [path, payload] of routes) {
      const response = await flow.send('POST', path, bootstrapped.batch, flow.world.command(payload));
      expect([response.status, await errorCode(response)], path).toEqual([403, 'FORBIDDEN']);
    }
    for (const kind of ['record_evaluation_decision', 'freeze_candidates'] as const) {
      await expect(
        flow.world.execute(actorOf('batch'), flow.world.command({ kind, mission_id: flow.missionId })),
        kind,
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await flow.world.sql('SELECT * FROM decisions ORDER BY decision_id')).toEqual(before);
    // Its credential reaches only the batch routes of the manifest: the claim, and nothing that a person or the
    // workflows principal calls.
    expect(serviceOperations('batch').sort()).toEqual(['attempts.claim']);
    const identity = await flow.send('GET', '/v1/system/identity', bootstrapped.batch);
    expect(identity.status).toBe(403);
  });
});
