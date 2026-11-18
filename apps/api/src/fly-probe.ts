// The termination probe of the Fly hosts (decision D22; OQ-05 section 4: lease expiry releases nothing until termination
// is confirmed). It asks the Fly Machines API about the Machine that ran a fenced attempt and confirms the termination
// only when that Machine is `stopped` or `destroyed`. Every other answer confirms nothing: another state (`started`,
// `stopping`, `suspended`, `replacing`, ...), a state it does not know, an answer that is not about that Machine, a status
// other than 200 (a 404 too: a wrong app, a token without access, or a Machine already purged look the same), an error,
// a redirect (never followed) and a timeout. The reservation then stays RESERVED and the attention item stays open.
//
// How an attempt is mapped to its Machine: the host names itself in the claim (`attempt-claim/1` worker_id, stored on
// the attempt). On a Fly Machine, the agent runner and engine-batch build that name from FLY_MACHINE_ID, which Fly
// sets on every Machine, as `fly:<machine id>:<process>`; `flyMachineOf` reads it back. The app is chosen by the
// destination of the attempt, never by the worker: a worker that names a Machine of another app gets a 404 and
// confirms nothing. The name grants no authority (OQ-05 section 9); it only says which Machine to ask about.
//
// The probe reports no usage: a Machine state says nothing about spend, so a confirmation leaves the reservation
// UNRECONCILED (the full amount counts as spent) until a usage report settles it.
//
// Worker-safe: fetch and AbortSignal only, no Node built-in.

import type { LogEntry } from './env.ts';
import type { FencedAttempt, TerminationEvidence, TerminationProbe } from './recovery.ts';

/** The public Machines API endpoint. */
export const FLY_MACHINES_API = 'https://api.machines.dev';

/** The Machine states that prove the process of the attempt has ended. */
export const TERMINATED_STATES: ReadonlySet<string> = new Set(['stopped', 'destroyed']);

const WORKER_ON_FLY = /^fly:([0-9a-z]{1,32}):/;
const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The Fly Machine ID that a worker name carries (`fly:<machine id>:<process>`), or undefined. */
export function flyMachineOf(workerId: string | null | undefined): string | undefined {
  return WORKER_ON_FLY.exec(workerId ?? '')?.[1];
}

/** Whether `name` can be a Fly app name: lowercase letters, digits and hyphens. */
export function validFlyAppName(name: string): boolean {
  return APP_NAME.test(name);
}

export interface FlyProbeOptions {
  /** A Fly token that can read the Machines of both apps. Never logged. */
  readonly token: string;
  /** The Fly app of each destination. */
  readonly apps: Readonly<Record<FencedAttempt['destination'], string>>;
  readonly fetch?: typeof fetch;
  /** Per request, headers and body together. Default 5 seconds. */
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
  readonly log?: (entry: LogEntry) => void;
}

const unconfirmed: TerminationEvidence = { terminated: false };

export function createFlyTerminationProbe(options: FlyProbeOptions): TerminationProbe {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const base = options.baseUrl ?? FLY_MACHINES_API;
  const note = (attempt: FencedAttempt, reason: string): TerminationEvidence => {
    options.log?.({
      level: 'warn',
      message: 'termination probe: not confirmed',
      attempt_id: attempt.attemptId,
      reason,
    });
    return unconfirmed;
  };
  return {
    async check(attempt) {
      const machine = flyMachineOf(attempt.workerId);
      if (machine === undefined) return note(attempt, 'worker_not_on_fly');
      const app = options.apps[attempt.destination];
      if (app === undefined || !validFlyAppName(app)) return note(attempt, 'app_not_configured');
      const signal = AbortSignal.timeout(timeoutMs);
      // A fake or a runtime that ignores the signal still times out: every await races the abort.
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
      aborted.catch(() => undefined);
      try {
        const response = await Promise.race([
          send(`${base}/v1/apps/${app}/machines/${machine}`, {
            method: 'GET',
            headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
            redirect: 'manual',
            signal,
          }),
          aborted,
        ]);
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return note(attempt, `status_${response.status}`);
        }
        const body: unknown = await Promise.race([response.json(), aborted]);
        if (typeof body !== 'object' || body === null) return note(attempt, 'not_a_machine');
        const { id, state } = body as { id?: unknown; state?: unknown };
        if (id !== machine) return note(attempt, 'another_machine');
        if (typeof state === 'string' && TERMINATED_STATES.has(state)) return { terminated: true };
        return note(
          attempt,
          typeof state === 'string' && /^[a-z_]{1,32}$/.test(state) ? `state_${state}` : 'state_unknown',
        );
      } catch (error) {
        return note(attempt, signal.aborted ? 'timeout' : error instanceof Error ? error.name : 'error');
      }
    },
  };
}
