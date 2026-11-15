import { describe, expect, it } from 'vitest';
import { buildChildEnvironment, PROXY_AND_CA_VARIABLES, passEnvProblem } from '../src/child-env.ts';

const base = {
  home: '/scratch/home',
  tmp: '/scratch/tmp',
  path: '/usr/bin:/bin',
  fixed: { CLAUDE_CONFIG_DIR: '/scratch/home/.claude' },
  allowProxyEnv: false,
};

const hostEnv = {
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
  AGENT_RUNNER_API_TOKEN: 'host-secret',
  CLOUDFLARE_API_TOKEN: 'host-secret',
  FLY_API_TOKEN: 'host-secret',
  DATABASE_URL: 'postgres://u:<host-secret>@h/db',
  GITHUB_TOKEN: 'host-secret',
  ALPACA_API_SECRET: 'host-secret',
  HTTPS_PROXY: 'http://proxy.invalid:3128',
  https_proxy: 'http://proxy.invalid:3128',
  SSL_CERT_FILE: '/etc/ssl/ca.invalid',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.invalid',
  HOME: '/root',
  PATH: '/opt/host/bin',
};

describe('buildChildEnvironment', () => {
  it('holds the fixed variables, the fresh paths and the one allowed credential, and nothing else', () => {
    const env = buildChildEnvironment({ ...base, hostEnv, passEnv: ['ANTHROPIC_API_KEY'] });
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/scratch/home',
      TMPDIR: '/scratch/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      NO_COLOR: '1',
      CLAUDE_CONFIG_DIR: '/scratch/home/.claude',
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
    });
  });

  it('never passes the host paths, a host credential or a proxy variable by default', () => {
    const env = buildChildEnvironment({ ...base, hostEnv, passEnv: ['ANTHROPIC_API_KEY'] });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/scratch/home');
    for (const name of [
      'AGENT_RUNNER_API_TOKEN',
      'CLOUDFLARE_API_TOKEN',
      'FLY_API_TOKEN',
      'DATABASE_URL',
      'GITHUB_TOKEN',
      'ALPACA_API_SECRET',
      ...PROXY_AND_CA_VARIABLES,
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(Object.values(env).join('\n')).not.toContain('host-secret');
  });

  it('passes the proxy and certificate variables only behind the explicit flag', () => {
    const env = buildChildEnvironment({ ...base, hostEnv, passEnv: [], allowProxyEnv: true });
    expect(env.HTTPS_PROXY).toBe('http://proxy.invalid:3128');
    expect(env.https_proxy).toBe('http://proxy.invalid:3128');
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/ca.invalid');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/extra.invalid');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
  });

  it('skips a name that the host does not set or sets empty, and never lets a variable replace HOME or PATH', () => {
    const env = buildChildEnvironment({
      ...base,
      hostEnv: { ANTHROPIC_API_KEY: '', EXTRA: undefined, HOME: '/root', PATH: '/opt' },
      passEnv: ['ANTHROPIC_API_KEY', 'EXTRA', 'HOME', 'PATH'],
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('EXTRA');
    expect(env.HOME).toBe('/scratch/home');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });
});

describe('passEnvProblem', () => {
  it('accepts the model credential and plain names', () => {
    expect(passEnvProblem('ANTHROPIC_API_KEY')).toBeUndefined();
    expect(passEnvProblem('CLAUDE_CODE_USE_BEDROCK')).toBeUndefined();
  });

  it('refuses the credentials of the host and of other systems, by prefix', () => {
    for (const name of [
      'AGENT_RUNNER_API_TOKEN',
      'CLOUDFLARE_API_TOKEN',
      'CF_API_TOKEN',
      'FLY_API_TOKEN',
      'ALPACA_API_KEY',
      'APCA_API_SECRET_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'R2_SECRET',
      'DATABASE_URL',
      'PGPASSWORD',
      'POSTGRES_PASSWORD',
      'NEON_API_KEY',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'NPM_TOKEN',
      'PACTWRIGHT_ANTHROPIC_API_KEY',
      'OPENQUANT_TEST_DATABASE_URL',
    ]) {
      expect(passEnvProblem(name), name).toMatch(/credential of the host or of another system/);
    }
  });

  it('refuses proxy variables, lower-case names and the variables that the runner sets', () => {
    expect(passEnvProblem('HTTPS_PROXY')).toMatch(/allowProxyEnv/);
    expect(passEnvProblem('anthropic_api_key')).toMatch(/not an upper-case variable name/);
    expect(passEnvProblem('1BAD')).toMatch(/not an upper-case variable name/);
    for (const name of ['HOME', 'PATH', 'TMPDIR']) expect(passEnvProblem(name)).toMatch(/set by the runner/);
  });
});
