import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { BUNDLE_HASH, FILES } from '@openquant/agents';
import { canonicalJson, validateContract } from '@openquant/api-contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { revisionOutput } from '../../../packages/agents/test/support/requests.ts';
import { HttpApiClient } from '../src/api-client.ts';
import { Runner } from '../src/runner.ts';
import { createDispatchServer } from '../src/server.ts';
import { sha256Bytes } from '../src/text.ts';
import { bundleRunner } from '../tools/bundle.ts';
import { type ControlApi, startControlApi } from './support/control-api.ts';
import {
  API_TOKEN,
  agentsRoot,
  CAPABILITY,
  cleanup,
  DISPATCH_TOKEN,
  dispatchFor,
  formulationRequest,
  HOST_SECRET,
  installFakeCli,
  MODEL_KEY,
  makeWorld,
  repositoryRoot,
  scratch,
  until,
} from './support/world.ts';

afterEach(cleanup);

// The runner is built once, into a directory of its own, and removed after the last test.
const outputRoot = mkdtempSync(join(tmpdir(), 'oq-dist-'));
const built = join(outputRoot, 'dist');
const apis: ControlApi[] = [];
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()));
});

async function controlApi(): Promise<ControlApi> {
  const api = await startControlApi();
  apis.push(api);
  return api;
}

describe('the whole path in one process: dispatch, claim, input, executor, validation, artefact, result', () => {
  it('runs an attempt over HTTP against a loopback control API with a fake executor', async () => {
    const api = await controlApi();
    const assembled = await formulationRequest();
    api.inputs.set(sha256Bytes(assembled.bytes), assembled.bytes);
    const output = await revisionOutput();
    const world = makeWorld({ behaviour: 'result', resultText: JSON.stringify(output) });
    const config = {
      ...world.config,
      api: { baseUrl: `http://127.0.0.1:${api.port}`, credential: API_TOKEN, timeoutMs: 3000 },
    };
    const runner = new Runner({ config, api: new HttpApiClient(config.api) });
    const server = createDispatchServer({ runner, dispatchToken: DISPATCH_TOKEN, log: () => undefined });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const dispatch = dispatchFor(assembled);
      const response = await fetch(`http://127.0.0.1:${port}/v1/agent-attempts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${DISPATCH_TOKEN}` },
        body: canonicalJson(dispatch),
      });
      expect(response.status).toBe(202);
      await runner.idle();
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }

    // The order and the credential of every call: the claim with the service credential, then the capability only.
    expect(api.seen.map((request) => `${request.method} ${request.path.replace(/\/[^/]*$/, '/…')}`)).toEqual([
      'POST /v1/attempts/attempt-1/…',
      'GET /v1/attempts/attempt-1/inputs/…',
      'PUT /v1/attempts/attempt-1/artefacts/…',
      'POST /v1/attempts/attempt-1/…',
    ]);
    expect(api.seen.map((request) => request.authorization)).toEqual([
      `Bearer ${API_TOKEN}`,
      `Bearer ${CAPABILITY}`,
      `Bearer ${CAPABILITY}`,
      `Bearer ${CAPABILITY}`,
    ]);
    expect(api.results).toHaveLength(1);
    const result = api.results[0];
    expect(validateContract('agent-attempt-result', result).ok).toBe(true);
    expect(result).toMatchObject({
      attempt: { attempt_id: 'attempt-1', ownership_revision: 1 },
      outcome: { outcome: 'completion', output: { contract: 'strategy-formulation.result/1' } },
      provenance: { bundle_hash: BUNDLE_HASH, session_id: 'session-attempt-1' },
    });
    const digest = (result as { outcome: { output: { artefact: { digest: string } } } }).outcome.output.artefact.digest;
    expect(api.artefacts.has(digest)).toBe(true);
    expect(JSON.stringify(api.results)).not.toContain(MODEL_KEY);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

interface Started {
  readonly port: number;
  readonly stderr: () => string;
  readonly stop: () => Promise<number | null>;
}

function startBundle(env: Record<string, string>): Promise<Started> {
  return freePort().then(async (port) => {
    const child = spawn(process.execPath, [join(built, 'agent-runner.mjs')], {
      env: { PATH: '/usr/bin:/bin', ...env, AGENT_RUNNER_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    await until(() => stderr.includes('"event":"listening"') || child.exitCode !== null, 10_000);
    return {
      port,
      stderr: () => stderr,
      stop: async () => {
        if (child.exitCode === null) child.kill('SIGTERM');
        return exited;
      },
    };
  });
}

describe('the built runner, started as a program', () => {
  let result: Awaited<ReturnType<typeof bundleRunner>>;
  beforeAll(async () => {
    result = await bundleRunner(built);
  });
  afterAll(() => rmSync(outputRoot, { recursive: true, force: true }));

  it('bundles for Node with the behaviour bundle beside it and no dependency', () => {
    expect(result.problems).toEqual([]);
    expect(result.kib).toBeGreaterThan(50);
    expect(existsSync(join(built, 'agent-runner.mjs'))).toBe(true);
    expect(existsSync(join(built, 'bundle', 'bundle.manifest.json'))).toBe(true);
  });

  it('refuses to start on a bad configuration and says what is wrong, without a credential in the message', async () => {
    const child = spawn(process.execPath, [join(built, 'agent-runner.mjs')], {
      env: { PATH: '/usr/bin:/bin', AGENT_RUNNER_DISPATCH_TOKEN: 'short-secret-value' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    const code = await new Promise<number | null>((done) => child.on('exit', (exit) => done(exit)));
    expect(code).toBe(2);
    expect(stderr).toMatch(/AGENT_RUNNER_ENVIRONMENT must be one of/);
    expect(stderr).toMatch(/at least 32 characters/);
    expect(stderr).not.toContain('short-secret-value');
  });

  it('serves a dispatch with execution disabled: it claims, records the denial and stops cleanly on SIGTERM', async () => {
    const api = await controlApi();
    const assembled = await formulationRequest();
    api.inputs.set(sha256Bytes(assembled.bytes), assembled.bytes);
    const runner = await startBundle({
      AGENT_RUNNER_ENVIRONMENT: 'STAGING',
      AGENT_RUNNER_DISPATCH_TOKEN: DISPATCH_TOKEN,
      AGENT_RUNNER_API_TOKEN: API_TOKEN,
      AGENT_RUNNER_API_BASE_URL: `http://127.0.0.1:${api.port}`,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${runner.port}/v1/agent-attempts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${DISPATCH_TOKEN}` },
        body: canonicalJson(dispatchFor(assembled)),
      });
      expect(response.status).toBe(202);
      await until(() => api.results.length === 1);
      expect(api.results[0]).toMatchObject({ outcome: { outcome: 'denied_capability', reason: 'EXECUTION_DISABLED' } });
      expect(api.seen.map((request) => request.method)).toEqual(['POST', 'POST']);
    } finally {
      expect(await runner.stop()).toBe(0);
    }
    expect(runner.stderr()).toContain('"execution_enabled":false');
    expect(runner.stderr()).not.toContain(API_TOKEN);
  });

  it('ships exactly the manifest and the files it lists in dist/bundle, and no evaluation, expected-answer or development file', () => {
    const listed = ['bundle.manifest.json', ...FILES.map((file) => file.path)].sort();
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else found.push(relative(join(built, 'bundle'), path).split(sep).join('/'));
      }
    };
    walk(join(built, 'bundle'));
    expect(found.sort()).toEqual(listed);
    // The classes that must never ship, by name: whatever the manifest says, none of them is in the directory.
    for (const path of found) {
      expect(path).not.toMatch(
        /(^|\/)(evals?|test|tests|dev|tools|methods|snapshots?)(\/|$)|expected|\.test\.|dataset|fixture/i,
      );
    }
    expect(found).toHaveLength(8);
  });

  it('holds no evaluation case, fixture id or draft method note in the runner module', () => {
    const module = readFileSync(join(built, 'agent-runner.mjs'), 'utf8');
    const ids = ['strategy-critique', 'strategy-formulation'].flatMap((skill) =>
      (
        JSON.parse(readFileSync(join(agentsRoot, 'evals', skill, 'fixtures', 'dataset.json'), 'utf8')) as {
          cases: { id: string }[];
        }
      ).cases.map((item) => item.id),
    );
    expect(ids.length).toBeGreaterThanOrEqual(39);
    for (const id of ids) expect(module).not.toContain(`"${id}"`);
    for (const suite of ['strategy-critique', 'strategy-formulation']) {
      for (const name of readdirSync(join(repositoryRoot, 'fixtures/agent-results', suite))) {
        expect(module).not.toContain(name.replace(/\.json$/, '.json'));
      }
    }
    for (const name of readdirSync(join(agentsRoot, 'src/methods')).filter((entry) => entry.endsWith('.md'))) {
      expect(module).not.toContain(name);
    }
    expect(module).not.toContain('fixture-policy');
  });

  it('records a bundle mismatch for an installed bundle with an extra file, and for a dispatch that names another bundle, and starts no executor', async () => {
    const api = await controlApi();
    const assembled = await formulationRequest();
    api.inputs.set(sha256Bytes(assembled.bytes), assembled.bytes);
    const cli = installFakeCli({ behaviour: 'result', resultText: JSON.stringify(await revisionOutput()) });
    // An installed copy of the bundle with one file that the manifest does not list.
    const tampered = join(scratch('oq-e2e-bundle-'), 'bundle');
    cpSync(join(built, 'bundle'), tampered, { recursive: true });
    mkdirSync(join(tampered, 'evals'), { recursive: true });
    writeFileSync(join(tampered, 'evals', 'expected.json'), '{"expected":"answer"}');
    const runner = await startBundle({
      AGENT_RUNNER_ENVIRONMENT: 'STAGING',
      AGENT_RUNNER_ENABLED: 'true',
      AGENT_RUNNER_DISPATCH_TOKEN: DISPATCH_TOKEN,
      AGENT_RUNNER_API_TOKEN: API_TOKEN,
      AGENT_RUNNER_API_BASE_URL: `http://127.0.0.1:${api.port}`,
      AGENT_RUNNER_EXECUTOR_PATH: cli.path,
      AGENT_RUNNER_EXECUTOR_VERSION: '2.1.325',
      AGENT_RUNNER_BUNDLE_DIR: tampered,
      AGENT_RUNNER_SCRATCH_DIR: join(scratch('oq-e2e-scratch-'), 'scratch'),
      ANTHROPIC_API_KEY: MODEL_KEY,
    });
    try {
      for (const [attempt, bundleHash] of [
        ['attempt-extra-file', undefined],
        ['attempt-other-hash', `sha256:${'9'.repeat(64)}`],
      ] as const) {
        const dispatch = dispatchFor(assembled, { attempt, ...(bundleHash ? { bundleHash } : {}) });
        const response = await fetch(`http://127.0.0.1:${runner.port}/v1/agent-attempts`, {
          method: 'POST',
          headers: { authorization: `Bearer ${DISPATCH_TOKEN}` },
          body: canonicalJson(dispatch),
        });
        expect(response.status).toBe(202);
      }
      await until(() => api.results.length === 2);
      for (const result of api.results as { outcome: { outcome: string; reason: string; diagnostic: string } }[]) {
        expect(result.outcome).toMatchObject({ outcome: 'denied_capability', reason: 'BUNDLE_MISMATCH' });
      }
      expect((api.results[0] as { outcome: { diagnostic: string } }).outcome.diagnostic).toContain(
        'evals/expected.json is in the bundle directory and not in the manifest',
      );
    } finally {
      expect(await runner.stop()).toBe(0);
    }
    expect(cli.calls()).toEqual([]);
  });

  it('runs a real attempt end to end with a fake executor, from the staged bundle and a scrubbed child environment', async () => {
    const api = await controlApi();
    const assembled = await formulationRequest();
    api.inputs.set(sha256Bytes(assembled.bytes), assembled.bytes);
    const cli = installFakeCli({ behaviour: 'result', resultText: JSON.stringify(await revisionOutput()) });
    const runner = await startBundle({
      AGENT_RUNNER_ENVIRONMENT: 'STAGING',
      AGENT_RUNNER_ENABLED: 'true',
      AGENT_RUNNER_DISPATCH_TOKEN: DISPATCH_TOKEN,
      AGENT_RUNNER_API_TOKEN: API_TOKEN,
      AGENT_RUNNER_API_BASE_URL: `http://127.0.0.1:${api.port}`,
      AGENT_RUNNER_EXECUTOR_PATH: cli.path,
      AGENT_RUNNER_EXECUTOR_VERSION: '2.1.325',
      AGENT_RUNNER_SCRATCH_DIR: join(scratch('oq-e2e-scratch-'), 'scratch'),
      ANTHROPIC_API_KEY: MODEL_KEY,
      CLOUDFLARE_API_TOKEN: HOST_SECRET,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${runner.port}/v1/agent-attempts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${DISPATCH_TOKEN}` },
        body: canonicalJson(dispatchFor(assembled)),
      });
      expect(response.status).toBe(202);
      await until(() => api.results.length === 1);
      expect(api.results[0]).toMatchObject({ outcome: { outcome: 'completion' } });
    } finally {
      expect(await runner.stop()).toBe(0);
    }
    const run = cli.calls().find((call) => call.kind === 'run');
    expect(run?.env.ANTHROPIC_API_KEY).toBe(MODEL_KEY);
    expect(JSON.stringify(run?.env)).not.toContain(HOST_SECRET);
    expect(JSON.stringify(run?.env)).not.toContain(API_TOKEN);
    expect(JSON.stringify(run?.env)).not.toContain(DISPATCH_TOKEN);
  });
});
