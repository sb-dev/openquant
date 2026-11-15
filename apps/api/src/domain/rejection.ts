// A command can be refused for a reason that belongs to the state of the system, not to the request: a stale expected
// revision, a record that does not exist, a policy rule, an exhausted budget, a binding that differs. Such a refusal is
// a Rejection. The command runner records it, so the same command ID returns the same answer, and no state changed.
// Anything else that an ApiFailure can say (an unavailable database, a missing role) is not recorded: it did not
// decide the command.

import type { ApiErrorCode } from '@openquant/api-contracts';
import { ApiFailure, type FailureOptions } from '../errors.ts';

const RECORDED: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  'REVISION_CONFLICT',
  'NOT_FOUND',
  'POLICY_VIOLATION',
  'BUDGET_EXHAUSTED',
  'IDENTITY_MISMATCH',
]);

export class Rejection extends ApiFailure {
  /** A refusal for want of budget blocks the mission that asked, with this reason, in the same transaction as the refusal. */
  readonly blockMission: { readonly missionId: string; readonly reason: string } | undefined;

  constructor(code: ApiErrorCode, message: string, options: RejectionOptions = {}) {
    super(code, message, options);
    this.name = 'Rejection';
    this.blockMission = options.blockMission;
  }
}

export interface RejectionOptions extends FailureOptions {
  readonly blockMission?: { readonly missionId: string; readonly reason: string };
}

export function reject(code: ApiErrorCode, message: string, options: RejectionOptions = {}): Rejection {
  if (!RECORDED.has(code)) throw new Error(`${code} is not a code that a command refusal records.`);
  return new Rejection(code, message, options);
}

export function revisionConflict(what: string, current: number): Rejection {
  return reject('REVISION_CONFLICT', `${what} is at revision ${current}, not the expected one.`, {
    currentRevision: current,
  });
}

export function isRecordedRefusal(error: unknown): error is ApiFailure {
  return error instanceof ApiFailure && RECORDED.has(error.code);
}
