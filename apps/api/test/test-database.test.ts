// The test database provisioning (tools/test-database.ts): how binaries are found, what happens without a database,
// the URL variable, the stale sweep, and a real cluster that starts, answers and leaves nothing behind. The global
// setup of this very run uses the same code, so a run that gets this far has provisioned a cluster.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  directoryVersion,
  findBinaries,
  freePort,
  type Machine,
  MINIMUM_MAJOR,
  majorVersion,
  noDatabaseMessage,
  provisionTestDatabase,
  realMachine,
  sweepStaleClusters,
  URL_VARIABLE,
} from '../tools/test-database.ts';

const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** A machine with the given directories: each holds all three binaries and reports its major version. */
function machineWith(
  bins: Record<string, number>,
  options: { env?: Record<string, string | undefined>; pgConfig?: string; missing?: string[] } = {},
): Machine {
  return {
    env: options.env ?? { PATH: '' },
    list: (directory) => {
      const names = new Set<string>();
      for (const bin of Object.keys(bins)) {
        const match = new RegExp(`^${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/bin$`).exec(bin);
        if (match?.[1]) names.add(match[1]);
      }
      return names.size === 0 ? undefined : [...names];
    },
    exists: (path) =>
      Object.keys(bins).some((bin) => path.startsWith(`${bin}/`)) && !(options.missing ?? []).includes(path),
    output: (program, args) => {
      if (program === 'pg_config') return options.pgConfig === undefined ? undefined : `${options.pgConfig}\n`;
      const bin = program.replace(/\/initdb$/, '');
      const major = bins[bin];
      return args[0] === '--version' && major !== undefined ? `initdb (PostgreSQL) ${major}.3 (Test)\n` : undefined;
    },
  };
}

describe('finding the PostgreSQL binaries', () => {
  it('reads the major version of initdb --version', () => {
    expect(majorVersion('initdb (PostgreSQL) 16.10 (Ubuntu 16.10-0ubuntu0.24.04.1)\n')).toBe(16);
    expect(majorVersion('initdb (PostgreSQL) 9.6.24')).toBe(9);
    expect(majorVersion('initdb (PostgreSQL) 17devel')).toBe(17);
    expect(majorVersion('something else')).toBeUndefined();
    expect(majorVersion(undefined)).toBeUndefined();
  });

  it('orders directory names by version number, not by text', () => {
    expect(directoryVersion('9.6')).toBeLessThan(directoryVersion('16'));
    expect(directoryVersion('postgresql@9')).toBeLessThan(directoryVersion('postgresql@16'));
    expect(directoryVersion('/usr/lib/postgresql/10/bin')).toBe(10);
    expect(directoryVersion('/usr/lib/postgresql/9/bin')).toBe(9);
    expect(directoryVersion('/usr/lib/postgresql/17/bin')).toBe(17);
    expect(['10', '9', '16', '9.6'].sort((left, right) => directoryVersion(right) - directoryVersion(left))).toEqual([
      '16',
      '10',
      '9',
      '9.6',
    ]);
  });

  it('takes the highest version of /usr/lib/postgresql that is at least the minimum', () => {
    const machine = machineWith({
      '/usr/lib/postgresql/16/bin': 16,
      '/usr/lib/postgresql/9.6/bin': 9,
      '/usr/lib/postgresql/17/bin': 17,
      '/usr/lib/postgresql/15/bin': 15,
    });
    expect(findBinaries(machine)).toEqual({ directory: '/usr/lib/postgresql/17/bin', major: 17 });
  });

  it('ignores a version below the minimum, and finds nothing when only those exist', () => {
    expect(MINIMUM_MAJOR).toBe(14);
    expect(
      findBinaries(machineWith({ '/usr/lib/postgresql/13/bin': 13, '/usr/lib/postgresql/9.6/bin': 9 })),
    ).toBeUndefined();
    expect(
      findBinaries(machineWith({ '/usr/lib/postgresql/13/bin': 13, '/usr/lib/postgresql/14/bin': 14 }))?.major,
    ).toBe(14);
    expect(findBinaries(machineWith({}))).toBeUndefined();
  });

  it('prefers the directory of pg_config, then PATH, when the versions are equal', () => {
    const bins = { '/opt/pg/bin': 16, '/usr/lib/postgresql/16/bin': 16, '/home/tool/bin': 16 };
    expect(findBinaries(machineWith(bins, { pgConfig: '/opt/pg/bin' }))?.directory).toBe('/opt/pg/bin');
    expect(findBinaries(machineWith(bins, { env: { PATH: '/home/tool/bin:/usr/bin' } }))?.directory).toBe(
      '/home/tool/bin',
    );
    expect(findBinaries(machineWith(bins))?.directory).toBe('/usr/lib/postgresql/16/bin');
  });

  it('skips a directory that lacks one of initdb, pg_ctl and postgres', () => {
    const bins = { '/usr/lib/postgresql/17/bin': 17, '/usr/lib/postgresql/16/bin': 16 };
    for (const missing of ['initdb', 'pg_ctl', 'postgres']) {
      const machine = machineWith(bins, { missing: [`/usr/lib/postgresql/17/bin/${missing}`] });
      expect(findBinaries(machine)?.major, missing).toBe(16);
    }
  });

  it('finds the binaries of this machine, or none, without throwing', () => {
    const found = findBinaries();
    if (found) expect(found.major).toBeGreaterThanOrEqual(MINIMUM_MAJOR);
    else expect(found).toBeUndefined();
  });
});

describe('without a database', () => {
  it('fails with instructions that name the variable, the install command and the search places', () => {
    const message = noDatabaseMessage();
    expect(message).toContain(URL_VARIABLE);
    expect(message).toContain('apt-get install postgresql');
    expect(message).toContain('/usr/lib/postgresql/<version>/bin');
    expect(message).toContain('pg_config --bindir');
    expect(message).toContain('runuser');
  });

  it('does not skip: no URL and no binaries is an error with those instructions', async () => {
    await expect(provisionTestDatabase(machineWith({}))).rejects.toThrow(new RegExp(URL_VARIABLE));
  });

  it('uses the URL of the environment as it is, and starts nothing', async () => {
    const calls: string[] = [];
    const base = machineWith({});
    const machine: Machine = {
      ...base,
      env: { [URL_VARIABLE]: 'postgres://localhost:5432/anything' },
      output: (program, args) => {
        calls.push(program);
        return base.output(program, args);
      },
    };
    const cluster = await provisionTestDatabase(machine);
    expect(cluster).toMatchObject({ source: 'url', adminUrl: 'postgres://localhost:5432/anything' });
    await cluster.stop();
    expect(calls).toEqual([]);
  });
});

describe('a temporary cluster', () => {
  it('starts, answers on a TCP port of 127.0.0.1, and leaves nothing behind when it is stopped', async () => {
    const machine: Machine = { ...realMachine, env: { ...process.env, [URL_VARIABLE]: undefined } };
    if (findBinaries(machine) === undefined) {
      // No server binaries here: the run is using a URL, and the provisioning refuses to guess.
      await expect(provisionTestDatabase(machine)).rejects.toThrow(/No PostgreSQL test database is available/);
      return;
    }
    const before = new Set(sweepCandidates());
    const cluster = await provisionTestDatabase(machine);
    expect(cluster.source).toBe('cluster');
    const url = new URL(cluster.adminUrl);
    expect(url.hostname).toBe('127.0.0.1');
    expect(Number(url.port)).toBeGreaterThan(1023);
    const client = new Client({ connectionString: cluster.adminUrl });
    await client.connect();
    const row = await client.query<{ version: string; fsync: string }>(
      "SELECT version(), current_setting('fsync') AS fsync",
    );
    expect(row.rows[0]?.version).toMatch(/^PostgreSQL \d+/);
    expect(row.rows[0]?.fsync).toBe('off');
    await client.end();
    const created = sweepCandidates().filter((name) => !before.has(name));
    expect(created).toHaveLength(1);
    await cluster.stop();
    await cluster.stop();
    expect(existsSync(join(tmpdir(), created[0] as string))).toBe(false);
    const after = new Client({ connectionString: cluster.adminUrl, connectionTimeoutMillis: 2000 });
    after.on('error', () => undefined);
    await expect(after.connect()).rejects.toBeDefined();
  });
});

function sweepCandidates(): string[] {
  const listing = spawnSync('ls', [tmpdir()], { encoding: 'utf8' }).stdout.split('\n');
  return listing.filter((name) => name.startsWith('openquant-pg-'));
}

describe('removing the directories of dead clusters', () => {
  function layout() {
    const parent = mkdtempSync(join(tmpdir(), 'oq-sweep-'));
    scratch.push(parent);
    const make = (name: string, pid?: number, ageMinutes = 0) => {
      const directory = join(parent, name);
      mkdirSync(join(directory, 'data'), { recursive: true });
      if (pid !== undefined) writeFileSync(join(directory, 'data', 'postmaster.pid'), `${pid}\n/data\n`);
      const when = new Date(Date.now() - ageMinutes * 60_000);
      utimesSync(directory, when, when);
      return directory;
    };
    return { parent, make };
  }

  it('removes a cluster whose postmaster is dead and keeps one that is running', () => {
    const { parent, make } = layout();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(dead.stdout);
    const gone = make('openquant-pg-dead', deadPid);
    const alive = make('openquant-pg-alive', process.pid);
    const removed = sweepStaleClusters(parent);
    expect(removed).toEqual([gone]);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(alive)).toBe(true);
  });

  it('leaves a young directory without a pid file, and removes it once it is ten minutes old', () => {
    const { parent, make } = layout();
    const young = make('openquant-pg-young');
    expect(sweepStaleClusters(parent)).toEqual([]);
    expect(existsSync(young)).toBe(true);
    expect(sweepStaleClusters(parent, Date.now() + 11 * 60_000)).toEqual([young]);
    expect(existsSync(young)).toBe(false);
  });

  it('touches nothing else: other names, files and a directory that does not exist', () => {
    const { parent, make } = layout();
    const other = make('somebody-elses', 99999999, 60);
    expect(sweepStaleClusters(parent, Date.now() + 60 * 60_000)).toEqual([]);
    expect(existsSync(other)).toBe(true);
    expect(sweepStaleClusters(join(parent, 'missing'))).toEqual([]);
  });
});

describe('free ports', () => {
  it('returns a port that can be bound once the call has returned', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1023);
    expect(port).toBeLessThan(65536);
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
    });
  });
});
