// The typed client of the S1 API (OQ-05 sections 2, 7, 8 and 9). It owns what OQ-05 section 8 gives the client runtime
// for HTTP: every answer is validated with the shared validators before it is used; every command gets a client command
// ID and its outcome is read back, with PENDING and UNKNOWN kept as outcomes of their own (OQ-04 section 12); a stale
// revision is resynchronised from authoritative state, never retried with a new revision; and every error answer is a
// typed error. It runs in Workers, Node and browsers: it imports no Node module.

import {
  type BudgetCap,
  type CohortPolicy,
  type CommandApplied,
  type CommandPayload,
  type CommandPending,
  type CommandRejected,
  type CommandRequest,
  type ContractName,
  type ContractTypes,
  type MissionSpec,
  type MissionView,
  parseContract,
  parseStrictJson,
  type RegisterSeed,
  type ResearchProfile,
  StrictJsonError,
  validateContract,
} from '@openquant/api-contracts';
import {
  type ApiError,
  type ApiErrorBody,
  apiErrorOf,
  type ClientError,
  NotFoundError,
  ResponseContractError,
  RevisionConflictError,
  TransportError,
  UnauthenticatedError,
} from './errors.ts';
import { type Fetch, globalFetch, randomHex, sleep, withDeadline } from './platform.ts';
import {
  type CommandRouteId,
  pathOf,
  type RouteId,
  route,
  statusOfCode,
  type ViewOf,
  type ViewRouteId,
} from './routes.ts';

/** The answer of auth.token: an API-owned view, not a cross-runtime contract (routes/v1.json, "views"). */
export interface AccessToken {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly issued_at: string;
  readonly expires_at: string;
  readonly principal: { readonly id: string; readonly display_name: string; readonly kind: 'HUMAN' };
  readonly roles: readonly string[];
}

export interface AuthProvider {
  /** The access token for the next request. */
  accessToken(): Promise<string>;
  /** Called at most once per request after UNAUTHENTICATED: a fresh token, or undefined when there is none. */
  refresh?(): Promise<string | undefined>;
}

export interface ClientOptions {
  /** The API origin, such as https://api.example.test. Paths come from the route manifest. */
  readonly baseUrl: string;
  readonly fetch?: Fetch;
  readonly auth?: AuthProvider;
  /** Deadline of one request. A command whose answer misses it has an UNKNOWN outcome until it is read back. */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly newCommandId?: () => string;
  /** Bounded polling of a PENDING command: how many reads, and how long apart. */
  readonly readBack?: { readonly attempts: number; readonly delayMs: number };
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CommandOptions {
  /** The compare-and-set revision of the target record: 0 when it must not exist yet. */
  readonly expectedRevision: number;
  /** Reuse an ID only to resolve the same command again; a new command gets a new ID. */
  readonly commandId?: string;
}

/**
 * The outcome of one command, as far as the client knows it. APPLIED, PENDING and REJECTED are what the API said or
 * the read-back returned. UNKNOWN means neither an answer nor a read-back settled it: resolve it with resolveCommand
 * before a new submission is offered (OQ-04 section 12).
 */
export type CommandOutcome =
  | { readonly state: 'APPLIED'; readonly request: CommandRequest; readonly status: CommandApplied }
  | { readonly state: 'PENDING'; readonly request: CommandRequest; readonly status: CommandPending }
  | {
      readonly state: 'REJECTED';
      readonly request: CommandRequest;
      readonly error: ApiError;
      readonly status: CommandRejected | undefined;
    }
  | { readonly state: 'UNKNOWN'; readonly request: CommandRequest; readonly cause: ClientError };

/** A command whose request fails command/1 before it is sent. Nothing was sent. */
export class InvalidCommandError extends Error {
  readonly violations: readonly { readonly pointer: string; readonly message: string }[];
  constructor(message: string, violations: readonly { readonly pointer: string; readonly message: string }[]) {
    super(message);
    this.name = 'InvalidCommandError';
    this.violations = violations;
  }
}

interface Answer {
  readonly status: number;
  readonly bytes: Uint8Array;
}

type CommandStatus = CommandPending | CommandApplied | CommandRejected;

const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const ROLES = ['Viewer', 'Researcher', 'Steward', 'Administrator'];

/** A UTC instant with second precision, as the contracts write it. */
export function utcTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The access-token view, checked field by field: it is no contract, so the client states its shape here. */
export function parseAccessToken(bytes: Uint8Array): AccessToken | undefined {
  let value: unknown;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof StrictJsonError) return undefined;
    throw error;
  }
  if (!isRecord(value)) return undefined;
  if (!exactKeys(value, ['access_token', 'token_type', 'issued_at', 'expires_at', 'principal', 'roles']))
    return undefined;
  const { access_token, token_type, issued_at, expires_at, principal, roles } = value;
  if (typeof access_token !== 'string' || access_token.length === 0 || /\s/.test(access_token)) return undefined;
  if (token_type !== 'Bearer') return undefined;
  if (typeof issued_at !== 'string' || !TIMESTAMP.test(issued_at)) return undefined;
  if (typeof expires_at !== 'string' || !TIMESTAMP.test(expires_at)) return undefined;
  if (!isRecord(principal) || !exactKeys(principal, ['id', 'display_name', 'kind'])) return undefined;
  if (typeof principal.id !== 'string' || typeof principal.display_name !== 'string' || principal.kind !== 'HUMAN')
    return undefined;
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string' && ROLES.includes(role)))
    return undefined;
  return value as unknown as AccessToken;
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: Fetch;
  readonly #auth: AuthProvider | undefined;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #newCommandId: () => string;
  readonly #readBack: { readonly attempts: number; readonly delayMs: number };
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalFetch();
    this.#auth = options.auth;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#newCommandId = options.newCommandId ?? (() => `cmd-${randomHex()}`);
    this.#readBack = options.readBack ?? { attempts: 5, delayMs: 1_000 };
    this.#sleep = options.sleep ?? sleep;
  }

  // --- transport ---------------------------------------------------------------------------------------------------

  async #send(id: RouteId, params: Readonly<Record<string, string>>, token: string, body?: string): Promise<Answer> {
    const spec = route(id);
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const url = `${this.#baseUrl}${pathOf(id, params)}`;
    try {
      return await withDeadline(this.#timeoutMs, async (signal) => {
        const response = await this.#fetch(url, {
          method: spec.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal,
        });
        return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
      });
    } catch (error) {
      // The message of a network error can name the host but never the token; it is not repeated.
      throw new TransportError(`${spec.method} ${spec.path} got no answer`, { cause: error });
    }
  }

  async #token(): Promise<string> {
    if (this.#auth === undefined) throw new Error('This client has no credentials: pass an AuthProvider.');
    return this.#auth.accessToken();
  }

  /** Send with the access token; after UNAUTHENTICATED, refresh once and send the same request again. */
  async #authorised(id: RouteId, params: Readonly<Record<string, string>>, body?: string): Promise<Answer> {
    const first = await this.#send(id, params, await this.#token(), body);
    if (first.status !== statusOfCode('UNAUTHENTICATED') || this.#auth?.refresh === undefined) return first;
    const error = this.#errorOf(first);
    if (!(error instanceof UnauthenticatedError)) return first;
    // The refused request changed nothing (UNAUTHENTICATED is decided before any command is accepted), so a failed
    // refresh leaves that answer, and a fresh token sends the same request once more.
    let fresh: string | undefined;
    try {
      fresh = await this.#auth.refresh();
    } catch {
      return first;
    }
    return fresh === undefined ? first : this.#send(id, params, fresh, body);
  }

  /** The typed error of an error answer, or ResponseContractError when the body is not api-error/1. */
  #errorOf(answer: Answer): ApiError | ResponseContractError {
    const parsed = parseContract('api-error', answer.bytes);
    if (!parsed.ok) {
      return new ResponseContractError(
        answer.status,
        `error answer ${answer.status} is not api-error/1 (${parsed.error.code})`,
      );
    }
    if (statusOfCode(parsed.value.code) !== answer.status) {
      return new ResponseContractError(answer.status, `error answer ${answer.status} carries ${parsed.value.code}`);
    }
    return apiErrorOf(answer.status, parsed.value);
  }

  #body<C extends ContractName>(contract: C, answer: Answer): ContractTypes[C] {
    const parsed = parseContract(contract, answer.bytes);
    if (!parsed.ok) {
      throw new ResponseContractError(answer.status, `answer is not a valid ${contract} (${parsed.error.code})`);
    }
    return parsed.value;
  }

  // --- reads -------------------------------------------------------------------------------------------------------

  /** Exchange a person's long-lived credential for a 15-minute access token (auth.token). */
  async exchangeCredential(credential: string): Promise<AccessToken> {
    const answer = await this.#send('auth.token', {}, credential);
    if (answer.status !== route('auth.token').successStatus) {
      const error = this.#errorOf(answer);
      throw error;
    }
    const token = parseAccessToken(answer.bytes);
    if (token === undefined) throw new ResponseContractError(answer.status, 'answer is not a valid access-token view');
    return token;
  }

  /** One read route, its answer validated against the route's view contract. */
  async read<K extends ViewRouteId>(id: K, params: Readonly<Record<string, string>> = {}): Promise<ViewOf<K>> {
    const spec = route(id);
    const answer = await this.#authorised(id, params);
    if (answer.status !== spec.successStatus) throw this.#errorOf(answer);
    return this.#body(spec.response as ContractName, answer) as ViewOf<K>;
  }

  identity() {
    return this.read('system.identity');
  }
  mission(missionId: string) {
    return this.read('missions.show', { mission_id: missionId });
  }
  lineage(missionId: string) {
    return this.read('missions.lineage', { mission_id: missionId });
  }
  trials(missionId: string) {
    return this.read('missions.trials', { mission_id: missionId });
  }
  findings(missionId: string) {
    return this.read('missions.findings', { mission_id: missionId });
  }
  /** The gate reports. The first read of holdout observations is recorded as their consumption (OQ-02 section 3.3). */
  gates(missionId: string) {
    return this.read('missions.gates', { mission_id: missionId });
  }
  decisions(missionId: string) {
    return this.read('missions.decisions', { mission_id: missionId });
  }
  job(jobId: string) {
    return this.read('jobs.show', { job_id: jobId });
  }
  /** The status of a command by its ID (commands.show). */
  async commandStatus(commandId: string): Promise<CommandStatus> {
    const status = await this.read('commands.show', { command_id: commandId });
    if (status.form !== 'status' || status.command_id !== commandId) {
      throw new ResponseContractError(200, 'commands.show answered for another command');
    }
    return status;
  }

  // --- commands ----------------------------------------------------------------------------------------------------

  /** Build a command/1 request with a client command ID, checked against the contract before anything is sent. */
  buildCommand(payload: CommandPayload, options: CommandOptions): CommandRequest {
    const request: CommandRequest = {
      schema_version: 'command/1',
      form: 'request',
      command_id: options.commandId ?? this.#newCommandId(),
      expected_revision: options.expectedRevision,
      issued_at: utcTimestamp(this.#now()),
      payload,
    };
    const checked = validateContract('command', request);
    if (!checked.ok) {
      throw new InvalidCommandError(
        `the command is not a valid command/1 (${checked.error.code}); nothing was sent`,
        checked.error.violations.map(({ pointer, message }) => ({ pointer, message })),
      );
    }
    return request;
  }

  /**
   * Send a command and settle its outcome: the answer, or after a missing or unusable answer the read-back by its
   * command ID. A REVISION_CONFLICT is resynchronised with `resync` (the authoritative snapshot) when one is given.
   */
  async submit(
    id: CommandRouteId,
    request: CommandRequest,
    params: Readonly<Record<string, string>> = {},
    resync?: () => Promise<MissionView>,
  ): Promise<CommandOutcome> {
    let answer: Answer;
    try {
      answer = await this.#authorised(id, params, JSON.stringify(request));
    } catch (error) {
      if (error instanceof TransportError) return this.#settle(id, request, params, error, false);
      throw error;
    }
    return this.#interpret(id, request, params, answer, resync);
  }

  /**
   * Resolve a command whose outcome is UNKNOWN: read it back by its ID, and when the API has no command with that ID,
   * send the identical request once more. The same ID with the same body is safe to repeat: the API applies it once.
   */
  resolveCommand(
    id: CommandRouteId,
    request: CommandRequest,
    params: Readonly<Record<string, string>> = {},
  ): Promise<CommandOutcome> {
    return this.#settle(id, request, params, new TransportError('the outcome is not known yet'), true);
  }

  async #interpret(
    id: CommandRouteId,
    request: CommandRequest,
    params: Readonly<Record<string, string>>,
    answer: Answer,
    resync?: () => Promise<MissionView>,
  ): Promise<CommandOutcome> {
    if (answer.status === route(id).successStatus) {
      let status: CommandStatus;
      try {
        status = this.#statusOf(request, this.#body('command', answer));
      } catch (error) {
        if (error instanceof ResponseContractError) return this.#settle(id, request, params, error, false);
        throw error;
      }
      return this.#outcomeOf(request, status);
    }
    const error = this.#errorOf(answer);
    // An unusable answer, or one that says the state may have changed, is settled by reading the command back.
    if (error instanceof ResponseContractError || error.stateChanged === 'UNKNOWN') {
      return this.#settle(id, request, params, error, false);
    }
    if (error instanceof RevisionConflictError && resync !== undefined) {
      try {
        error.resync = { currentRevision: error.body.current_revision, mission: await resync() };
      } catch {
        // The current revision from the error body remains; the snapshot could not be read.
      }
    }
    return { state: 'REJECTED', request, error, status: undefined };
  }

  #statusOf(request: CommandRequest, body: ContractTypes['command']): CommandStatus {
    if (body.form !== 'status') throw new ResponseContractError(200, 'the answer is a command request, not a status');
    if (body.command_id !== request.command_id || body.kind !== request.payload.kind) {
      throw new ResponseContractError(200, 'the status is not the status of this command');
    }
    return body;
  }

  async #outcomeOf(request: CommandRequest, status: CommandStatus): Promise<CommandOutcome> {
    let current = status;
    for (let attempt = 0; current.state === 'PENDING' && attempt < this.#readBack.attempts; attempt += 1) {
      await this.#sleep(this.#readBack.delayMs);
      try {
        current = this.#statusOf(request, await this.commandStatus(request.command_id));
      } catch {
        // A failed read leaves the command PENDING: it was accepted and is durable.
      }
    }
    switch (current.state) {
      case 'APPLIED':
        return { state: 'APPLIED', request, status: current };
      case 'PENDING':
        return { state: 'PENDING', request, status: current };
      case 'REJECTED':
        return { state: 'REJECTED', request, error: this.#rejection(current), status: current };
    }
  }

  /** The typed error of a REJECTED status. No state changed: the status form says so. */
  #rejection(status: CommandRejected): ApiError {
    const body: ApiErrorBody = {
      schema_version: 'api-error/1',
      code: status.error.code,
      message: status.error.message,
      state_changed: 'NONE',
      retry_safe: false,
      diagnostic_ref: status.command_id,
    };
    return apiErrorOf(statusOfCode(status.error.code) ?? 400, body);
  }

  async #settle(
    id: CommandRouteId,
    request: CommandRequest,
    params: Readonly<Record<string, string>>,
    cause: ClientError,
    resend: boolean,
  ): Promise<CommandOutcome> {
    let status: CommandStatus;
    try {
      status = this.#statusOf(request, await this.commandStatus(request.command_id));
    } catch (error) {
      if (error instanceof NotFoundError && resend) {
        try {
          const answer = await this.#authorised(id, params, JSON.stringify(request));
          return this.#interpret(id, request, params, answer);
        } catch (again) {
          if (again instanceof TransportError) return { state: 'UNKNOWN', request, cause: again };
          throw again;
        }
      }
      return { state: 'UNKNOWN', request, cause };
    }
    return this.#outcomeOf(request, status);
  }

  /** Build and submit one command. */
  async command(
    id: CommandRouteId,
    payload: CommandPayload,
    options: CommandOptions,
    params: Readonly<Record<string, string>> = {},
    resync?: () => Promise<MissionView>,
  ): Promise<CommandOutcome> {
    return this.submit(id, this.buildCommand(payload, options), params, resync);
  }

  registerBudget(budget: BudgetCap, options: CommandOptions) {
    return this.command('budgets.register', { kind: 'register_budget', budget }, options);
  }
  registerResearchProfile(profile: ResearchProfile, options: CommandOptions) {
    return this.command('research-profiles.register', { kind: 'register_research_profile', profile }, options);
  }
  registerCohortPolicy(policy: CohortPolicy, options: CommandOptions) {
    return this.command('cohort-policies.register', { kind: 'register_cohort_policy', policy }, options);
  }
  registerSeed(seed: Omit<RegisterSeed, 'kind'>, options: CommandOptions) {
    return this.command('seeds.register', { kind: 'register_seed', ...seed }, options);
  }
  createMission(mission: MissionSpec, options: CommandOptions) {
    return this.command('missions.create', { kind: 'create_mission', mission }, options);
  }
  runMissionNow(missionId: string, options: CommandOptions) {
    return this.command(
      'missions.run-now',
      { kind: 'run_mission_now', mission_id: missionId },
      options,
      { mission_id: missionId },
      () => this.mission(missionId),
    );
  }
  cancelMission(missionId: string, reason: string, options: CommandOptions) {
    return this.command(
      'missions.cancel',
      { kind: 'cancel_mission', mission_id: missionId, reason },
      options,
      { mission_id: missionId },
      () => this.mission(missionId),
    );
  }
}
