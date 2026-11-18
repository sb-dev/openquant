// Exit codes and error reports (OQ-04 section 12, OQ-05 section 8). Each exit code names one kind of outcome and is
// stable: docs/reference/cli.md lists them. An error report states what failed, whether state changed, whether a retry
// is safe, what to do next and the diagnostic reference. "No state changed" is printed only when the API states it.

import {
  ApiError,
  ClientError,
  CommandIdReusedError,
  type CommandOutcome,
  ForbiddenError,
  InternalApiError,
  InvalidCommandError,
  NotFoundError,
  ResponseContractError,
  RevisionConflictError,
  route,
  TransportError,
  UnauthenticatedError,
  UnavailableError,
} from '@openquant/api-client';
import { StoreError } from './store.ts';

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  UNAUTHENTICATED: 3,
  FORBIDDEN: 4,
  NOT_FOUND: 5,
  REJECTED: 6,
  CONFLICT: 7,
  PENDING: 8,
  UNKNOWN: 9,
  UNAVAILABLE: 10,
  PROTOCOL: 11,
  DECLINED: 12,
  SESSION_MISMATCH: 13,
  INTERRUPTED: 130,
} as const;

export type ExitName = keyof typeof EXIT;
export type ExitCode = (typeof EXIT)[ExitName];

export function exitName(code: ExitCode): ExitName {
  return (Object.keys(EXIT) as ExitName[]).find((name) => EXIT[name] === code) ?? 'INTERNAL';
}

/** A failure of the CLI's own checks, before any request: a bad argument or input file, or a missing login. */
export class CliFailure extends Error {
  readonly exit: ExitCode;
  readonly next: string | undefined;
  constructor(exit: ExitCode, message: string, next?: string) {
    super(message);
    this.name = 'CliFailure';
    this.exit = exit;
    this.next = next;
  }
}

/** The machine form of an error, as --json prints it. */
export interface ErrorReport {
  readonly code: string;
  readonly message: string;
  readonly state_changed: 'NONE' | 'UNKNOWN';
  readonly retry_safe: boolean;
  readonly next: string;
  readonly diagnostic_ref: string | null;
  readonly current_revision?: number;
  readonly violations?: readonly { readonly pointer: string; readonly message: string }[];
}

export function exitOfApiError(error: ApiError): ExitCode {
  if (error instanceof UnauthenticatedError) return EXIT.UNAUTHENTICATED;
  if (error instanceof ForbiddenError) return EXIT.FORBIDDEN;
  if (error instanceof NotFoundError) return EXIT.NOT_FOUND;
  if (error instanceof RevisionConflictError || error instanceof CommandIdReusedError) return EXIT.CONFLICT;
  if (error instanceof UnavailableError) return EXIT.UNAVAILABLE;
  if (error instanceof InternalApiError) return EXIT.INTERNAL;
  return EXIT.REJECTED;
}

function nextStep(error: ApiError, routeId: string | undefined): string {
  if (error instanceof UnauthenticatedError) return 'Run openquant login again.';
  if (error instanceof ForbiddenError) {
    const roles = routeId === undefined ? [] : route(routeId as never).roles;
    return roles.length > 0
      ? `This command needs one of these roles: ${roles.join(', ')}. Ask an Administrator, or use an account that has it.`
      : 'Your roles do not allow this command.';
  }
  if (error instanceof NotFoundError) return 'Check the identifier.';
  if (error instanceof RevisionConflictError) {
    return 'The record changed since it was read. Review the current state above, then decide again.';
  }
  if (error instanceof CommandIdReusedError) return 'Use a new command ID for a new command.';
  if (error instanceof UnavailableError) return 'Try again later.';
  if (error instanceof InternalApiError) return 'Report the diagnostic reference.';
  return 'Correct the input, then send a new command.';
}

export function apiErrorReport(error: ApiError, routeId?: string): ErrorReport {
  const body = error.body;
  return {
    code: body.code,
    message: body.message,
    state_changed: body.state_changed,
    retry_safe: body.retry_safe,
    next: nextStep(error, routeId),
    diagnostic_ref: body.diagnostic_ref,
    ...(error instanceof RevisionConflictError && error.currentRevision !== undefined
      ? { current_revision: error.currentRevision }
      : {}),
    ...(body.violations === undefined ? {} : { violations: body.violations }),
  };
}

/** The exit code and report of anything a command can throw. */
export function failureOf(error: unknown, routeId?: string): { exit: ExitCode; report: ErrorReport } {
  if (error instanceof ApiError) return { exit: exitOfApiError(error), report: apiErrorReport(error, routeId) };
  if (error instanceof CliFailure) {
    return {
      exit: error.exit,
      report: {
        code: `CLI_${exitName(error.exit)}`,
        message: error.message,
        state_changed: 'NONE',
        retry_safe: true,
        next: error.next ?? 'Run openquant --help.',
        diagnostic_ref: null,
      },
    };
  }
  if (error instanceof InvalidCommandError) {
    return {
      exit: EXIT.USAGE,
      report: {
        code: 'CLI_INVALID_INPUT',
        message: error.message,
        state_changed: 'NONE',
        retry_safe: true,
        next: 'Correct the input document.',
        diagnostic_ref: null,
        violations: error.violations,
      },
    };
  }
  if (error instanceof TransportError) {
    return {
      exit: EXIT.UNAVAILABLE,
      report: {
        code: 'CLI_NO_ANSWER',
        message: 'The API did not answer.',
        state_changed: 'UNKNOWN',
        retry_safe: true,
        next: 'Check the API address and the network, then try again.',
        diagnostic_ref: null,
      },
    };
  }
  if (error instanceof ResponseContractError) {
    return {
      exit: EXIT.PROTOCOL,
      report: {
        code: 'CLI_INVALID_ANSWER',
        message: `The API answer was not used: ${error.message}.`,
        state_changed: 'UNKNOWN',
        retry_safe: false,
        next: 'Check that the CLI and the API are the same release.',
        diagnostic_ref: null,
      },
    };
  }
  if (error instanceof StoreError) {
    return {
      exit: EXIT.UNAUTHENTICATED,
      report: {
        code: 'CLI_CREDENTIALS',
        message: error.message,
        state_changed: 'NONE',
        retry_safe: true,
        next: 'Run openquant login.',
        diagnostic_ref: null,
      },
    };
  }
  const message = error instanceof ClientError || error instanceof Error ? error.name : 'unexpected failure';
  return {
    exit: EXIT.INTERNAL,
    report: {
      code: 'CLI_INTERNAL',
      message: `The CLI failed (${message}).`,
      state_changed: 'UNKNOWN',
      retry_safe: false,
      next: 'Report this failure.',
      diagnostic_ref: null,
    },
  };
}

export function errorLines(report: ErrorReport): string[] {
  const lines = [`Error ${report.code}: ${report.message}`];
  lines.push(
    report.state_changed === 'NONE'
      ? 'No state changed.'
      : 'The outcome is unknown: state may have changed. Read it back before acting again.',
  );
  if (report.current_revision !== undefined) lines.push(`Current revision: ${report.current_revision}`);
  for (const violation of report.violations ?? []) {
    lines.push(`  ${violation.pointer === '' ? '(document)' : violation.pointer}: ${violation.message}`);
  }
  lines.push(`Retry safe: ${report.retry_safe ? 'yes' : 'no'}`, `Next: ${report.next}`);
  if (report.diagnostic_ref !== null) lines.push(`Diagnostic reference: ${report.diagnostic_ref}`);
  return lines;
}

/** The exit code of a command outcome. */
export function exitOfOutcome(outcome: CommandOutcome): ExitCode {
  switch (outcome.state) {
    case 'APPLIED':
      return EXIT.OK;
    case 'PENDING':
      return EXIT.PENDING;
    case 'UNKNOWN':
      return EXIT.UNKNOWN;
    case 'REJECTED':
      return exitOfApiError(outcome.error);
  }
}

/** The lines of a command outcome: what the API holds now for this command ID. */
export function outcomeLines(outcome: CommandOutcome, routeId: string): string[] {
  const { request } = outcome;
  const head = `Command ${request.command_id} (${request.payload.kind}): ${outcome.state}`;
  switch (outcome.state) {
    case 'APPLIED':
      return [
        head,
        `  received ${outcome.status.received_at}; applied ${outcome.status.applied_at}`,
        `  record: ${outcome.status.record.id} revision ${outcome.status.record.revision}`,
      ];
    case 'PENDING':
      return [
        head,
        `  received ${outcome.status.received_at}: accepted and durable, not applied yet.`,
        `  Next: openquant command show ${request.command_id}`,
      ];
    case 'UNKNOWN':
      return [
        head,
        '  The API gave no usable answer and the read-back did not find the command. State may have changed.',
        `  Next: openquant command resolve ${request.command_id} (it reads the command back, and sends the`,
        '  identical request with the same command ID only if the API has none).',
      ];
    case 'REJECTED':
      return [head, ...errorLines(apiErrorReport(outcome.error, routeId)).map((line) => `  ${line}`)];
  }
}
