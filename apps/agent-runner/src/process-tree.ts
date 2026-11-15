// Process control for the delegated executor (OQ-03 sections 3 and 5): one child in its own process group, a hard
// limit on the bytes it may write, a deadline, an abort signal and termination of the whole tree.
//
// The child is started detached, so it leads a new process group whose id is its pid. Every end of the run kills
// that group with SIGKILL: a timeout, an overflow, an abort, and also a normal exit, because a descendant that
// outlives its parent would otherwise run unbounded. A descendant that leaves the group (setsid) is outside this
// control. That is a recorded limit; the executor probe of the deployment checks it (OQ-03 section 6). The runner
// is POSIX-only because it needs process groups.

import { type ChildProcess, spawn } from 'node:child_process';

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The complete environment of the child. Nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: Uint8Array | undefined;
  readonly timeoutMs: number;
  /** The most bytes of standard output that are read. One more byte kills the tree. */
  readonly stdoutLimit: number;
  /** Standard error is kept up to this many bytes and the rest is dropped. */
  readonly stderrLimit: number;
  readonly signal: AbortSignal | undefined;
}

interface Captured {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly durationMs: number;
}

export type ProcessEnd =
  | { readonly kind: 'not_started'; readonly code: string; readonly message: string }
  | (Captured & {
      readonly kind: 'exited';
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    })
  | (Captured & { readonly kind: 'timeout' })
  | (Captured & { readonly kind: 'overflow' })
  | (Captured & { readonly kind: 'aborted' });

/** How long the pipes may stay open after the leader exited and its group was killed. */
const DRAIN_MS = 2000;

/** Kill every process of the group that `pid` leads. A group that is already gone is not an error. */
export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 1) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: nothing is left in the group.
  }
}

export function runProcess(spec: ProcessSpec): Promise<ProcessEnd> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      resolve({ kind: 'not_started', code: 'EPLATFORM', message: 'the runner needs POSIX process groups' });
      return;
    }
    const started = performance.now();
    let child: ChildProcess;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ kind: 'not_started', code: codeOf(error), message: messageOf(error) });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let verdict: 'timeout' | 'overflow' | 'aborted' | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;

    const kill = () => killProcessGroup(child.pid);
    const timeout = setTimeout(() => {
      verdict ??= 'timeout';
      kill();
    }, spec.timeoutMs);
    const onAbort = () => {
      verdict ??= 'aborted';
      kill();
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      spec.signal?.removeEventListener('abort', onAbort);
      kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      const captured: Captured = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        durationMs: Math.round(performance.now() - started),
      };
      if (verdict) resolve({ kind: verdict, ...captured });
      else resolve({ kind: 'exited', exitCode: exit?.code ?? null, signal: exit?.signal ?? null, ...captured });
    };

    child.on('error', (error) => {
      // A failed spawn emits `error` and no `exit`: the pid is undefined.
      if (child.pid === undefined && !settled) {
        settled = true;
        clearTimeout(timeout);
        spec.signal?.removeEventListener('abort', onAbort);
        resolve({ kind: 'not_started', code: codeOf(error), message: messageOf(error) });
      }
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (verdict === 'overflow') return;
      const room = spec.stdoutLimit - stdoutBytes;
      if (chunk.length > room) {
        if (room > 0) stdout.push(chunk.subarray(0, room));
        stdoutBytes = spec.stdoutLimit;
        verdict ??= 'overflow';
        kill();
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const room = spec.stderrLimit - stderrBytes;
      if (room <= 0) return;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderr.push(kept);
      stderrBytes += kept.length;
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // The leader is gone: end every descendant, then give the pipes a moment to drain.
      kill();
      drainTimer = setTimeout(finish, DRAIN_MS);
    });
    child.on('close', finish);

    // A child that exits without reading its input breaks the pipe; that is not an error of the runner.
    child.stdin?.on('error', () => undefined);
    if (spec.stdin && spec.stdin.byteLength > 0) child.stdin?.end(Buffer.from(spec.stdin));
    else child.stdin?.end();
  });
}

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
