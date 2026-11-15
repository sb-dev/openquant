// Small text and hash helpers of the runner: digests, UTC timestamps, bounded diagnostics and redaction.

import { createHash } from 'node:crypto';

/** `sha256:<hex>` of raw bytes. */
export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The UTC instant with second precision that `UtcTimestamp` requires: `YYYY-MM-DDTHH:MM:SSZ`. */
export function utcTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The longest `AgentDiagnostic` of agent-attempt-result/1, in characters. */
export const DIAGNOSTIC_LIMIT = 2000;

// Credential shapes that never belong in a diagnostic, whatever their source.
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S{6,}/gi,
];

/**
 * A bounded, printable, single-purpose diagnostic: every secret value and credential shape is replaced, control
 * characters become spaces, and the text is cut to the schema limit. It never carries the full output of the
 * executor (OQ-03 section 5: a bounded diagnostic without credentials or full sensitive context).
 */
export function diagnostic(text: string, secrets: readonly string[] = [], limit = DIAGNOSTIC_LIMIT): string {
  let clean = text;
  // Longest secrets first, so a secret that contains another one is replaced whole.
  for (const secret of [...secrets].filter((value) => value.length >= 6).sort((a, b) => b.length - a.length)) {
    clean = clean.split(secret).join('[redacted]');
  }
  for (const shape of CREDENTIAL_SHAPES) clean = clean.replace(shape, '[redacted]');
  clean = Array.from(clean, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) ? ' ' : character;
  }).join('');
  clean = clean.replace(/ {2,}/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 3)}...`;
}

/** A decimal string without an exponent for a non-negative finite number, as the `Decimal` pattern requires. */
export function decimalString(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0 || value > 1e9) return undefined;
  const fixed = value.toFixed(10);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '' ? '0' : trimmed;
}
