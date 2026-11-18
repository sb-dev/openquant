import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { TEST_IDENTITY } from './support/world.ts';

const options = { identity: TEST_IDENTITY, defaultBundleDir: '/opt/runner/bundle' };

const minimal = {
  AGENT_RUNNER_ENVIRONMENT: 'STAGING',
  AGENT_RUNNER_DISPATCH_TOKEN: 'd'.repeat(40),
  AGENT_RUNNER_API_TOKEN: 'a'.repeat(40),
  AGENT_RUNNER_API_BASE_URL: 'https://api.example.test',
};

const enabled = {
  ...minimal,
  AGENT_RUNNER_ENABLED: 'true',
  AGENT_RUNNER_EXECUTOR_PATH: '/opt/claude-code/bin/claude',
  AGENT_RUNNER_EXECUTOR_VERSION: '2.1.325',
};

function errorsOf(env: Record<string, string | undefined>): readonly string[] {
  const result = loadConfig(env, options);
  if (result.ok) throw new Error('the configuration was accepted');
  return result.errors;
}

describe('loadConfig', () => {
  it('is disabled unless execution is switched on, and needs no executor then', () => {
    const result = loadConfig(minimal, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.enabled).toBe(false);
    expect(result.config.executor.path).toBe('');
  });

  it('takes the safe defaults: proxy variables off, the schema guard off, bare on, two attempts at once, loopback only', () => {
    const result = loadConfig(enabled, options);
    if (!result.ok) throw new Error(result.errors.join('; '));
    const { config } = result;
    expect(config.enabled).toBe(true);
    expect(config.executor).toMatchObject({
      path: '/opt/claude-code/bin/claude',
      version: '2.1.325',
      credentialEnv: 'ANTHROPIC_API_KEY',
      passEnv: [],
      allowProxyEnv: false,
      enforceSchema: false,
      bare: true,
      childPath: '/usr/local/bin:/usr/bin:/bin',
    });
    expect(config.maxConcurrent).toBe(2);
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(config.bundleDir).toBe('/opt/runner/bundle');
    expect(config.environment).toBe('STAGING');
    expect(config.api.baseUrl).toBe('https://api.example.test');
    expect(config.identity).toEqual(TEST_IDENTITY);
  });

  it('reads the optional settings', () => {
    const result = loadConfig(
      {
        ...enabled,
        AGENT_RUNNER_PORT: '9090',
        AGENT_RUNNER_HOST: '0.0.0.0',
        AGENT_RUNNER_MAX_CONCURRENT: '3',
        AGENT_RUNNER_BUNDLE_DIR: '/srv/bundle',
        AGENT_RUNNER_SCRATCH_DIR: '/var/scratch',
        AGENT_RUNNER_USE_JSON_SCHEMA: 'true',
        AGENT_RUNNER_BARE: 'false',
        AGENT_RUNNER_ALLOW_PROXY_ENV: 'true',
        AGENT_RUNNER_PASS_ENV: 'CLAUDE_CODE_USE_BEDROCK, EXTRA_NAME',
        AGENT_RUNNER_WORKER_ID: 'runner one/2',
      },
      options,
    );
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.config.listen).toEqual({ host: '0.0.0.0', port: 9090 });
    expect(result.config.maxConcurrent).toBe(3);
    expect(result.config.bundleDir).toBe('/srv/bundle');
    expect(result.config.executor).toMatchObject({
      scratchRoot: '/var/scratch',
      enforceSchema: true,
      bare: false,
      allowProxyEnv: true,
      passEnv: ['CLAUDE_CODE_USE_BEDROCK', 'EXTRA_NAME'],
    });
    expect(result.config.workerId).toBe('runner-one-2');
  });

  it('names its Fly Machine in the worker name on Fly, for the termination probe of the API', () => {
    const result = loadConfig({ ...minimal, FLY_MACHINE_ID: '148e272b0a1d2c' }, options);
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.config.workerId).toBe(`fly:148e272b0a1d2c:agent-runner-${process.pid}`);
    // The name the API reads back (apps/api/src/fly-probe.ts) is a plain identifier of the claim.
    expect(result.config.workerId).toMatch(/^fly:([0-9a-z]{1,32}):/);
    expect(result.config.workerId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
    // Off Fly the name stays the host name and process.
    const local = loadConfig(minimal, options);
    if (!local.ok) throw new Error(local.errors.join('; '));
    expect(local.config.workerId).not.toMatch(/^fly:/);
    // A Machine ID that cannot be one, and a second name on Fly, are refused.
    for (const id of ['148E272B', '../x', 'a'.repeat(33), 'ab:cd']) {
      expect(errorsOf({ ...minimal, FLY_MACHINE_ID: id }).join('\n'), id).toMatch(
        /FLY_MACHINE_ID must be a Fly Machine ID/,
      );
    }
    expect(
      errorsOf({ ...minimal, FLY_MACHINE_ID: '148e272b0a1d2c', AGENT_RUNNER_WORKER_ID: 'runner-1' }).join('\n'),
    ).toMatch(/AGENT_RUNNER_WORKER_ID cannot be set on a Fly Machine/);
  });

  it('reports every problem at once', () => {
    const errors = errorsOf({});
    expect(errors.join('\n')).toMatch(/AGENT_RUNNER_ENVIRONMENT must be one of/);
    expect(errors.join('\n')).toMatch(/AGENT_RUNNER_DISPATCH_TOKEN is required/);
    expect(errors.join('\n')).toMatch(/AGENT_RUNNER_API_TOKEN is required/);
    expect(errors.join('\n')).toMatch(/AGENT_RUNNER_API_BASE_URL is required/);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it('needs the executor path and the pinned version once execution is enabled', () => {
    const errors = errorsOf({ ...minimal, AGENT_RUNNER_ENABLED: 'true' });
    expect(errors.join('\n')).toMatch(/AGENT_RUNNER_EXECUTOR_PATH must be an absolute path/);
    expect(errors.join('\n')).toMatch(/AGENT_RUNNER_EXECUTOR_VERSION must be the pinned version/);
    expect(errorsOf({ ...enabled, AGENT_RUNNER_EXECUTOR_PATH: 'claude' }).join('\n')).toMatch(/absolute path/);
    expect(errorsOf({ ...enabled, AGENT_RUNNER_EXECUTOR_VERSION: 'latest' }).join('\n')).toMatch(/pinned version/);
  });

  it('refuses a short dispatch token, an unknown environment and a base URL that is not https or loopback', () => {
    expect(errorsOf({ ...minimal, AGENT_RUNNER_DISPATCH_TOKEN: 'short' }).join('\n')).toMatch(/at least 32 characters/);
    expect(errorsOf({ ...minimal, AGENT_RUNNER_ENVIRONMENT: 'LIVE' }).join('\n')).toMatch(
      /must be one of DEVELOPMENT, STAGING, PRODUCTION/,
    );
    expect(errorsOf({ ...minimal, AGENT_RUNNER_API_BASE_URL: 'http://api.example.test' }).join('\n')).toMatch(
      /https URL, or http on a loopback/,
    );
  });

  it('refuses a flag that is neither true nor false, and a number out of range', () => {
    expect(errorsOf({ ...minimal, AGENT_RUNNER_ENABLED: 'yes' }).join('\n')).toMatch(
      /AGENT_RUNNER_ENABLED must be true or false/,
    );
    expect(errorsOf({ ...minimal, AGENT_RUNNER_PORT: '70000' }).join('\n')).toMatch(
      /AGENT_RUNNER_PORT must be an integer from 1 to 65535/,
    );
    expect(errorsOf({ ...minimal, AGENT_RUNNER_MAX_CONCURRENT: '0' }).join('\n')).toMatch(
      /AGENT_RUNNER_MAX_CONCURRENT/,
    );
    expect(errorsOf({ ...minimal, AGENT_RUNNER_API_TIMEOUT_MS: 'soon' }).join('\n')).toMatch(
      /AGENT_RUNNER_API_TIMEOUT_MS/,
    );
  });

  it('refuses to hand the child a credential of the host, whatever the variable is for', () => {
    for (const name of [
      'AGENT_RUNNER_API_TOKEN',
      'CLOUDFLARE_API_TOKEN',
      'FLY_API_TOKEN',
      'DATABASE_URL',
      'ALPACA_API_SECRET',
      'HTTPS_PROXY',
    ]) {
      expect(errorsOf({ ...enabled, AGENT_RUNNER_PASS_ENV: name }).join('\n'), name).toMatch(/AGENT_RUNNER_PASS_ENV/);
    }
    expect(errorsOf({ ...enabled, AGENT_RUNNER_CREDENTIAL_ENV: 'CLOUDFLARE_API_TOKEN' }).join('\n')).toMatch(
      /AGENT_RUNNER_PASS_ENV/,
    );
  });

  it('allows an empty credential variable, so a gateway or another authentication can be configured', () => {
    const result = loadConfig({ ...enabled, AGENT_RUNNER_CREDENTIAL_ENV: '' }, options);
    expect(result.ok && result.config.executor.credentialEnv).toBeUndefined();
  });

  it('refuses the proxy switch in production, where only an allowlisted network is acceptable', () => {
    expect(
      errorsOf({ ...enabled, AGENT_RUNNER_ENVIRONMENT: 'PRODUCTION', AGENT_RUNNER_ALLOW_PROXY_ENV: 'true' }).join('\n'),
    ).toMatch(/refused in PRODUCTION/);
    expect(
      loadConfig({ ...enabled, AGENT_RUNNER_ENVIRONMENT: 'DEVELOPMENT', AGENT_RUNNER_ALLOW_PROXY_ENV: 'true' }, options)
        .ok,
    ).toBe(true);
  });

  it('keeps the environment of the process as the host environment, from which only allowed names are read', () => {
    const result = loadConfig({ ...enabled, SOMETHING_ELSE: 'x' }, options);
    expect(result.ok && result.config.executor.hostEnv.SOMETHING_ELSE).toBe('x');
  });
});
