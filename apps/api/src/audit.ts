// Audit events (OQ-02 section 8: each consequential domain change and its audit event persist together). Pass the
// transaction of the change as `tx`, so the event commits or rolls back with it. Never put a credential, a token or
// a request body in `detail`.

import type { Queryable } from './db/database.ts';

export interface AuditEvent {
  /** Lower-case dotted name, such as `auth.token_issued`. */
  readonly eventType: string;
  /** The principal who acted, or `system`. */
  readonly actor: string;
  readonly subject: string;
  readonly commandId?: string;
  readonly diagnosticRef?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export async function writeAudit(tx: Queryable, now: Date, event: AuditEvent): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (occurred_at, actor, event_type, subject, command_id, diagnostic_ref, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      now,
      event.actor,
      event.eventType,
      event.subject,
      event.commandId ?? null,
      event.diagnosticRef ?? null,
      JSON.stringify(event.detail ?? {}),
    ],
  );
}
