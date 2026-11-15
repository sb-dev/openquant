// Exact decimal arithmetic (src/domain/decimal.ts). Expected values are worked by hand from the definition of each
// operation, not taken from the code under test. Money is never computed with floating point.

import { describe, expect, it } from 'vitest';
import {
  addDecimal,
  ceilToScale,
  compareDecimal,
  fitsMoney,
  formatDecimal,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
  wholeNumber,
} from '../src/domain/decimal.ts';

describe('parseDecimal', () => {
  it('reads units and scale', () => {
    expect(parseDecimal('105.00')).toEqual({ units: 10500n, scale: 2 });
    expect(parseDecimal('-0.5')).toEqual({ units: -5n, scale: 1 });
    expect(parseDecimal('7')).toEqual({ units: 7n, scale: 0 });
    expect(parseDecimal('0.00000001')).toEqual({ units: 1n, scale: 8 });
  });

  it('refuses what is not a plain decimal', () => {
    for (const text of ['', '1e3', '+1', '01', '1.', '.5', ' 1', '1,5', 'NaN', '0x10', '--1']) {
      expect(() => parseDecimal(text), text).toThrow(RangeError);
    }
  });
});

describe('comparison and sums stay exact where floating point does not', () => {
  it('adds 0.1 and 0.2 to exactly 0.3, and compares them equal', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(compareDecimal(addDecimal('0.1', '0.2'), '0.3')).toBe(0);
    // 0.1 + 0.2 === 0.3 is false in floating point; that is the reason for this module.
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });

  it('compares values of different scales by value', () => {
    expect(compareDecimal('105', '105.00')).toBe(0);
    expect(compareDecimal('5.00', '4.99999999')).toBe(1);
    expect(compareDecimal('-1', '0')).toBe(-1);
    expect(compareDecimal('9999999999999999.99999999', '9999999999999999.99999998')).toBe(1);
  });

  it('subtracts to the larger scale and keeps it', () => {
    expect(subtractDecimal('105.00', '30.00')).toBe('75.00');
    expect(subtractDecimal('10.00000000', '3.5')).toBe('6.50000000');
    expect(subtractDecimal('3', '5')).toBe('-2');
  });

  it('adds up the pilot allowances: 2 x 30.00 + 45.00 = 105.00', () => {
    expect(addDecimal(addDecimal('0', '30.00'), '30.00')).toBe('60.00');
    expect(addDecimal('60.00', '45.00')).toBe('105.00');
  });
});

describe('multiplication of cost parameters (cost stress)', () => {
  it('multiplies by the stress multiplier and keeps the declared scale of the base', () => {
    expect(multiplyDecimal('5', '2')).toBe('10');
    expect(multiplyDecimal('10', '2')).toBe('20');
    // 0.00 x 2 is 0.00: the base declared two fractional digits.
    expect(multiplyDecimal('0.00', '2')).toBe('0.00');
    expect(multiplyDecimal('5', '1.5')).toBe('7.5');
    expect(multiplyDecimal('0.25', '1.5')).toBe('0.375');
    expect(multiplyDecimal('2.50', '2')).toBe('5.00');
  });
});

describe('rounding spend up', () => {
  it('never rounds spend down: the ledger may over-count by less than 1e-8, never under-count', () => {
    expect(ceilToScale('0.123456781', 8)).toBe('0.12345679');
    expect(ceilToScale('0.123456780', 8)).toBe('0.12345678');
    expect(ceilToScale('0.000000001', 8)).toBe('0.00000001');
    expect(ceilToScale('5', 8)).toBe('5.00000000');
    expect(ceilToScale('2.50', 8)).toBe('2.50000000');
    expect(ceilToScale('1.00000000000000000000000001', 8)).toBe('1.00000001');
  });
});

describe('what the ledger can hold', () => {
  it('accepts amounts of at most eight fractional digits and sixteen integer digits', () => {
    expect(fitsMoney('0')).toBe(true);
    expect(fitsMoney('9999999999999999.99999999')).toBe(true);
    expect(fitsMoney('0.12345678')).toBe(true);
    expect(fitsMoney('0.123456789')).toBe(false);
    expect(fitsMoney('10000000000000000')).toBe(false);
    expect(fitsMoney('-1')).toBe(false);
    expect(fitsMoney('abc')).toBe(false);
  });

  it('formats without losing or inventing digits', () => {
    expect(formatDecimal({ units: 1050n, scale: 2 })).toBe('10.5');
    expect(formatDecimal({ units: 1050n, scale: 2 }, 2)).toBe('10.50');
    expect(formatDecimal({ units: 5n, scale: 3 })).toBe('0.005');
    expect(formatDecimal({ units: -5n, scale: 3 })).toBe('-0.005');
    expect(formatDecimal({ units: 0n, scale: 4 })).toBe('0');
  });

  it('reads a whole number and refuses a fraction or an unsafe value', () => {
    expect(wholeNumber('60')).toBe(60);
    expect(wholeNumber('7.9')).toBe(7);
    expect(() => wholeNumber('9007199254740993')).toThrow(RangeError);
  });
});
