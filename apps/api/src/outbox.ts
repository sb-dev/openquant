// The outbox dispatcher (OQ-05 section 4, "Outbox PENDING: Dispatcher send"). The attempt, its reservation and its outbox
// entry were written in one transaction; this sends the entry: a job-dispatch/1 message to the batch queue, an
// agent-dispatch/1 message to the agent runner. A failed send leaves the entry PENDING, and the next pass sends it
// again under the same attempt ID: a message that is delivered twice is harmless, because only the first claim of an
// attempt succeeds and a redelivery cannot authorise a second official result.
//
// The queue and the runner are interfaces, so a test supplies fakes and the Worker supplies the Cloudflare Queue
// producer binding and an authenticated HTTPS call. With research execution off nothing is sent.

import type { Database } from './db/database.ts';
import { markOutboxSent } from './domain/attempts.ts';
import { assertTransition } from './domain/transitions.ts';
import type { ApiEnv } from './env.ts';

export interface BatchQueue {
  /** Publish one job-dispatch/1 message. Rejects when the queue did not accept it. */
  send(message: unknown): Promise<void>;
}

export interface AgentRunnerClient {
  /** Submit one agent-dispatch/1 message to the runner. Rejects when the runner did not accept it. */
  dispatch(message: unknown): Promise<void>;
}

export interface Dispatchers {
  readonly batch?: BatchQueue | undefined;
  readonly runner?: AgentRunnerClient | undefined;
}

export interface DispatchSummary {
  /** Entries delivered and marked SENT. */
  readonly sent: number;
  /** Entries whose send failed: they stay PENDING. */
  readonly failed: number;
  /** Entries whose attempt was already claimed: the message evidently arrived, so they are SENT. */
  readonly delivered: number;
  /** Entries left alone: research execution is off, or no dispatcher is configured for their destination. */
  readonly skipped: number;
}

interface PendingRow {
  attempt_id: string;
  destination: 'BATCH_QUEUE' | 'AGENT_RUNNER';
  message: unknown;
  attempt_status: string;
}

export const DISPATCH_BATCH_SIZE = 50;

export async function dispatchPending(
  env: ApiEnv,
  db: Database,
  dispatchers: Dispatchers,
  limit: number = DISPATCH_BATCH_SIZE,
): Promise<DispatchSummary> {
  let sent = 0;
  let failed = 0;
  let delivered = 0;
  let skipped = 0;
  const pending = await db.query<PendingRow>(
    `SELECT o.attempt_id, o.destination, o.message, a.status AS attempt_status
       FROM outbox o JOIN attempts a ON a.attempt_id = o.attempt_id
      WHERE o.status = 'PENDING' ORDER BY o.created_at, o.attempt_id LIMIT $1`,
    [limit],
  );
  for (const entry of pending.rows) {
    if (entry.attempt_status !== 'PENDING') {
      // A worker claimed the attempt before the dispatcher marked the entry: the message was delivered.
      await db.transaction(async (tx) => {
        assertTransition('outbox', 'PENDING', 'SENT');
        await tx.query(`UPDATE outbox SET status = 'SENT', sent_at = $2 WHERE attempt_id = $1 AND status = 'PENDING'`, [
          entry.attempt_id,
          env.clock(),
        ]);
      });
      delivered += 1;
      continue;
    }
    const target = entry.destination === 'BATCH_QUEUE' ? dispatchers.batch : dispatchers.runner;
    if (!env.researchExecution || target === undefined) {
      skipped += 1;
      continue;
    }
    try {
      if (entry.destination === 'BATCH_QUEUE') await (target as BatchQueue).send(entry.message);
      else await (target as AgentRunnerClient).dispatch(entry.message);
    } catch (error) {
      failed += 1;
      env.log({
        level: 'warn',
        message: 'outbox send failed: the entry stays PENDING and is sent again',
        attempt_id: entry.attempt_id,
        destination: entry.destination,
        error: error instanceof Error ? error.name : 'unknown',
      });
      continue;
    }
    // The message is out. If marking it fails, the entry stays PENDING and the same message goes again.
    const marked = await db.transaction((tx) => markOutboxSent(tx, env, entry.attempt_id));
    if (marked === 'SENT' || marked === 'ALREADY_SENT') sent += 1;
    else delivered += 1;
  }
  return { sent, failed, delivered, skipped };
}

/**
 * The authenticated HTTPS call to the agent runner (OQ-05 section 4: ResearchWorkflow submits an existing attempt ID to
 * the Fly agent runner). It sends the message with the credential of the workflows service principal and accepts any 2xx
 * answer; the runner claims the attempt through the API before it starts the tool. Only HTTPS is allowed, and the
 * request follows no redirect, so the credential never travels to another host.
 */
export function createAgentRunnerClient(
  baseUrl: string,
  credential: string,
  fetcher: (request: Request) => Promise<Response> = (request) => fetch(request),
): AgentRunnerClient {
  const url = new URL('/v1/agent-attempts', baseUrl);
  if (url.protocol !== 'https:') throw new Error('The agent runner is reached over HTTPS only.');
  return {
    async dispatch(message) {
      const response = await fetcher(
        new Request(url, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
          body: JSON.stringify(message),
        }),
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`The agent runner answered ${response.status}.`);
      }
    },
  };
}
