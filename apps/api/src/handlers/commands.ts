// The seven command routes and commands.show (OQ-05 sections 3 and 9). The route layer has already authenticated and
// authorised the caller, refused a body above its limit and parsed it as command/1 in the request form, with the
// command kind that the route accepts. A handler hands the command to the runner, which gives it the life described in
// commands/runner.ts. A command that the system refuses answers with the api-error/1 of its refusal, and the same
// command ID answers the same way again. `commands.show` reads any command back, the answer of a client that timed out.

import type { CommandRequest } from '@openquant/api-contracts';
import type { Caller } from '../auth/authenticate.ts';
import { type CommandOutcome, executeCommand, readCommand } from '../commands/runner.ts';
import type { Actor } from '../domain/rows.ts';
import { ApiFailure } from '../errors.ts';
import { type Handler, json } from './context.ts';

/** The principal of a caller that may apply commands: a person with an access token, or a service principal. */
export function actorOf(caller: Caller): Actor | undefined {
  switch (caller.kind) {
    case 'human':
      return { principalId: caller.principal.id, kind: 'HUMAN', serviceKind: null, roles: caller.roles };
    case 'service':
      return {
        principalId: caller.principal.id,
        kind: 'SERVICE',
        serviceKind: caller.principal.serviceKind,
        roles: [],
      };
    default:
      return undefined;
  }
}

function answer(outcome: CommandOutcome, successStatus: number): Response {
  if (outcome.state === 'REJECTED') throw outcome.failure;
  return json(successStatus, outcome.status);
}

/** A command route: the body is a command of the kind that the route names, for the mission that its path names. */
export const applyCommand: Handler = async ({ env, db, caller, params, body, route }) => {
  const actor = actorOf(caller);
  if (actor === undefined) throw new ApiFailure('FORBIDDEN', 'This credential may not apply commands.');
  if (body.kind !== 'contract') throw new Error(`The route ${route.id} has no command body.`);
  const request = body.value as CommandRequest;
  const { payload } = request;
  if ('mission_id' in payload && params.mission_id !== undefined && payload.mission_id !== params.mission_id) {
    throw new ApiFailure('SCHEMA_VIOLATION', 'The mission of the command is not the mission of the path.', {
      violations: [{ pointer: '/payload/mission_id', message: 'It must equal the mission_id of the path.' }],
    });
  }
  return answer(await executeCommand({ env, db, actor }, request), route.success_status);
};

export const showCommand: Handler = async ({ db, params, route }) => {
  const outcome = await readCommand(db, params.command_id ?? '');
  if (outcome === undefined) throw new ApiFailure('NOT_FOUND', 'No command has this ID.');
  return json(route.success_status, outcome.status);
};
