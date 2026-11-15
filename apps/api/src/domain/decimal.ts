// Exact decimal arithmetic on the plain decimal strings of the contracts (Decimal in common.schema.json). Money,
// budgets and cost multipliers are never computed with floating point: a value is a BigInt of units and a scale.
// The database holds amounts as numeric(24, 8), so an amount that has more than eight fractional digits is rounded up
// (never down) when it is stored as spend: the ledger may over-count by less than 10^-8, never under-count.

const PLAIN = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** The scale of the database amount columns: numeric(24, 8). */
export const MONEY_SCALE = 8;
/** The integer digits of numeric(24, 8). */
export const MONEY_INTEGER_DIGITS = 16;

export interface Dec {
  /** value = units / 10^scale */
  readonly units: bigint;
  readonly scale: number;
}

/** Parse a plain decimal such as `105.00`, `-0.5` or `3`. Throws RangeError for anything else. */
export function parseDecimal(text: string): Dec {
  const match = PLAIN.exec(text);
  if (match === null) throw new RangeError('Not a plain decimal.');
  const fraction = match[3] ?? '';
  const units = BigInt(`${match[2]}${fraction}`) * (match[1] === '-' ? -1n : 1n);
  return { units, scale: fraction.length };
}

function rescale(value: Dec, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

export function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `value` with trailing fractional zeros removed, but never fewer than `minScale` fractional digits. */
export function formatDecimal(value: Dec, minScale = 0): string {
  let { units, scale } = value;
  while (scale > minScale && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export function addDecimal(left: string, right: string): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  return formatDecimal({ units: rescale(a, scale) + rescale(b, scale), scale }, scale);
}

export function subtractDecimal(left: string, right: string): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  return formatDecimal({ units: rescale(a, scale) - rescale(b, scale), scale }, scale);
}

/** The exact product. Trailing zeros are removed down to the scale of `base`, so `0.00 * 2` stays `0.00`. */
export function multiplyDecimal(base: string, factor: string): string {
  const a = parseDecimal(base);
  const b = parseDecimal(factor);
  return formatDecimal({ units: a.units * b.units, scale: a.scale + b.scale }, a.scale);
}

/** The smallest multiple of 10^-scale that is at least `value`. Used for spend, which must never be under-counted. */
export function ceilToScale(text: string, scale: number): string {
  const value = parseDecimal(text);
  if (value.scale <= scale) return formatDecimal({ units: rescale(value, scale), scale }, scale);
  const divisor = 10n ** BigInt(value.scale - scale);
  let quotient = value.units / divisor;
  if (value.units % divisor !== 0n && value.units > 0n) quotient += 1n;
  return formatDecimal({ units: quotient, scale }, scale);
}

/** Whether a non-negative amount fits numeric(24, 8) exactly: at most eight fractional digits, 16 integer digits. */
export function fitsMoney(text: string): boolean {
  let value: Dec;
  try {
    value = parseDecimal(text);
  } catch {
    return false;
  }
  if (value.units < 0n || value.scale > MONEY_SCALE) return false;
  return value.units.toString().length - value.scale <= MONEY_INTEGER_DIGITS;
}

/** Whether `text` is a whole number, as a database integer count would hold it. */
export function isWhole(text: string): boolean {
  const value = parseDecimal(text);
  return value.units % 10n ** BigInt(value.scale) === 0n;
}

/** The whole-number part of a non-negative decimal, as a JavaScript number. Throws when it is not a safe integer. */
export function wholeNumber(text: string): number {
  const value = parseDecimal(text);
  const whole = value.units / 10n ** BigInt(value.scale);
  if (whole > BigInt(Number.MAX_SAFE_INTEGER) || whole < 0n) throw new RangeError('Not a safe whole number.');
  return Number(whole);
}
