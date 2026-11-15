// Test database provisioning (OQ-06 section 1: real-Postgres tests; plan P2 part A).
//
// 1. OPENQUANT_TEST_DATABASE_URL names an existing server whose role may create databases: use it.
// 2. Otherwise start a temporary cluster from PostgreSQL binaries found on the machine: initdb and pg_ctl in a
//    temporary directory, a Unix socket directory, a random TCP port on 127.0.0.1. As root, PostgreSQL refuses to
//    run, so every command goes through `runuser -u postgres`. The cluster is stopped and its directory removed when
//    the run ends, on exit, on SIGINT and on SIGTERM; a sweep at start removes the directories of dead clusters.
// 3. Otherwise fail with instructions. A test run never skips for lack of a database.
//
// Runs in Node only. Nothing here is a Worker module. Unverified until a pull request runs: the CI path (a non-root
// runner with PostgreSQL binaries under /usr/lib/postgresql and no service container), and Turborepo's strict
// environment mode passing OPENQUANT_TEST_DATABASE_URL, PATH and TMPDIR (apps/api/turbo.json lists them).

import { type ExecFileSyncOptions, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const MINIMUM_MAJOR = 14;
export const URL_VARIABLE = 'OPENQUANT_TEST_DATABASE_URL';
const ROLE = 'openquant_test';
const DIRECTORY_PREFIX = 'openquant-pg-';

export interface PostgresBinaries {
  readonly directory: string;
  readonly major: number;
}

/** Everything the search and the start read from the machine, so tests can replace it. */
export interface Machine {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Names in a directory, or undefined when it does not exist. */
  readonly list: (directory: string) => string[] | undefined;
  readonly exists: (path: string) => boolean;
  /** Run a program and return its standard output, or undefined when it fails or is missing. */
  readonly output: (program: string, args: readonly string[]) => string | undefined;
}

export const realMachine: Machine = {
  env: process.env,
  list: (directory) => {
    try {
      return readdirSync(directory);
    } catch {
      return undefined;
    }
  },
  exists: (path) => existsSync(path),
  output: (program, args) => {
    try {
      return execFileSync(program, [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 20_000,
      });
    } catch {
      return undefined;
    }
  },
};

/** The major version of `initdb --version`, such as 16 for "initdb (PostgreSQL) 16.10". */
export function majorVersion(versionOutput: string | undefined): number | undefined {
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.\d+)?/.exec(versionOutput ?? '');
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

// Numeric order of the version in a directory name: postgresql@9 before postgresql@16, not after it.
export function directoryVersion(path: string): number {
  const match = /(\d+)(?:\.\d+)*(?=[^\d]*$)/.exec(path.replace(/\/bin$/, ''));
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

/**
 * The PostgreSQL binaries to use: the directory of `pg_config --bindir`, the directories of PATH, then the usual
 * install places, the highest version first. A directory counts when it holds initdb, pg_ctl and postgres and is at
 * least MINIMUM_MAJOR. Returns undefined when none does.
 */
export function findBinaries(machine: Machine = realMachine): PostgresBinaries | undefined {
  const candidates: string[] = [];
  const bindir = machine.output('pg_config', ['--bindir'])?.trim();
  if (bindir) candidates.push(bindir);
  for (const entry of (machine.env.PATH ?? '').split(delimiter)) if (entry) candidates.push(entry);
  const roots: [string, RegExp][] = [
    ['/usr/lib/postgresql', /^\d+(?:\.\d+)*$/],
    ['/opt/homebrew/opt', /^postgresql@\d+$/],
    ['/usr/local/opt', /^postgresql@\d+$/],
  ];
  for (const [root, pattern] of roots) {
    const names = (machine.list(root) ?? []).filter((name) => pattern.test(name));
    names.sort((left, right) => directoryVersion(right) - directoryVersion(left));
    for (const name of names) candidates.push(`${root}/${name}/bin`);
  }
  candidates.push('/usr/local/pgsql/bin');
  const found: PostgresBinaries[] = [];
  for (const directory of new Set(candidates)) {
    if (!['initdb', 'pg_ctl', 'postgres'].every((name) => machine.exists(`${directory}/${name}`))) continue;
    const major = majorVersion(machine.output(`${directory}/initdb`, ['--version']));
    if (major !== undefined && major >= MINIMUM_MAJOR) found.push({ directory, major });
  }
  // The highest major version wins; among equal ones the earlier candidate (pg_config, then PATH) does.
  return found.sort((left, right) => right.major - left.major)[0];
}

export function noDatabaseMessage(): string {
  return [
    `No PostgreSQL test database is available. Do one of these:`,
    `  1. Set ${URL_VARIABLE} to the connection string of a PostgreSQL ${MINIMUM_MAJOR}+ server whose role may create databases.`,
    `  2. Install the PostgreSQL ${MINIMUM_MAJOR}+ server binaries (for example: apt-get install postgresql) and run the tests again.`,
    `     The binaries (initdb, pg_ctl and postgres) are searched in the directory of pg_config --bindir, in PATH,`,
    `     in /usr/lib/postgresql/<version>/bin (highest version first), in Homebrew's postgresql@<version> and in`,
    `     /usr/local/pgsql/bin. A temporary cluster is started in a temporary directory and removed afterwards.`,
    `As root, PostgreSQL refuses to run: the cluster is started as the "postgres" user through runuser, which must exist.`,
  ].join('\n');
}

export interface TestCluster {
  /** A connection string of a database in which the role may create databases. */
  readonly adminUrl: string;
  readonly source: 'url' | 'cluster';
  /** Stops the cluster and removes its directory. A no-op for a URL. */
  stop(): Promise<void>;
}

/** A random free TCP port on 127.0.0.1. The port can be taken before the cluster binds it; the caller retries. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port);
        else reject(new Error('The server has no port.'));
      });
    });
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove the directories of clusters that are not running any more (a crashed run leaves one). */
export function sweepStaleClusters(directory: string = tmpdir(), now: number = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(DIRECTORY_PREFIX)) continue;
    const path = join(directory, name);
    let stale = false;
    try {
      const pidFile = join(path, 'data', 'postmaster.pid');
      if (existsSync(pidFile)) {
        const pid = Number.parseInt(readFileSync(pidFile, 'utf8').split('\n')[0] ?? '', 10);
        stale = Number.isFinite(pid) && !processAlive(pid);
      } else {
        // No postmaster.pid: initdb never finished, or the cluster stopped. Leave a young directory alone.
        stale = now - statSync(path).mtimeMs > 10 * 60 * 1000;
      }
      if (stale) {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      }
    } catch {
      // Another process removed it, or it belongs to someone else: not ours to clean.
    }
  }
  return removed;
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function connectionUrl(port: number): string {
  const url = new URL('postgres://127.0.0.1');
  url.username = ROLE;
  url.port = String(port);
  url.pathname = '/postgres';
  return url.href;
}

/** Start a temporary cluster. Throws when the binaries are missing or the cluster does not start. */
export async function startCluster(binaries: PostgresBinaries): Promise<TestCluster> {
  sweepStaleClusters();
  const asRoot = isRoot();
  // The postgres user must be able to walk to the directory. TMPDIR can name a place that it cannot enter.
  const parents = [tmpdir(), '/tmp'];
  let base: string | undefined;
  for (const parent of parents) {
    const candidate = mkdtempSync(join(parent, DIRECTORY_PREFIX));
    if (!asRoot) {
      base = candidate;
      break;
    }
    try {
      execFileSync('chown', ['postgres:', candidate]);
      execFileSync('runuser', ['-u', 'postgres', '--', 'test', '-w', candidate]);
      base = candidate;
      break;
    } catch {
      rmSync(candidate, { recursive: true, force: true });
    }
  }
  if (base === undefined) throw new Error('No temporary directory is writable by the postgres user.');
  const directory = base;
  const data = join(directory, 'data');
  const sockets = join(directory, 'sockets');
  const prefix = asRoot ? ['runuser', '-u', 'postgres', '--'] : [];
  const run = (program: string, args: readonly string[], options: ExecFileSyncOptions = {}): void => {
    const [first, ...rest] = [...prefix, `${binaries.directory}/${program}`, ...args];
    if (first === undefined) throw new Error('No program to run.');
    execFileSync(first, rest, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, ...options });
  };
  const stopSync = (): void => {
    try {
      run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    } catch {
      // Not running, or already stopped.
    }
    rmSync(directory, { recursive: true, force: true });
  };
  let stopped = false;
  const stopOnce = (): void => {
    if (stopped) return;
    stopped = true;
    stopSync();
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    stopOnce();
    process.kill(process.pid, signal);
  };
  process.once('exit', stopOnce);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    run('initdb', ['-D', data, '-U', ROLE, '--auth=trust', '-E', 'UTF8', '--no-locale']);
    execFileSync('mkdir', ['-p', sockets]);
    if (asRoot) execFileSync('chown', ['postgres:', sockets]);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = await freePort();
      const options = [
        `-p ${port}`,
        '-c listen_addresses=127.0.0.1',
        `-c unix_socket_directories=${sockets}`,
        '-c fsync=off',
        '-c synchronous_commit=off',
        '-c full_page_writes=off',
        '-c timezone=UTC',
        '-c max_connections=100',
        '-c log_min_messages=warning',
      ].join(' ');
      try {
        run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', options, '-w', 'start']);
        return {
          adminUrl: connectionUrl(port),
          source: 'cluster',
          stop: async () => {
            stopOnce();
            process.removeListener('exit', stopOnce);
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
          },
        };
      } catch (error) {
        lastError = error;
      }
    }
    const log = existsSync(join(directory, 'postgres.log'))
      ? readFileSync(join(directory, 'postgres.log'), 'utf8').slice(-2000)
      : '';
    throw new Error(
      `The test cluster did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${log}`,
    );
  } catch (error) {
    stopOnce();
    process.removeListener('exit', stopOnce);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    throw error;
  }
}

/** The database for this run: the URL of the environment, a temporary cluster, or a clear failure. */
export async function provisionTestDatabase(machine: Machine = realMachine): Promise<TestCluster> {
  const url = machine.env[URL_VARIABLE];
  if (url) return { adminUrl: url, source: 'url', stop: async () => undefined };
  const binaries = findBinaries(machine);
  if (!binaries) throw new Error(noDatabaseMessage());
  return startCluster(binaries);
}
