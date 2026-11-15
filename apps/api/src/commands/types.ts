// What an applier of a guarded command receives. The runner (runner.ts) has recorded the command as PENDING, taken its
// row lock and opened the transaction `tx`; the applier checks its preconditions, writes everything the command
// changes in `tx` with its audit row, and returns the record that it produced. It throws a Rejection to refuse.

import type { CommandRequest } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import type { WorkContext } from '../domain/attempts.ts';
import type { DispatchBuilders } from '../domain/dispatch.ts';
import type { Actor } from '../domain/rows.ts';
import type { ApiEnv } from '../env.ts';

export interface ApplyContext {
  readonly tx: Queryable;
  readonly env: ApiEnv;
  readonly actor: Actor;
  readonly request: CommandRequest;
  readonly builders: DispatchBuilders;
}

/** The record that a command produced: its identifier and revision (command/1 CommandRecord). */
export interface Produced {
  readonly id: string;
  readonly revision: number;
}

export type Applier<P> = (context: ApplyContext, payload: P) => Promise<Produced>;

export function workContext(context: ApplyContext): WorkContext {
  return { env: context.env, actorId: context.actor.principalId, builders: context.builders };
}
