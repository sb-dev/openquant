// The openquant command line (OQ-04 sections 4, 5, 10 to 13; OQ-05 sections 8 and 9). One command path serves the
// terminal and machine use: in a terminal Ink renders the result, a non-terminal gets the same lines as plain text, and
// --json prints one JSON document to stdout and never renders Ink. Diagnostics go to stderr. Every result carries the
// operating context: environment, mode, money state, account and risk. docs/reference/cli.md lists the commands and
// their exit codes.

import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  ApiClient,
  apiErrorOf,
  type CommandOutcome,
  type CommandRouteId,
  type Fetch,
  NotFoundError,
  RevisionConflictError,
  route,
  statusOfCode,
} from '@openquant/api-client';
import type { CommandPayload, CommandRequest, MissionView } from '@openquant/api-contracts';
import { render, renderToString } from 'ink';
import { createElement as h } from 'react';
import { type ApiEnvironment, displayContext, headerLines } from './context.ts';
import {
  budgetLines,
  type CandidateValues,
  decisionsLines,
  findingsLines,
  gatesLines,
  lineageLines,
  type MissionResults,
  missionLines,
  type RunValues,
  resultsLines,
  trialsLines,
} from './format.ts';
import {
  apiErrorReport,
  CliFailure,
  type ErrorReport,
  EXIT,
  type ExitCode,
  errorLines,
  exitName,
  exitOfOutcome,
  failureOf,
  outcomeLines,
} from './outcome.ts';
import { bareClient, type ClientSettings, sessionClient } from './session.ts';
import { configDirectory, type PendingCommand, Store, type StoredSession } from './store.ts';
import { MAX_WIDTH, outputWidth, safeJson, wrapLines } from './text.ts';
import { Confirm, type ConfirmProps, MissionWatch, Report } from './ui.ts';

export interface CliIo {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
  /** Request deadline in milliseconds (default 30 s). */
  readonly timeoutMs?: number;
  readonly readBack?: { readonly attempts: number; readonly delayMs: number };
  readonly sleep?: (ms: number) => Promise<void>;
  /** Ink render options that tests set: interactive mode and one frame per update. */
  readonly ink?: { readonly interactive?: boolean; readonly debug?: boolean };
}

interface Result {
  readonly exit: ExitCode;
  readonly lines: readonly string[];
  readonly data?: unknown;
  readonly error?: ErrorReport;
  /** When the state shown was read from the API. */
  readonly observedAt?: string | null;
  /** The environment the result belongs to, when the command learned it (login). */
  readonly environment?: ApiEnvironment;
  /** Ink already rendered the result in the terminal (watch). */
  readonly rendered?: boolean;
}

const OPTIONS = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  api: { type: 'string' },
  file: { type: 'string' },
  'expected-revision': { type: 'string' },
  'command-id': { type: 'string' },
  reason: { type: 'string' },
  yes: { type: 'boolean' },
  interval: { type: 'string' },
  candidate: { type: 'string' },
} as const;

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string };

interface Context {
  readonly io: CliIo;
  readonly values: Values;
  readonly argument: string | undefined;
  readonly store: Store;
  readonly settings: ClientSettings;
  readonly json: boolean;
  readonly terminal: boolean;
  readonly now: () => Date;
}

interface CommandSpec {
  readonly words: readonly string[];
  readonly argument?: string;
  readonly options: readonly (keyof typeof OPTIONS)[];
  readonly summary: string;
  readonly run: (context: Context) => Promise<Result>;
}

const stamp = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

// --- helpers -------------------------------------------------------------------------------------------------------

function apiUrl(text: string | undefined): string {
  if (text === undefined || text === '') {
    throw new CliFailure(EXIT.USAGE, 'No API address.', 'Pass --api <url> or set OPENQUANT_API_URL.');
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CliFailure(EXIT.USAGE, 'The API address is not a URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new CliFailure(EXIT.USAGE, 'The API address must use https (http only for localhost).');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new CliFailure(EXIT.USAGE, 'The API address must not carry a user, a query or a fragment.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function revisionOption(context: Context): number | undefined {
  const text = context.values['expected-revision'];
  if (text === undefined) return undefined;
  if (!/^(0|[1-9][0-9]{0,6})$/.test(text) || Number(text) > 1_000_000) {
    throw new CliFailure(EXIT.USAGE, '--expected-revision must be an integer from 0 to 1000000.');
  }
  return Number(text);
}

const MAX_INPUT_BYTES = 512 * 1024;

// biome-ignore lint/suspicious/noExplicitAny: an input document is checked against command/1 before it is sent.
function inputDocument(context: Context): Record<string, any> {
  const path = context.values.file;
  if (path === undefined) throw new CliFailure(EXIT.USAGE, 'This command needs --file <path>.');
  let text: string;
  try {
    if (statSync(path).size > MAX_INPUT_BYTES) throw new CliFailure(EXIT.USAGE, `${path} is larger than 512 KiB.`);
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw new CliFailure(EXIT.USAGE, `${path} cannot be read.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliFailure(EXIT.USAGE, `${path} is not valid JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliFailure(EXIT.USAGE, `${path} must hold one JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireSession(context: Context): { session: StoredSession; client: ApiClient } {
  const session = context.store.readSession();
  if (session === undefined) {
    throw new CliFailure(EXIT.UNAUTHENTICATED, 'Not logged in.', 'Run openquant login --api <url>.');
  }
  return { session, client: sessionClient(context.store, session, context.settings) };
}

function inkOptions(io: CliIo) {
  return {
    stdout: io.stdout,
    stderr: io.stderr,
    stdin: io.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    ...io.ink,
  };
}

async function confirm(context: Context, props: Omit<ConfirmProps, 'onDecision'>): Promise<boolean> {
  if (context.values.yes === true) return true;
  if (context.json || !context.terminal || context.io.stdin.isTTY !== true) {
    throw new CliFailure(
      EXIT.USAGE,
      `${props.action} needs a confirmation, and this is not an interactive terminal. Nothing was sent.`,
      'Pass --yes to confirm it.',
    );
  }
  let decision = false;
  const instance = render(
    h(Confirm, {
      ...props,
      onDecision: (confirmed: boolean) => {
        decision = confirmed;
        instance.unmount();
      },
    }),
    inkOptions(context.io),
  );
  await instance.waitUntilExit();
  return decision;
}

async function readCredential(io: CliIo): Promise<string> {
  const stdin = io.stdin;
  if (stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
    io.stderr.write('Credential (input hidden): ');
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    return new Promise<string>((resolve, reject) => {
      let value = '';
      const finish = () => {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        io.stderr.write('\n');
      };
      const onData = (chunk: string | Buffer) => {
        for (const character of String(chunk)) {
          if (character === '\r' || character === '\n') {
            finish();
            resolve(value);
            return;
          }
          if (character === '\u0003') {
            finish();
            reject(new CliFailure(EXIT.INTERRUPTED, 'Login cancelled. Nothing was stored.'));
            return;
          }
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else if (character >= ' ' && value.length < 4096) value += character;
        }
      };
      stdin.on('data', onData);
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 65_536) throw new CliFailure(EXIT.USAGE, 'The credential on stdin is too long.');
    chunks.push(buffer);
  }
  return (Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '').trim();
}

// --- commands ------------------------------------------------------------------------------------------------------

async function login(context: Context): Promise<Result> {
  let stored: StoredSession | undefined;
  try {
    stored = context.store.readSession();
  } catch {
    stored = undefined;
  }
  const baseUrl = apiUrl(context.values.api ?? context.io.env.OPENQUANT_API_URL ?? stored?.api_url);
  const credential = await readCredential(context.io);
  if (credential === '' || /\s/.test(credential)) {
    throw new CliFailure(EXIT.USAGE, 'No credential was read.', 'Pipe the credential on stdin, or type it when asked.');
  }
  const exchange = bareClient(baseUrl, context.settings);
  const token = await exchange.exchangeCredential(credential);
  const identity = await new ApiClient({
    baseUrl,
    timeoutMs: context.settings.timeoutMs,
    ...(context.settings.fetch === undefined ? {} : { fetch: context.settings.fetch }),
    auth: { accessToken: async () => token.access_token },
  }).identity();
  const observedAt = stamp(context.now());
  context.store.writeSession({
    schema: 'openquant-cli-credentials/1',
    api_url: baseUrl,
    environment: identity.environment,
    principal: { id: token.principal.id, display_name: token.principal.display_name },
    roles: token.roles,
    credential,
    access_token: token.access_token,
    access_token_expires_at: token.expires_at,
  });
  return {
    exit: EXIT.OK,
    environment: identity.environment,
    observedAt,
    lines: [
      `Logged in as ${token.principal.display_name} (${token.principal.id})`,
      `  roles: ${token.roles.length === 0 ? 'none' : token.roles.join(', ')}`,
      `  API: ${baseUrl} (${identity.environment})`,
      `  access token expires at ${token.expires_at}; the CLI renews it with the stored credential`,
      `  credentials file: ${context.store.credentialsPath} (mode 0600)`,
    ],
    data: {
      principal: token.principal,
      roles: token.roles,
      api_url: baseUrl,
      environment: identity.environment,
      access_token_expires_at: token.expires_at,
      credentials_file: context.store.credentialsPath,
    },
  };
}

async function logout(context: Context): Promise<Result> {
  const removed = context.store.removeSession();
  return {
    exit: EXIT.OK,
    lines: [
      removed ? `Removed ${context.store.credentialsPath}.` : 'No credentials file was stored.',
      '  The API does not revoke the credential: an Administrator does that.',
    ],
    data: { removed },
  };
}

async function sendCommand(
  context: Context,
  routeId: CommandRouteId,
  payload: CommandPayload,
  expectedRevision: number,
  params: Readonly<Record<string, string>> = {},
  readBack?: (client: ApiClient, outcome: CommandOutcome) => Promise<MissionView | undefined>,
): Promise<Result> {
  const unresolved = context.store.pendingIds();
  if (unresolved.length > 0) {
    const first = unresolved[0] as string;
    const binding = journalBinding(context, first);
    throw new CliFailure(
      EXIT.UNKNOWN,
      `The outcome of an earlier command is unknown: ${unresolved.join(', ')}. Nothing was sent.`,
      binding === undefined
        ? `Run openquant command resolve ${first} first.`
        : `Log in to ${binding.api_url} as ${binding.principal_id}, then run openquant command resolve ${first}.`,
    );
  }
  const { session, client } = requireSession(context);
  const commandId = context.values['command-id'];
  const request = client.buildCommand(payload, {
    expectedRevision,
    ...(commandId === undefined ? {} : { commandId }),
  });
  // The exact request is journalled before it is sent, so that an interrupted process leaves it for command resolve
  // with the same command ID (OQ-04 section 12). It is removed once the outcome is known.
  context.store.recordPending({
    schema: 'openquant-cli-pending/2',
    api_url: session.api_url,
    principal_id: session.principal.id,
    route: routeId,
    params,
    request,
  });
  const resync = params.mission_id === undefined ? undefined : () => client.mission(params.mission_id as string);
  const outcome = await client.submit(routeId, request, params, resync);
  if (outcome.state !== 'UNKNOWN') context.store.removePending(request.command_id);
  return commandResult(context, routeId, outcome, readBack === undefined ? undefined : await readBack(client, outcome));
}

function commandResult(
  context: Context,
  routeId: string,
  outcome: CommandOutcome,
  mission: MissionView | undefined,
): Result {
  const lines = outcomeLines(outcome, routeId);
  let current = mission;
  if (outcome.state === 'REJECTED' && outcome.error instanceof RevisionConflictError) {
    current = outcome.error.resync.mission;
    lines.push(current === undefined ? 'The current state could not be read.' : 'Current state, read again:');
  }
  if (current !== undefined) lines.push(...missionLines(current));
  return {
    exit: exitOfOutcome(outcome),
    lines,
    observedAt: stamp(context.now()),
    data: {
      command_id: outcome.request.command_id,
      kind: outcome.request.payload.kind,
      state: outcome.state,
      status: outcome.state === 'UNKNOWN' ? null : (outcome.status ?? null),
      ...(current === undefined ? {} : { mission: current }),
    },
    ...(outcome.state === 'REJECTED' ? { error: apiErrorReport(outcome.error, routeId) } : {}),
  };
}

/** A registration whose document carries its own revision: the expected revision defaults to the one before it. */
function registration(
  routeId: CommandRouteId,
  build: (document: Record<string, unknown>) => CommandPayload,
): (context: Context) => Promise<Result> {
  return async (context) => {
    const document = inputDocument(context);
    const revision = typeof document.revision === 'number' && document.revision >= 1 ? document.revision - 1 : 0;
    return sendCommand(context, routeId, build(document), revisionOption(context) ?? revision);
  };
}

async function readAppliedMission(client: ApiClient, outcome: CommandOutcome): Promise<MissionView | undefined> {
  if (outcome.state !== 'APPLIED') return undefined;
  try {
    return await client.mission(outcome.status.record.id);
  } catch {
    return undefined;
  }
}

async function missionCreate(context: Context): Promise<Result> {
  const mission = inputDocument(context);
  return sendCommand(
    context,
    'missions.create',
    { kind: 'create_mission', mission: mission as never },
    0,
    {},
    readAppliedMission,
  );
}

function missionAction(action: 'run-now' | 'cancel'): (context: Context) => Promise<Result> {
  return async (context) => {
    const missionId = context.argument as string;
    const reason = context.values.reason;
    if (action === 'cancel' && (reason === undefined || reason.trim() === '')) {
      throw new CliFailure(EXIT.USAGE, 'mission cancel needs --reason <text>.');
    }
    const { client } = requireSession(context);
    // The decision is made on authoritative state read now; the command carries the revision that was shown.
    const view = await client.mission(missionId);
    const expectedRevision = revisionOption(context) ?? view.revision;
    const shown = `Mission ${view.mission_id}: ${view.status}, revision ${view.revision}, read at ${stamp(context.now())}`;
    const details =
      action === 'run-now'
        ? [
            shown,
            `Objective: ${view.objective}`,
            'Effect: starts the bounded research work of the mission, which reserves and spends its budget.',
            'It cannot be undone; cancelling later stops further work but keeps what was spent.',
            'Safe default: keep the mission as it is.',
          ]
        : [
            shown,
            `Objective: ${view.objective}`,
            'Effect: withdraws the mission; its open runs become CANCELLED and its open agent attempts are cancelled.',
            'Cancellation does not prove that a remote request stopped or cost nothing. It cannot be undone.',
            `Reason: ${reason}`,
            'Safe default: keep the mission as it is.',
          ];
    const confirmed = await confirm(context, {
      action: action === 'run-now' ? `RUN NOW ${missionId}` : `CANCEL ${missionId}`,
      details,
      confirmLabel: action === 'run-now' ? 'Run now' : 'Cancel mission',
      cancelLabel: 'Keep as is',
    });
    if (!confirmed) {
      return {
        exit: EXIT.DECLINED,
        lines: ['Declined: nothing was sent.', ...missionLines(view)],
        observedAt: stamp(context.now()),
        data: { declined: true, mission: view },
      };
    }
    const payload: CommandPayload =
      action === 'run-now'
        ? { kind: 'run_mission_now', mission_id: missionId }
        : { kind: 'cancel_mission', mission_id: missionId, reason: reason as string };
    return sendCommand(
      context,
      action === 'run-now' ? 'missions.run-now' : 'missions.cancel',
      payload,
      expectedRevision,
      { mission_id: missionId },
      readAppliedMission,
    );
  };
}

function missionView(lines: (view: MissionView) => string[]): (context: Context) => Promise<Result> {
  return async (context) => {
    const { client } = requireSession(context);
    const view = await client.mission(context.argument as string);
    return { exit: EXIT.OK, lines: lines(view), data: view, observedAt: stamp(context.now()) };
  };
}

function readView<T>(
  read: (client: ApiClient, id: string) => Promise<T>,
  lines: (view: T) => string[],
): (context: Context) => Promise<Result> {
  return async (context) => {
    const { client } = requireSession(context);
    const view = await read(client, context.argument as string);
    return { exit: EXIT.OK, lines: lines(view), data: view, observedAt: stamp(context.now()) };
  };
}

/** A document that is NotFound while none is committed: null then (unknown, never zero). */
async function committed<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * The official values of a mission's candidates (OQ-04 section 5): the runs from the lineage, the window labels from the
 * evaluation plan, and for each COMPLETED run its committed metrics and result, unchanged. Nothing is recomputed.
 */
async function missionResults(context: Context): Promise<Result> {
  const { client } = requireSession(context);
  const missionId = context.argument as string;
  const lineage = await client.lineage(missionId);
  const wanted = context.values.candidate;
  const versions =
    wanted === undefined ? lineage.versions : lineage.versions.filter((version) => version.trial_slot === wanted);
  if (versions.length === 0 && wanted !== undefined) {
    throw new CliFailure(
      EXIT.NOT_FOUND,
      `Mission ${missionId} has no candidate in trial slot ${wanted}.`,
      `Use openquant mission lineage ${missionId}.`,
    );
  }
  const plan = await committed(() => client.plan(missionId));
  const candidates: CandidateValues[] = [];
  for (const version of versions) {
    const runs: RunValues[] = [];
    for (const run of version.runs) {
      const completed = run.status === 'COMPLETED';
      runs.push({
        ...run,
        replay_of: plan?.run_slots.find((slot) => slot.run_slot_id === run.run_slot)?.replay_of ?? null,
        window_label: plan?.windows.find((window) => window.role === run.window_role)?.label ?? null,
        metrics: completed ? await committed(() => client.runMetrics(run.run_id)) : null,
        result: completed ? await committed(() => client.runResult(run.run_id)) : null,
      });
    }
    candidates.push({
      trial_slot: version.trial_slot,
      strategy_id: version.strategy_id,
      version: version.version,
      strategy_hash: version.strategy_hash,
      lifecycle: version.lifecycle,
      runs,
    });
  }
  const view: MissionResults = { mission_id: lineage.mission_id, windows: plan?.windows ?? null, candidates };
  return { exit: EXIT.OK, lines: resultsLines(view), data: view, observedAt: stamp(context.now()) };
}

async function missionWatch(context: Context): Promise<Result> {
  if (context.json || !context.terminal || context.io.stdin.isTTY !== true) {
    throw new CliFailure(EXIT.USAGE, 'mission watch needs an interactive terminal.', 'Use openquant mission show.');
  }
  const text = context.values.interval ?? '10';
  if (!/^[0-9]{1,3}$/.test(text) || Number(text) < 5 || Number(text) > 300) {
    throw new CliFailure(EXIT.USAGE, '--interval must be a number of seconds from 5 to 300.');
  }
  const { session, client } = requireSession(context);
  const missionId = context.argument as string;
  const instance = render(
    h(MissionWatch, {
      missionId,
      load: () => client.mission(missionId),
      intervalMs: Number(text) * 1000,
      maxBackoffMs: 300_000,
      now: context.now,
      header: (observedAt: string | null) => headerLines(displayContext(session.environment, observedAt)),
    }),
    inkOptions(context.io),
  );
  await instance.waitUntilExit();
  return { exit: EXIT.OK, lines: [], rendered: true, data: { detached: true } };
}

/** Whether a journal entry was sent to the API and as the principal of the stored session (OQ-05 section 9). */
function sameSession(pending: PendingCommand, session: StoredSession): boolean {
  return pending.api_url === session.api_url && pending.principal_id === session.principal.id;
}

/** The journal entry of a command when it belongs to another API or principal than the stored session. */
function journalBinding(context: Context, commandId: string): PendingCommand | undefined {
  try {
    const pending = context.store.readPending(commandId);
    const session = context.store.readSession();
    return pending === undefined || (session !== undefined && sameSession(pending, session)) ? undefined : pending;
  } catch {
    return undefined;
  }
}

async function commandShow(context: Context): Promise<Result> {
  const { session, client } = requireSession(context);
  const commandId = context.argument as string;
  const status = await client.commandStatus(commandId);
  // A journal entry of another API or principal is neither used nor settled by what this session reads.
  const journalled = context.store.readPending(commandId);
  const pending = journalled !== undefined && sameSession(journalled, session) ? journalled : undefined;
  if (pending !== undefined && status.state !== 'PENDING') context.store.removePending(commandId);
  const request = pending?.request ?? ({ command_id: commandId, payload: { kind: status.kind } } as CommandRequest);
  const outcome: CommandOutcome =
    status.state === 'REJECTED'
      ? {
          state: 'REJECTED',
          request,
          status,
          error: apiErrorOf(statusOfCode(status.error.code) ?? 400, {
            schema_version: 'api-error/1',
            code: status.error.code,
            message: status.error.message,
            state_changed: 'NONE',
            retry_safe: false,
            diagnostic_ref: status.command_id,
          }),
        }
      : status.state === 'APPLIED'
        ? { state: 'APPLIED', request, status }
        : { state: 'PENDING', request, status };
  return commandResult(context, pending?.route ?? 'commands.show', outcome, undefined);
}

async function commandResolve(context: Context): Promise<Result> {
  const commandId = context.argument as string;
  const pending = context.store.readPending(commandId);
  if (pending === undefined) {
    throw new CliFailure(
      EXIT.NOT_FOUND,
      `No unresolved command ${commandId} is in the journal.`,
      `Use openquant command show ${commandId}.`,
    );
  }
  const { session, client } = requireSession(context);
  if (!sameSession(pending, session)) {
    // Resolving may send the request again: only to the API it was sent to, and only as the principal that sent it.
    throw new CliFailure(
      EXIT.SESSION_MISMATCH,
      `Command ${commandId} was sent to ${pending.api_url} as ${pending.principal_id}, and this session is ${session.api_url} as ${session.principal.id}. Nothing was sent; the journal entry is kept.`,
      `Log in to ${pending.api_url} as ${pending.principal_id}, then run openquant command resolve ${commandId}.`,
    );
  }
  const outcome = await client.resolveCommand(pending.route, pending.request, pending.params);
  if (outcome.state !== 'UNKNOWN') context.store.removePending(commandId);
  return commandResult(context, pending.route, outcome, undefined);
}

const MISSION = 'mission-id';

export const COMMANDS: readonly CommandSpec[] = [
  {
    words: ['login'],
    options: ['api'],
    summary: 'Exchange your credential (stdin or prompt) for an access token',
    run: login,
  },
  { words: ['logout'], options: [], summary: 'Remove the stored credential and token', run: logout },
  {
    words: ['budget', 'register'],
    options: ['file', 'expected-revision', 'command-id'],
    summary: 'Steward: register a period budget cap (BudgetCap document)',
    run: registration('budgets.register', (budget) => ({ kind: 'register_budget', budget: budget as never })),
  },
  {
    words: ['profile', 'register'],
    options: ['file', 'expected-revision', 'command-id'],
    summary: 'Steward: register a research profile revision',
    run: registration('research-profiles.register', (profile) => ({
      kind: 'register_research_profile',
      profile: profile as never,
    })),
  },
  {
    words: ['policy', 'register'],
    options: ['file', 'expected-revision', 'command-id'],
    summary: 'Steward: register and approve a cohort policy revision',
    run: registration('cohort-policies.register', (policy) => ({
      kind: 'register_cohort_policy',
      policy: policy as never,
    })),
  },
  {
    words: ['seed', 'register'],
    options: ['file', 'expected-revision', 'command-id'],
    summary: 'Researcher: store a seed draft with its sources',
    run: async (context) =>
      sendCommand(
        context,
        'seeds.register',
        { ...inputDocument(context), kind: 'register_seed' } as CommandPayload,
        revisionOption(context) ?? 0,
      ),
  },
  {
    words: ['mission', 'create'],
    options: ['file', 'command-id'],
    summary: 'Researcher: create a mission (MissionSpec document)',
    run: missionCreate,
  },
  {
    words: ['mission', 'run-now'],
    argument: MISSION,
    options: ['expected-revision', 'yes', 'command-id'],
    summary: 'Researcher: start a CREATED mission (confirmation)',
    run: missionAction('run-now'),
  },
  {
    words: ['mission', 'cancel'],
    argument: MISSION,
    options: ['reason', 'expected-revision', 'yes', 'command-id'],
    summary: 'Researcher: withdraw a mission (confirmation)',
    run: missionAction('cancel'),
  },
  {
    words: ['mission', 'show'],
    argument: MISSION,
    options: [],
    summary: 'Mission status and outcome',
    run: missionView(missionLines),
  },
  {
    words: ['mission', 'budget'],
    argument: MISSION,
    options: [],
    summary: 'Mission budget, pools and reservations',
    run: missionView(budgetLines),
  },
  {
    words: ['mission', 'lineage'],
    argument: MISSION,
    options: [],
    summary: 'Strategy versions, runs, findings and Decisions',
    run: readView((c, id) => c.lineage(id), lineageLines),
  },
  {
    words: ['mission', 'trials'],
    argument: MISSION,
    options: [],
    summary: 'Trial slots, run slots and proposals',
    run: readView((c, id) => c.trials(id), trialsLines),
  },
  {
    words: ['mission', 'findings'],
    argument: MISSION,
    options: [],
    summary: 'Critic findings and their treatment',
    run: readView((c, id) => c.findings(id), findingsLines),
  },
  {
    words: ['mission', 'gates'],
    argument: MISSION,
    options: [],
    summary: 'Gate reports and eligibility (reveals holdout results)',
    run: readView((c, id) => c.gates(id), gatesLines),
  },
  {
    words: ['mission', 'decisions'],
    argument: MISSION,
    options: [],
    summary: 'Recorded Decisions',
    run: readView((c, id) => c.decisions(id), decisionsLines),
  },
  {
    words: ['mission', 'results'],
    argument: MISSION,
    options: ['candidate'],
    summary: 'Official D, V and H run values per candidate (reveals holdout results)',
    run: missionResults,
  },
  {
    words: ['mission', 'watch'],
    argument: MISSION,
    options: ['interval'],
    summary: 'Follow a mission in the terminal (polls; q detaches)',
    run: missionWatch,
  },
  {
    words: ['command', 'show'],
    argument: 'command-id',
    options: [],
    summary: 'Read a command back by its ID',
    run: commandShow,
  },
  {
    words: ['command', 'resolve'],
    argument: 'command-id',
    options: [],
    summary: 'Settle a command whose outcome is unknown',
    run: commandResolve,
  },
];

export function usage(): string[] {
  const lines = ['Usage: openquant <command> [options] [--json]', '', 'Commands:'];
  for (const spec of COMMANDS) {
    const argument = spec.argument === undefined ? '' : ` <${spec.argument}>`;
    lines.push(`  ${spec.words.join(' ')}${argument}`, `      ${spec.summary}`);
  }
  lines.push(
    '',
    'Every command takes --json: one JSON document on stdout, no terminal rendering.',
    'Exit codes and options: docs/reference/cli.md.',
  );
  return lines;
}

// --- output --------------------------------------------------------------------------------------------------------

function storedEnvironment(store: Store | undefined): ApiEnvironment | null {
  try {
    return store?.readSession()?.environment ?? null;
  } catch {
    return null;
  }
}

function emit(io: CliIo, json: boolean, command: string, result: Result, environment: ApiEnvironment | null): void {
  const display = displayContext(result.environment ?? environment, result.observedAt ?? null);
  if (json) {
    io.stdout.write(
      `${safeJson({
        openquant_cli: 1,
        command,
        outcome: exitName(result.exit),
        exit_code: result.exit,
        context: display,
        data: result.data ?? null,
        error: result.error ?? null,
      })}\n`,
    );
    return;
  }
  if (result.rendered === true) return;
  const width = io.stdout.isTTY === true ? outputWidth(io.stdout.columns) : MAX_WIDTH;
  const header = headerLines(display);
  const failed = result.error !== undefined && result.lines.length === 0;
  if (!failed) {
    const lines = [...header, '', ...result.lines];
    if (io.stdout.isTTY === true)
      io.stdout.write(`${renderToString(h(Report, { lines, width }), { columns: width })}\n`);
    else io.stdout.write(`${wrapLines(lines, width).join('\n')}\n`);
  }
  if (failed && result.error !== undefined) {
    const errorWidth = io.stderr.isTTY === true ? outputWidth(io.stderr.columns) : MAX_WIDTH;
    io.stderr.write(`${wrapLines([...header, '', ...errorLines(result.error)], errorWidth).join('\n')}\n`);
  }
}

/** Run one command line. Returns the exit code; never throws. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true }) as never;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid arguments';
    io.stderr.write(`${wrapLines([`Error: ${message}`, ...usage()], MAX_WIDTH).join('\n')}\n`);
    return EXIT.USAGE;
  }
  const { values, positionals } = parsed;
  const json = values.json === true;
  if (positionals.length === 0 || positionals[0] === 'help' || (values.help === true && positionals.length === 0)) {
    const help = positionals[0] === 'help' || values.help === true;
    (help ? io.stdout : io.stderr).write(`${wrapLines(usage(), MAX_WIDTH).join('\n')}\n`);
    return help ? EXIT.OK : EXIT.USAGE;
  }
  const spec = COMMANDS.find(
    (candidate) =>
      candidate.words.length <= positionals.length && candidate.words.every((word, i) => positionals[i] === word),
  );
  const commandName = spec?.words.join(' ') ?? positionals.slice(0, 2).join(' ');
  const now = io.now ?? (() => new Date());
  let store: Store | undefined;
  try {
    if (spec === undefined) throw new CliFailure(EXIT.USAGE, `Unknown command: ${commandName}.`);
    if (values.help === true) {
      io.stdout.write(`${wrapLines(usage(), MAX_WIDTH).join('\n')}\n`);
      return EXIT.OK;
    }
    const rest = positionals.slice(spec.words.length);
    const expected = spec.argument === undefined ? 0 : 1;
    if (rest.length !== expected) {
      throw new CliFailure(
        EXIT.USAGE,
        spec.argument === undefined
          ? `${commandName} takes no argument.`
          : `${commandName} needs exactly one <${spec.argument}>.`,
      );
    }
    for (const option of Object.keys(values) as (keyof typeof OPTIONS)[]) {
      if (option !== 'json' && option !== 'help' && !spec.options.includes(option)) {
        throw new CliFailure(EXIT.USAGE, `${commandName} does not take --${option}.`);
      }
    }
    store = new Store(configDirectory(io.env));
    const context: Context = {
      io,
      values,
      argument: rest[0],
      store,
      settings: {
        fetch: io.fetch,
        timeoutMs: io.timeoutMs ?? 30_000,
        readBack: io.readBack,
        sleep: io.sleep,
        now,
      },
      json,
      terminal: io.stdout.isTTY === true,
      now,
    };
    const result = await spec.run(context);
    emit(io, json, commandName, result, storedEnvironment(store));
    return result.exit;
  } catch (error) {
    const routeId = spec === undefined ? undefined : routeOf(spec);
    const { exit, report } = failureOf(error, routeId);
    emit(io, json, commandName, { exit, lines: [], error: report }, storedEnvironment(store));
    return exit;
  }
}

function routeOf(spec: CommandSpec): string | undefined {
  const byWords: Record<string, string> = {
    'budget register': 'budgets.register',
    'profile register': 'research-profiles.register',
    'policy register': 'cohort-policies.register',
    'seed register': 'seeds.register',
    'mission create': 'missions.create',
    'mission run-now': 'missions.run-now',
    'mission cancel': 'missions.cancel',
  };
  const id = byWords[spec.words.join(' ')];
  return id === undefined ? undefined : route(id as CommandRouteId).id;
}
