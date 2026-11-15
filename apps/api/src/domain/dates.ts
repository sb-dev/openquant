// Calendar dates (YYYY-MM-DD) as the contracts write them. A schema pattern accepts 2026-02-31; the database does not.

export function isCalendarDate(text: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/** The UTC calendar date of an instant. */
export function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
