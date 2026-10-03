import { describe, it, expect } from 'vitest';
import {
  SAFE_IDENTIFIER_PATTERN,
  describeRejectedValue,
  isPositiveSafeInteger,
  isSafeIdentifier,
} from './identifier.js';

describe('isSafeIdentifier', () => {
  it.each(['name', '_private', 'HAS_COMPONENT', 'startDate2', 'a', '_'])(
    'accepts %s',
    (value) => {
      expect(isSafeIdentifier(value)).toBe(true);
    },
  );

  it.each([
    '',
    'start-date',
    'first name',
    '2fast',
    'a.b',
    'name`',
    'café',
    'id IS NOT NULL OR true OR n0.id',
    'KNOWS]-() WITH 1 AS x MATCH (m:_Entity) RETURN m //',
    'name\n',
  ])('rejects %j', (value) => {
    expect(isSafeIdentifier(value)).toBe(false);
  });

  it('rejects non-string values that RegExp.test would coerce', () => {
    // Simulates untyped input (e.g. parsed JSON) reaching a string-typed API.
    const asString = (value: string | string[] | number | undefined): string => value as string;
    expect(isSafeIdentifier(asString(['name']))).toBe(false);
    expect(isSafeIdentifier(asString(42))).toBe(false);
    expect(isSafeIdentifier(asString(undefined))).toBe(false);
  });

  it('exposes the pattern source for error messages', () => {
    expect(SAFE_IDENTIFIER_PATTERN.source).toBe('^[A-Za-z_][A-Za-z0-9_]*$');
  });

  it('is not weakened by mutating the exported pattern', () => {
    const exported = SAFE_IDENTIFIER_PATTERN as RegExp & { compile(pattern: string): RegExp };
    const original = exported.source;
    try {
      exported.compile('.*');
      expect(isSafeIdentifier('start-date')).toBe(false);
    } finally {
      exported.compile(original);
    }
  });
});

describe('isPositiveSafeInteger', () => {
  it('accepts positive safe integers only', () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '3', null]) {
      expect(isPositiveSafeInteger(value)).toBe(false);
    }
  });
});

describe('describeRejectedValue', () => {
  it('JSON-quotes short strings', () => {
    expect(describeRejectedValue('a"b\n')).toBe('"a\\"b\\n"');
  });

  it('truncates long strings and records the original length', () => {
    const described = describeRejectedValue('x'.repeat(150));
    expect(described).toBe(`"${'x'.repeat(100)}"… (150 characters)`);
  });

  it('prints primitives as-is', () => {
    expect(describeRejectedValue(42)).toBe('42');
    expect(describeRejectedValue(Number.NaN)).toBe('NaN');
    expect(describeRejectedValue(true)).toBe('true');
    expect(describeRejectedValue(null)).toBe('null');
    expect(describeRejectedValue(undefined)).toBe('undefined');
  });

  it('names other values by type only, never by content', () => {
    expect(describeRejectedValue(['secret'])).toBe('an array');
    expect(describeRejectedValue({ toString: () => 'secret' })).toBe('a value of type object');
    expect(describeRejectedValue(10n)).toBe('a value of type bigint');
  });
});
