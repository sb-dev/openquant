import { describe, expect, it } from 'vitest';
import {
  authenticationFailure,
  buildArguments,
  cliSessionId,
  executorFixedEnvironment,
  modelMatches,
  parseCliReport,
  parseCliVersion,
} from '../src/cli.ts';
import { decimalString, diagnostic, utcTimestamp } from '../src/text.ts';

const PROFILE = { model: 'claude-opus-5-5', effort: 'executor_default' } as const;
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

// The field names of one `--output-format json` result of Claude Code 2.1.325, with synthetic values. Only fields
// that the parser reads are listed; the real object carries more.
function observed(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    stop_reason: 'end_turn',
    session_id: SESSION,
    total_cost_usd: 0.0123456,
    usage: { input_tokens: 3, cache_creation_input_tokens: 2000, cache_read_input_tokens: 700, output_tokens: 5 },
    modelUsage: { 'claude-opus-5-5': { outputTokens: 5, provider: 'firstParty' } },
    result: 'ok',
    ...overrides,
  });
}

describe('buildArguments', () => {
  const base = {
    profile: PROFILE,
    sessionUuid: SESSION,
    budgetUsd: '5',
    systemPrompt: '---\nskill: x\n---\nbody',
    bare: true,
    resultSchema: undefined,
  };

  it('is the pinned recipe: print mode, JSON output, no tools, no setting source, no stored session', () => {
    expect(buildArguments(base)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-opus-5-5',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--session-id',
      SESSION,
      '--permission-prompts',
      'none',
      '--max-budget-usd',
      '5',
      '--system-prompt=---\nskill: x\n---\nbody',
      '--bare',
    ]);
  });

  it('passes an effort only when the profile names one, so the executor default stays its own', () => {
    expect(buildArguments(base)).not.toContain('--effort');
    const high = buildArguments({ ...base, profile: { model: 'claude-sonnet-5-5', effort: 'high' } });
    expect(high.slice(high.indexOf('--model'), high.indexOf('--model') + 4)).toEqual([
      '--model',
      'claude-sonnet-5-5',
      '--effort',
      'high',
    ]);
  });

  it('adds the schema guard only when a schema is given, and bare only when asked', () => {
    expect(buildArguments(base).some((argument) => argument.startsWith('--json-schema'))).toBe(false);
    const guarded = buildArguments({ ...base, resultSchema: { type: 'object' }, bare: false });
    expect(guarded).toContain('--json-schema={"type":"object"}');
    expect(guarded).not.toContain('--bare');
  });

  it('never puts the request on the command line and gives no way to enable a tool', () => {
    const args = buildArguments(base);
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.indexOf('--tools')).toBeGreaterThan(-1);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(
      args.filter(
        (argument) =>
          !argument.startsWith('-') &&
          argument !== '' &&
          ![PROFILE.model, SESSION, 'json', 'none', '5'].includes(argument),
      ),
    ).toEqual([]);
  });
});

describe('cliSessionId', () => {
  it('keeps a lower-case UUID as it is', () => {
    expect(cliSessionId(SESSION)).toBe(SESSION);
  });

  it('derives the same UUID from the same identifier and different UUIDs from different identifiers', () => {
    const a = cliSessionId('session-attempt-1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(cliSessionId('session-attempt-1')).toBe(a);
    expect(cliSessionId('session-attempt-2')).not.toBe(a);
    expect(cliSessionId('SESSION-attempt-1')).not.toBe(a);
  });

  it('derives a UUID from an upper-case UUID rather than passing it, so the CLI always sees a canonical form', () => {
    expect(cliSessionId(SESSION.toUpperCase())).not.toBe(SESSION.toUpperCase());
  });
});

describe('executorFixedEnvironment', () => {
  it('points the configuration at the fresh home and turns off traffic that is not the model call', () => {
    expect(executorFixedEnvironment('/scratch/home')).toEqual({
      CLAUDE_CONFIG_DIR: '/scratch/home/.claude',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });
});

describe('parseCliReport', () => {
  it('reads the fields of an observed result', () => {
    expect(parseCliReport(observed())).toEqual({
      sessionId: SESSION,
      resultText: 'ok',
      isError: false,
      subtype: 'success',
      stopReason: 'end_turn',
      apiErrorStatus: undefined,
      costUsd: 0.0123456,
      // Fresh input, cache writes and cache reads: 3 + 2000 + 700.
      inputTokens: 2703,
      outputTokens: 5,
      model: 'claude-opus-5-5',
      provider: 'firstParty',
      effort: undefined,
    });
  });

  it('leaves every value that the executor did not report undefined', () => {
    const report = parseCliReport(JSON.stringify({ type: 'result', result: 'x' }));
    expect(report).toMatchObject({
      sessionId: undefined,
      costUsd: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      model: undefined,
      provider: undefined,
      effort: undefined,
      isError: false,
    });
  });

  it('takes the model that wrote the most output when the executor reports more than one', () => {
    const report = parseCliReport(
      observed({
        modelUsage: {
          'claude-haiku-x': { outputTokens: 3 },
          'claude-opus-5-5': { outputTokens: 900, provider: 'firstParty' },
        },
      }),
    );
    expect(report?.model).toBe('claude-opus-5-5');
  });

  it('refuses a value that is not a result object', () => {
    for (const text of ['', 'not json', '[]', '"x"', 'null', '{"type":"assistant"}', '{"result":"x"}']) {
      expect(parseCliReport(text), text).toBeUndefined();
    }
  });

  it('ignores a negative, fractional or non-numeric usage value rather than inventing one', () => {
    const report = parseCliReport(
      observed({
        total_cost_usd: -1,
        usage: { input_tokens: 1.5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: -2 },
      }),
    );
    expect(report).toMatchObject({ costUsd: undefined, inputTokens: undefined, outputTokens: undefined });
  });
});

describe('parseCliVersion', () => {
  it('reads the version of `claude --version`', () => {
    expect(parseCliVersion('2.1.325 (Claude Code)\n')).toBe('2.1.325');
    expect(parseCliVersion('  2.1.325-beta.1 (Claude Code)')).toBe('2.1.325-beta.1');
  });

  it('refuses text that does not start with a version', () => {
    for (const text of ['', 'Claude Code 2.1.325', 'v2.1.325', 'error: unknown option'])
      expect(parseCliVersion(text), text).toBeUndefined();
  });
});

describe('authenticationFailure', () => {
  const failed = (extra: Record<string, unknown>) => parseCliReport(observed({ is_error: true, ...extra }));

  it('reads a 401 or 403 status as a rejected credential and as a missing one when the text says so', () => {
    expect(authenticationFailure(failed({ api_error_status: 401, result: 'Invalid API key' }), '')).toBe(
      'CREDENTIAL_REJECTED',
    );
    expect(authenticationFailure(failed({ api_error_status: 403, result: 'forbidden' }), '')).toBe(
      'CREDENTIAL_REJECTED',
    );
    expect(
      authenticationFailure(failed({ api_error_status: 401, result: 'Not logged in. Please run /login' }), ''),
    ).toBe('CREDENTIAL_MISSING');
  });

  it('reads the text of an error result without a status', () => {
    expect(authenticationFailure(failed({ result: 'Invalid API key provided' }), '')).toBe('CREDENTIAL_REJECTED');
    expect(authenticationFailure(undefined, 'Not logged in')).toBe('CREDENTIAL_MISSING');
  });

  it('does not treat model text that mentions authentication as a failure of the credential', () => {
    expect(
      authenticationFailure(parseCliReport(observed({ result: 'The note says unauthorized access is a risk.' })), ''),
    ).toBeUndefined();
    expect(
      authenticationFailure(failed({ result: 'the model overloaded', api_error_status: 529 }), ''),
    ).toBeUndefined();
  });
});

describe('modelMatches', () => {
  it('accepts the requested model and a dated snapshot of it, and nothing else', () => {
    expect(modelMatches('claude-opus-5-5', 'claude-opus-5-5')).toBe(true);
    expect(modelMatches('claude-opus-5-5', 'claude-opus-5-5-20261001')).toBe(true);
    expect(modelMatches('claude-opus-5-5', 'claude-sonnet-5-5')).toBe(false);
    expect(modelMatches('claude-opus-5-5', 'claude-opus-5-50')).toBe(false);
    expect(modelMatches('claude-opus-5-5', 'xclaude-opus-5-5')).toBe(false);
    expect(modelMatches('claude.opus', 'claudeXopus')).toBe(false);
  });
});

describe('text helpers', () => {
  it('formats a cost as a plain decimal and refuses what the contract cannot hold', () => {
    expect(decimalString(0)).toBe('0');
    expect(decimalString(5)).toBe('5');
    expect(decimalString(0.0123456)).toBe('0.0123456');
    expect(decimalString(12.5)).toBe('12.5');
    expect(decimalString(1e-12)).toBe('0');
    expect(decimalString(-1)).toBeUndefined();
    expect(decimalString(Number.NaN)).toBeUndefined();
    expect(decimalString(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(decimalString(2e9)).toBeUndefined();
  });

  it('formats a timestamp with second precision', () => {
    expect(utcTimestamp(Date.UTC(2026, 10, 15, 10, 30, 5, 999))).toBe('2026-11-15T10:30:05Z');
  });

  it('bounds a diagnostic, strips control characters and replaces secrets and credential shapes', () => {
    const text = diagnostic(
      'line\none\u0000\u001b[31m sk-ant-api03-ABCDEFGHIJ Bearer abcdef123456 token=abcdef123456 secretvalue',
      ['secretvalue'],
    );
    expect([...text].every((character) => character.charCodeAt(0) >= 0x20)).toBe(true);
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain('abcdef123456');
    expect(text).not.toContain('secretvalue');
    expect(diagnostic('x'.repeat(5000))).toHaveLength(2000);
    expect(diagnostic('x'.repeat(5000)).endsWith('...')).toBe(true);
    const cut = diagnostic(`${'x'.repeat(4)}\u{1F600}${'y'.repeat(10)}`, [], 8);
    expect(cut).toBe(`${'x'.repeat(4)}\u{1F600}...`);
    expect(cut.isWellFormed()).toBe(true);
  });
});
