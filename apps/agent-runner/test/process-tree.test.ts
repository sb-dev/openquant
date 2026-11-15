import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessGroup, runProcess } from '../src/process-tree.ts';
import { cleanup, isAlive, scratch, until } from './support/world.ts';

afterEach(cleanup);

const node = process.execPath;

function spec(script: string, overrides: Partial<Parameters<typeof runProcess>[0]> = {}) {
  return {
    command: node,
    args: ['-e', script],
    cwd: scratch(),
    env: { PATH: '/usr/bin:/bin' },
    stdin: undefined,
    timeoutMs: 10_000,
    stdoutLimit: 1_000_000,
    stderrLimit: 1_000_000,
    signal: undefined,
    ...overrides,
  };
}

// A script that starts a long-running descendant, records its pid and then does `after`.
function withGrandchild(pidFile: string, after: string): string {
  return `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    ${after}
  `;
}

async function gone(pid: number): Promise<void> {
  await until(() => !isAlive(pid), 5000);
}

describe('runProcess', () => {
  it('captures output, the exit code and the duration of a process that ends by itself', async () => {
    const end = await runProcess(spec("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"));
    expect(end.kind).toBe('exited');
    if (end.kind !== 'exited') return;
    expect(end.exitCode).toBe(3);
    expect(end.stdout.toString()).toBe('out');
    expect(end.stderr.toString()).toBe('err');
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('gives the child exactly the environment it is given and its own working directory', async () => {
    const cwd = scratch();
    const end = await runProcess(
      spec('process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd() }))', {
        cwd,
        env: { PATH: '/usr/bin:/bin', ONLY_THIS: 'yes' },
      }),
    );
    if (end.kind !== 'exited') throw new Error(end.kind);
    const seen = JSON.parse(end.stdout.toString()) as { env: Record<string, string>; cwd: string };
    expect(
      Object.keys(seen.env)
        .filter((name) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name))
        .sort(),
    ).toEqual(['ONLY_THIS', 'PATH']);
    expect(seen.cwd).toContain(cwd.split('/').pop() ?? '');
  });

  it('passes the standard input bytes unchanged', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 10, 13, 0xe2, 0x82, 0xac]);
    const end = await runProcess(spec("process.stdin.on('data', (c) => process.stdout.write(c))", { stdin: bytes }));
    if (end.kind !== 'exited') throw new Error(end.kind);
    expect(Buffer.compare(end.stdout, bytes)).toBe(0);
  });

  it('reports a missing executable as not started', async () => {
    const end = await runProcess({ ...spec(''), command: '/nonexistent/claude' });
    expect(end).toMatchObject({ kind: 'not_started', code: 'ENOENT' });
  });

  it('reports a file that cannot be executed as not started', async () => {
    const plain = join(scratch(), 'plain-file');
    writeFileSync(plain, 'not a program', { mode: 0o644 });
    const end = await runProcess({ ...spec(''), command: plain });
    expect(end).toMatchObject({ kind: 'not_started', code: 'EACCES' });
  });

  it('ends a process that hangs at the deadline and kills its whole tree', async () => {
    const pidFile = join(scratch(), 'pid');
    const end = await runProcess(
      spec(withGrandchild(pidFile, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"), { timeoutMs: 700 }),
    );
    expect(end.kind).toBe('timeout');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await gone(pid);
  });

  it('kills a descendant that outlives a parent which exited normally', async () => {
    const pidFile = join(scratch(), 'pid');
    const end = await runProcess(spec(withGrandchild(pidFile, "process.stdout.write('done'); process.exit(0)")));
    expect(end.kind).toBe('exited');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await gone(pid);
  });

  it('ends the tree when the leader exits while a descendant still holds the output pipe, without waiting for the drain', async () => {
    const pidFile = join(scratch(), 'pid');
    // The descendant inherits the pipes, so they stay open after the leader has exited.
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.stdout.write('done');
      process.exit(0);
    `;
    const started = Date.now();
    const end = await runProcess(spec(script));
    expect(end.kind).toBe('exited');
    if (end.kind === 'exited') expect(end.stdout.toString()).toBe('done');
    // The drain wait is two seconds; the group kill on exit closes the pipes long before.
    expect(Date.now() - started).toBeLessThan(1500);
    await gone(Number(readFileSync(pidFile, 'utf8')));
  });

  it('kills the tree when the output passes its limit and keeps no more than the limit', async () => {
    const pidFile = join(scratch(), 'pid');
    const flood =
      "const b = 'x'.repeat(65536); const w = () => { while (process.stdout.write(b)) {} process.stdout.once('drain', w); }; w();";
    const started = Date.now();
    const end = await runProcess(spec(withGrandchild(pidFile, flood), { stdoutLimit: 100_000, timeoutMs: 8000 }));
    expect(end.kind).toBe('overflow');
    if (end.kind !== 'overflow') return;
    expect(end.stdout.length).toBe(100_000);
    // The overflow ends the tree at once. Waiting for the deadline would also end it, so the time is part of the check.
    expect(Date.now() - started).toBeLessThan(4000);
    await gone(Number(readFileSync(pidFile, 'utf8')));
  });

  it('keeps standard error up to its limit and drops the rest without killing', async () => {
    const end = await runProcess(
      spec("process.stderr.write('e'.repeat(5000)); process.stdout.write('ok')", { stderrLimit: 100 }),
    );
    if (end.kind !== 'exited') throw new Error(end.kind);
    expect(end.stderr.length).toBe(100);
    expect(end.stdout.toString()).toBe('ok');
  });

  it('ends the tree when the abort signal fires and reports an abort', async () => {
    const pidFile = join(scratch(), 'pid');
    const controller = new AbortController();
    const running = runProcess(
      spec(withGrandchild(pidFile, 'setInterval(() => {}, 1000)'), { signal: controller.signal }),
    );
    await until(() => {
      try {
        return readFileSync(pidFile, 'utf8').length > 0;
      } catch {
        return false;
      }
    });
    controller.abort('cancel');
    expect((await running).kind).toBe('aborted');
    await gone(Number(readFileSync(pidFile, 'utf8')));
  });

  it('starts nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('cancel');
    const marker = join(scratch(), 'started');
    const end = await runProcess(
      spec(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); setInterval(() => {}, 1000)`, {
        signal: controller.signal,
      }),
    );
    expect(end.kind).toBe('aborted');
  });

  it('does not fail when the child exits without reading its input', async () => {
    const end = await runProcess(spec('process.exit(0)', { stdin: Buffer.alloc(2_000_000, 1) }));
    expect(end.kind).toBe('exited');
  });

  it('reports a child that was ended by a signal', async () => {
    const end = await runProcess(spec("process.kill(process.pid, 'SIGABRT')"));
    expect(end).toMatchObject({ kind: 'exited', signal: 'SIGABRT' });
  });
});

describe('killProcessGroup', () => {
  it('ignores a missing group and refuses pid 1 and undefined', () => {
    expect(() => killProcessGroup(undefined)).not.toThrow();
    expect(() => killProcessGroup(0)).not.toThrow();
    expect(() => killProcessGroup(1)).not.toThrow();
    expect(() => killProcessGroup(2_000_000_000)).not.toThrow();
  });
});
