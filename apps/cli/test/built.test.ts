// The built binary (OQ-06 section 2.2: installed-package smoke tests): tools/bundle.ts builds dist/openquant.mjs into
// a directory of this test, and the test runs it with Node, without node_modules beside it, against a loopback HTTP
// fake of the API: help, login with the credential on stdin, a view in text and in --json, the exit codes of a
// refusal and of a missing login, and a command whose process is killed after the API received it and before it
// answered (OQ-04 section 12).

import { execFile, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleCli } from '../tools/bundle.ts';
import { accessToken, apiError, CREDENTIAL, fixture } from './support.ts';

let directory: string;
let binary: string;
let server: Server;
let base: string;
/** The seed registrations the fake API received, and a hook that holds the next one without an answer. */
const seeds: { command_id: string; payload: { kind: string } }[] = [];
let holdNext: ((commandId: string) => void) | undefined;
const held: ServerResponse[] = [];

beforeAll(async () => {
  directory = mkdtempSync(resolve(tmpdir(), 'openquant-built-'));
  const built = await bundleCli(resolve(directory, 'build'));
  expect(built.problems).toEqual([]);
  // The binary alone, away from the workspace and its node_modules.
  binary = resolve(directory, 'openquant.mjs');
  copyFileSync(built.file, binary);
  server = createServer((request, response) => {
    const answer = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const auth = request.headers.authorization;
    if (request.method === 'POST' && request.url === '/v1/auth/token') {
      return auth === `Bearer ${CREDENTIAL}`
        ? answer(200, accessToken(['Researcher'], 'oqa1.built-token'))
        : answer(401, apiError('UNAUTHENTICATED'));
    }
    if (auth !== 'Bearer oqa1.built-token') return answer(401, apiError('UNAUTHENTICATED'));
    if (request.method === 'GET' && request.url === '/v1/system/identity') {
      return answer(200, fixture('system-identity-view.release-recorded.json'));
    }
    if (request.method === 'GET' && request.url === '/v1/missions/msn-00000a/decisions') {
      return answer(200, fixture('decisions-view.concluded.json'));
    }
    if (request.method === 'POST' && request.url === '/v1/budgets') return answer(403, apiError('FORBIDDEN'));
    if (request.method === 'POST' && request.url === '/v1/strategies/seeds') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seeds.push(command);
        const hold = holdNext;
        if (hold !== undefined) {
          // Received and kept, but never answered: the client is killed while it waits.
          holdNext = undefined;
          held.push(response);
          hold(command.command_id);
          return;
        }
        answer(202, applied(command.command_id));
      });
      return;
    }
    const status = /^\/v1\/commands\/([^/]+)$/.exec(request.url ?? '');
    if (request.method === 'GET' && status !== null) {
      const known = seeds.find((command) => command.command_id === status[1]);
      return known === undefined ? answer(404, apiError('NOT_FOUND')) : answer(200, applied(known.command_id));
    }
    return answer(404, apiError('NOT_FOUND'));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

const applied = (commandId: string) => ({
  ...fixture('command.status-applied.json'),
  command_id: commandId,
  kind: 'register_seed',
  record: { id: 'daily-swing-seed', revision: 1 },
});

afterAll(async () => {
  for (const response of held) response.destroy();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(directory, { recursive: true, force: true });
});

const environment = (config: string) => ({
  PATH: process.env.PATH ?? '',
  OPENQUANT_CONFIG_DIR: resolve(directory, config),
});

function run(args: string[], stdin = '', config = 'config'): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [binary, ...args],
      { env: environment(config), timeout: 30_000 },
      (error, stdout, stderr) => {
        done({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr });
      },
    );
    child.stdin?.end(stdin);
  });
}

describe('the built openquant binary', () => {
  it('runs on its own and prints its help', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: openquant <command> [options] [--json]');
    expect(help.stdout).toContain('mission run-now <mission-id>');
    expect((await run(['no-such-command'])).code).toBe(2);
  });

  it('refuses a view before login with exit 3', async () => {
    const refused = await run(['mission', 'decisions', 'msn-00000a', '--json']);
    expect(refused.code).toBe(3);
    expect(JSON.parse(refused.stdout).error.code).toBe('CLI_UNAUTHENTICATED');
  });

  it('logs in over HTTP, keeps the credential in a 0600 file, and reads a view in text and in JSON', async () => {
    const login = await run(['login', '--api', base], `${CREDENTIAL}\n`);
    expect(login.code).toBe(0);
    expect(login.stdout).toContain('Logged in as Researcher (human-researcher)');
    expect(`${login.stdout}${login.stderr}`).not.toContain(CREDENTIAL);
    expect(statSync(resolve(directory, 'config', 'credentials.json')).mode & 0o777).toBe(0o600);

    const text = await run(['mission', 'decisions', 'msn-00000a']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('OpenQuant | env DEV | mode BACKTEST | money SIMULATED | tz UTC');
    expect(text.stdout).toContain('EVALUATING -> PAPER Decision: none recorded');
    for (const line of text.stdout.split('\n')) expect(line.length).toBeLessThanOrEqual(80);

    const json = await run(['mission', 'decisions', 'msn-00000a', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).data).toEqual(fixture('decisions-view.concluded.json'));
    expect(json.stdout).not.toContain('oqa1.built-token');

    expect((await run(['budget', 'register', '--file', resolve(directory, 'missing.json')])).code).toBe(2);
    const budget = resolve(directory, 'budget.json');
    writeFileSync(budget, JSON.stringify(fixture('command.register-budget.json').payload.budget));
    const forbidden = await run(['budget', 'register', '--file', budget]);
    expect(forbidden.code).toBe(4);
    expect(forbidden.stdout).toContain('This command needs one of these roles: Steward.');
  });

  it('keeps a command killed after the API received it, and settles it with the same command ID, sent once', async () => {
    const config = 'config-interrupted';
    expect((await run(['login', '--api', base], `${CREDENTIAL}\n`, config)).code).toBe(0);
    const { kind: _, ...document } = fixture('command.register-seed.json').payload;
    const seed = resolve(directory, 'seed.json');
    writeFileSync(seed, JSON.stringify(document));

    const received = new Promise<string>((done) => {
      holdNext = done;
    });
    const child = spawn(process.execPath, [binary, 'seed', 'register', '--file', seed], {
      env: environment(config),
      stdio: 'ignore',
    });
    const exited = new Promise<string>((done) => child.on('exit', (code, signal) => done(signal ?? `exit ${code}`)));
    const commandId = await Promise.race([received, exited.then((how) => Promise.reject(new Error(how)))]);
    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');
    expect(seeds).toHaveLength(1);

    // The rerun sends nothing new: the interrupted command must be resolved first.
    const again = await run(['seed', 'register', '--file', seed, '--json'], '', config);
    expect(again.code).toBe(9);
    expect(JSON.parse(again.stdout).error.message).toContain(commandId);
    expect(seeds).toHaveLength(1);

    const resolved = await run(['command', 'resolve', commandId, '--json'], '', config);
    expect(resolved.code).toBe(0);
    expect(JSON.parse(resolved.stdout).data).toMatchObject({ command_id: commandId, state: 'APPLIED' });
    expect(seeds.map((command) => command.command_id)).toEqual([commandId]);
    expect((await run(['seed', 'register', '--file', seed, '--json'], '', config)).code).toBe(0);
    expect(seeds).toHaveLength(2);
    expect(seeds[1]?.command_id).not.toBe(commandId);
  });
});
