// The command runner (OQ-05 sections 3, 4 and 9; command/1). A command has a client command ID, a body digest and an
// expected revision of its target. The runner gives each guarded command the same life:
//
//   1. accepted: one transaction records the command as PENDING, durable, with the digest of its body and its actor.
//      The same ID with the same body and actor returns the first result; with another body or another actor it is
//      COMMAND_ID_REUSED. Nothing else is written, so a command that the caller may not apply leaves no row.
//   2. applied: one transaction takes the command row lock, checks that the command is still PENDING, runs the applier
//      of its kind and marks the command APPLIED with the record it produced, together with every change and audit
//      row of the applier. Two requests with one ID queue on the lock: the first applies, the second reads its result.
//   3. rejected: a refusal that belongs to the state of the system (a stale revision, a missing record, a policy rule, no
//      budget, a binding that differs) rolls back everything of step 2 and is recorded in a third transaction, with the
//      reason. A mission that a refusal for want of budget names is blocked in that transaction. The same ID then
//      returns the same refusal. Any other failure (a database that is down) rolls back and leaves the command PENDING:
//      it decided nothing, and a retry with the same ID applies it.
//
// A command that stays PENDING is retried by its ID; a client that timed out reads it back (`commands.show`) and never
// assumes that nothing changed.

import type {
  CommandApplied,
  CommandKind,
  CommandPending,
  CommandRejected,
  CommandRequest,
  UtcTimestamp,
} from '@openquant/api-contracts';
import { digest } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import type { Database, Queryable } from '../db/database.ts';
import { type DispatchBuilders, defaultBuilders } from '../domain/dispatch.ts';
import { blockMission } from '../domain/missions.ts';
import { isRecordedRefusal, Rejection } from '../domain/rejection.ts';
import { type Actor, hasRole, isService, lockMission } from '../domain/rows.ts';
import type { ApiEnv } from '../env.ts';
import { ApiFailure } from '../errors.ts';
import { freezeCandidates, recordEvaluationDecision } from './decisions.ts';
import { cancelMission, createMission, runMissionNow } from './missions.ts';
import { registerBudget, registerCohortPolicy, registerResearchProfile, registerSeed } from './registrations.ts';
import type { ApplyContext, Produced } from './types.ts';

/** Who may apply each kind (OQ-05 section 9). Roles have no hierarchy: an Administrator is not a Steward. */
const AUTHORITY: Readonly<Record<CommandKind, (actor: Actor) => boolean>> = {
  register_research_profile: (actor) => hasRole(actor, 'Steward'),
  register_cohort_policy: (actor) => hasRole(actor, 'Steward'),
  register_budget: (actor) => hasRole(actor, 'Steward'),
  register_seed: (actor) => hasRole(actor, 'Researcher'),
  create_mission: (actor) => hasRole(actor, 'Researcher'),
  run_mission_now: (actor) => hasRole(actor, 'Researcher'),
  cancel_mission: (actor) => hasRole(actor, 'Researcher'),
  // Internal commands: the workflows service principal only, and no route accepts them.
  record_evaluation_decision: (actor) => isService(actor, 'workflows'),
  freeze_candidates: (actor) => isService(actor, 'workflows'),
};

export function mayApply(kind: CommandKind, actor: Actor): boolean {
  return AUTHORITY[kind](actor);
}

async function apply(context: ApplyContext): Promise<Produced> {
  const { payload } = context.request;
  switch (payload.kind) {
    case 'register_research_profile':
      return registerResearchProfile(context, payload);
    case 'register_cohort_policy':
      return registerCohortPolicy(context, payload);
    case 'register_budget':
      return registerBudget(context, payload);
    case 'register_seed':
      return registerSeed(context, payload);
    case 'create_mission':
      return createMission(context, payload);
    case 'run_mission_now':
      return runMissionNow(context, payload);
    case 'cancel_mission':
      return cancelMission(context, payload);
    case 'record_evaluation_decision':
      return recordEvaluationDecision(context, payload);
    case 'freeze_candidates':
      return freezeCandidates(context, payload);
  }
}

interface CommandRow {
  command_id: string;
  kind: CommandKind;
  actor_id: string;
  body_digest: string;
  state: 'PENDING' | 'APPLIED' | 'REJECTED';
  received_at: Date;
  applied_at: Date | null;
  rejected_at: Date | null;
  record_id: string | null;
  record_revision: number | null;
  error_code: string | null;
  error_message: string | null;
}

const COLUMNS = `command_id, kind, actor_id, body_digest, state, received_at, applied_at, rejected_at, record_id,
  record_revision, error_code, error_message`;

function timestamp(date: Date): UtcTimestamp {
  return `${date.toISOString().slice(0, 19)}Z` as UtcTimestamp;
}

export type CommandOutcome =
  | { readonly state: 'PENDING'; readonly status: CommandPending }
  | { readonly state: 'APPLIED'; readonly status: CommandApplied }
  | { readonly state: 'REJECTED'; readonly status: CommandRejected; readonly failure: ApiFailure };

/** The status form of a stored command (command/1, `form: status`). */
export function outcomeOf(row: CommandRow): CommandOutcome {
  const common = {
    schema_version: 'command/1' as const,
    form: 'status' as const,
    command_id: row.command_id,
    kind: row.kind,
    received_at: timestamp(row.received_at),
  };
  if (row.state === 'APPLIED') {
    return {
      state: 'APPLIED',
      status: {
        ...common,
        state: 'APPLIED',
        applied_at: timestamp(row.applied_at as Date),
        record: { id: row.record_id as string, revision: row.record_revision as number },
      },
    };
  }
  if (row.state === 'REJECTED') {
    const code = row.error_code as CommandRejected['error']['code'];
    const message = row.error_message as string;
    return {
      state: 'REJECTED',
      status: {
        ...common,
        state: 'REJECTED',
        rejected_at: timestamp(row.rejected_at as Date),
        error: { code, message },
      },
      failure: new ApiFailure(code, message),
    };
  }
  return { state: 'PENDING', status: { ...common, state: 'PENDING' } };
}

/** The stored status of a command, or undefined when no command has that ID. */
export async function readCommand(tx: Queryable, commandId: string): Promise<CommandOutcome | undefined> {
  const { rows } = await tx.query<CommandRow>(`SELECT ${COLUMNS} FROM commands WHERE command_id = $1`, [commandId]);
  const row = rows[0];
  return row === undefined ? undefined : outcomeOf(row);
}

export interface CommandRun {
  readonly env: ApiEnv;
  readonly db: Database;
  readonly actor: Actor;
  /** The messages of the work that the command creates. Tests replace them; the default builds retrieve and evaluate. */
  readonly builders?: DispatchBuilders;
}

/**
 * Apply one guarded command and return its status. Throws ApiFailure for what is decided before the command is
 * accepted (FORBIDDEN, EXECUTION_DISABLED, COMMAND_ID_REUSED) and for failures that leave it PENDING.
 */
export async function executeCommand(run: CommandRun, request: CommandRequest): Promise<CommandOutcome> {
  const { env, db, actor } = run;
  const kind = request.payload.kind;
  if (!mayApply(kind, actor)) throw new ApiFailure('FORBIDDEN', 'This principal may not apply this command.');
  if (kind === 'run_mission_now' && !env.researchExecution) {
    // A switch of the deployment, not a decision about the command: nothing is recorded, and a retry after the switch
    // is on starts the mission (OQ-05 section 4; research execution stays disabled by default).
    throw new ApiFailure('EXECUTION_DISABLED', 'Research execution is disabled in this environment.');
  }
  const bodyDigest = await digest(request);
  const accepted = await db.transaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO commands (command_id, kind, actor_id, body_digest, expected_revision, received_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (command_id) DO NOTHING`,
      [request.command_id, kind, actor.principalId, bodyDigest, request.expected_revision, env.clock()],
    );
    if (inserted.rowCount === 1) return undefined;
    const { rows } = await tx.query<CommandRow>(`SELECT ${COLUMNS} FROM commands WHERE command_id = $1`, [
      request.command_id,
    ]);
    return rows[0];
  });
  if (accepted !== undefined) {
    if (accepted.body_digest !== bodyDigest || accepted.actor_id !== actor.principalId) {
      throw new ApiFailure('COMMAND_ID_REUSED', 'This command ID belongs to another command.');
    }
    if (accepted.state !== 'PENDING') return outcomeOf(accepted);
  }
  return applyPending(run, request);
}

async function applyPending(run: CommandRun, request: CommandRequest): Promise<CommandOutcome> {
  const { env, db, actor } = run;
  try {
    return await db.transaction(async (tx) => {
      const { rows } = await tx.query<CommandRow>(`SELECT ${COLUMNS} FROM commands WHERE command_id = $1 FOR UPDATE`, [
        request.command_id,
      ]);
      const row = rows[0] as CommandRow;
      if (row.state !== 'PENDING') return outcomeOf(row);
      const produced = await apply({ tx, env, actor, request, builders: run.builders ?? defaultBuilders });
      await tx.query(
        `UPDATE commands SET state = 'APPLIED', applied_at = $2, record_id = $3, record_revision = $4 WHERE command_id = $1`,
        [request.command_id, env.clock(), produced.id, produced.revision],
      );
      return (await readCommand(tx, request.command_id)) as CommandOutcome;
    });
  } catch (error) {
    if (!isRecordedRefusal(error)) throw error;
    return recordRefusal(run, request, error);
  }
}

async function recordRefusal(run: CommandRun, request: CommandRequest, refusal: ApiFailure): Promise<CommandOutcome> {
  const { env, db, actor } = run;
  const message = refusal.message.length > 1000 ? refusal.message.slice(0, 1000) : refusal.message;
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<CommandRow>(`SELECT ${COLUMNS} FROM commands WHERE command_id = $1 FOR UPDATE`, [
      request.command_id,
    ]);
    const row = rows[0] as CommandRow;
    if (row.state !== 'PENDING') return outcomeOf(row);
    await tx.query(
      `UPDATE commands SET state = 'REJECTED', rejected_at = $2, error_code = $3, error_message = $4 WHERE command_id = $1`,
      [request.command_id, env.clock(), refusal.code, message],
    );
    if (refusal instanceof Rejection && refusal.blockMission !== undefined) {
      const mission = await lockMission(tx, refusal.blockMission.missionId);
      await blockMission(tx, env, mission, refusal.blockMission.reason, actor.principalId);
    }
    await writeAudit(tx, env.clock(), {
      eventType: 'command.rejected',
      actor: actor.principalId,
      subject: request.command_id,
      commandId: request.command_id,
      detail: { kind: request.payload.kind, code: refusal.code },
    });
    const outcome = (await readCommand(tx, request.command_id)) as CommandOutcome;
    return outcome.state === 'REJECTED' && refusal.currentRevision !== undefined
      ? { ...outcome, failure: new ApiFailure(refusal.code, message, { currentRevision: refusal.currentRevision }) }
      : outcome;
  });
}
