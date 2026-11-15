// Routes that a later part of the durable API builds. A route that has no handler yet
// still goes through the whole route layer: authentication, authorisation, the body limit and the contract parse. It
// then answers UNAVAILABLE and says which part is missing. api-error/1 has no "not implemented" code; UNAVAILABLE is
// in the error list of every route, and this answer is acceptable in this part only. Each later part moves its routes
// out of this table into the handler registry (index.ts); a test checks that every served route is in exactly one.

import { ApiFailure } from '../errors.ts';
import type { Handler } from './context.ts';

export interface DeferredGroup {
  readonly part: string;
  readonly routes: readonly string[];
}

export const deferredGroups: readonly DeferredGroup[] = [
  {
    part: 'P2 part C (attempts, results and recovery)',
    routes: [
      'attempts.claim',
      'attempts.input',
      'attempts.artefact',
      'attempts.retrieval-result',
      'attempts.validation-result',
      'attempts.evaluation-submission',
      'attempts.gate-report',
      'attempts.agent-result',
    ],
  },
  {
    part: 'P2 part C (read models of missions, runs and jobs)',
    routes: [
      'missions.show',
      'missions.plan',
      'missions.lineage',
      'missions.trials',
      'missions.findings',
      'missions.gates',
      'missions.decisions',
      'runs.metrics',
      'runs.result',
      'jobs.show',
    ],
  },
  {
    part: 'P2 part C (release records)',
    routes: ['releases.record'],
  },
];

export const deferredRouteIds: readonly string[] = deferredGroups.flatMap((group) => group.routes);

export function deferredHandler(routeId: string): Handler {
  const group = deferredGroups.find((entry) => entry.routes.includes(routeId));
  return async () => {
    throw new ApiFailure(
      'UNAVAILABLE',
      `The route ${routeId} is not implemented in this build: it belongs to ${group?.part ?? 'a later part'}.`,
      { retrySafe: false },
    );
  };
}
