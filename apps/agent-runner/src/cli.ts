// The invocation of the pinned Claude Code CLI and the reading of its single JSON result (OQ-03 section 3).
//
// Everything here is pure. The flags come from `claude --help` of 2.1.325 and, for an empty `--setting-sources`,
// from the parser of the shipped binary (an empty string selects no source). Whether the real CLI behaves as this
// recipe expects could NOT be verified without credentials: the schema enforcement of `--json-schema`, the shape
// of an error result and the effect of `--bare` stay for the executor probe of the deployment (OQ-06 Fly execution
// probe, P6). The runner therefore reads the text of the result and validates it itself; the schema flag is an
// additional guard behind a configuration switch that stays off.

import { createHash } from 'node:crypto';
import type { ExecutorProfile } from '@openquant/api-contracts';

/** Environment variables that keep the executor from reaching anything but the model endpoint. */
export function executorFixedEnvironment(home: string): Readonly<Record<string, string>> {
  return {
    CLAUDE_CONFIG_DIR: `${home}/.claude`,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The session id that the CLI accepts. `--session-id` needs a UUID, while the dispatch carries an identifier. A
 * lower-case UUID is used as it is. Any other identifier maps to a UUID derived from it, so the same dispatch always
 * gives the same session and two dispatches never share one (a SHA-256 collision aside).
 */
export function cliSessionId(identifier: string): string {
  if (UUID.test(identifier)) return identifier;
  const bytes = createHash('sha256').update(`openquant:agent-session:${identifier}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface InvocationSpec {
  readonly profile: ExecutorProfile;
  readonly sessionUuid: string;
  /** The cost reservation of the attempt, a decimal string in US dollars. The CLI stops at this amount. */
  readonly budgetUsd: string;
  /** The procedure text of the role module: the system prompt. */
  readonly systemPrompt: string;
  readonly bare: boolean;
  /** The result schema for the additional guard, or undefined when the guard is off. */
  readonly resultSchema: unknown;
}

/**
 * The argument list of one attempt. The request itself goes to standard input, so it is never an argument, and no
 * tool, setting source, MCP server, slash command or stored session is enabled.
 */
export function buildArguments(spec: InvocationSpec): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    spec.profile.model,
    ...(spec.profile.effort === 'executor_default' ? [] : ['--effort', spec.profile.effort]),
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--session-id',
    spec.sessionUuid,
    '--permission-prompts',
    'none',
    '--max-budget-usd',
    spec.budgetUsd,
    // The equals form keeps text that starts with a dash from reading as another option.
    `--system-prompt=${spec.systemPrompt}`,
  ];
  if (spec.bare) args.push('--bare');
  if (spec.resultSchema !== undefined) args.push(`--json-schema=${JSON.stringify(spec.resultSchema)}`);
  return args;
}

// ---------------------------------------------------------------------------------------------------------------
// The result of one run
// ---------------------------------------------------------------------------------------------------------------

export interface CliReport {
  readonly sessionId: string | undefined;
  readonly resultText: string | undefined;
  readonly isError: boolean;
  readonly subtype: string | undefined;
  readonly stopReason: string | undefined;
  readonly apiErrorStatus: number | undefined;
  readonly costUsd: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  /** The model that wrote the most output, as the executor reports it, and its provider label. */
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly effort: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value)
    ? value
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read the object that `--output-format json` prints. It returns undefined when the text is not one JSON object of
 * type `result`. Every field is optional: a value that the CLI did not report stays undefined and becomes an explicit
 * unknown in the attempt result; nothing is inferred from the requested profile.
 */
export function parseCliReport(stdout: string): CliReport | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.type !== 'result') return undefined;
  const usage = isRecord(value.usage) ? value.usage : {};
  const inputParts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(count);
  const modelUsage = isRecord(value.modelUsage) ? value.modelUsage : {};
  let model: string | undefined;
  let provider: string | undefined;
  let most = -1;
  for (const [name, entry] of Object.entries(modelUsage)) {
    const tokens = isRecord(entry) ? (count(entry.outputTokens) ?? 0) : 0;
    if (tokens > most) {
      most = tokens;
      model = name;
      provider = isRecord(entry) ? text(entry.provider) : undefined;
    }
  }
  const cost = value.total_cost_usd;
  return {
    sessionId: text(value.session_id),
    resultText: text(value.result),
    isError: value.is_error === true,
    subtype: text(value.subtype),
    stopReason: text(value.stop_reason),
    apiErrorStatus: count(value.api_error_status),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
    // Input is everything the model read: fresh input, cache writes and cache reads.
    inputTokens: inputParts.every((part) => part !== undefined)
      ? inputParts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
      : undefined,
    outputTokens: count(usage.output_tokens),
    model,
    provider,
    effort: text(value.effort),
  };
}

/** The version in `claude --version` output such as `2.1.325 (Claude Code)`, or undefined. */
export function parseCliVersion(stdout: string): string | undefined {
  return /^\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(stdout)?.[1];
}

const AUTH_TEXT =
  /(not logged in|please run \/login|invalid (?:x-)?api[ -]key|api key (?:is )?(?:missing|invalid|not found)|authentication_error|unauthori[sz]ed)/i;
const MISSING_TEXT =
  /(not logged in|no api key|api key (?:is )?(?:missing|not found)|missing (?:an )?api key|please run \/login)/i;

/** Whether the executor failed because of its credential, and whether the credential was missing or rejected. */
export function authenticationFailure(
  report: CliReport | undefined,
  stderr: string,
): 'CREDENTIAL_MISSING' | 'CREDENTIAL_REJECTED' | undefined {
  const status = report?.apiErrorStatus;
  const haystack = `${report?.resultText ?? ''}\n${stderr}`;
  if (status === 401 || status === 403)
    return MISSING_TEXT.test(haystack) ? 'CREDENTIAL_MISSING' : 'CREDENTIAL_REJECTED';
  if (AUTH_TEXT.test(haystack) && (report?.isError ?? true)) {
    return MISSING_TEXT.test(haystack) ? 'CREDENTIAL_MISSING' : 'CREDENTIAL_REJECTED';
  }
  return undefined;
}

/** A requested model matches a reported one when it is equal, or the report adds a date snapshot suffix. */
export function modelMatches(requested: string, reported: string): boolean {
  return (
    reported === requested || new RegExp(`^${requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(reported)
  );
}
