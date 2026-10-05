import { expect, test } from '@playwright/test';
import { parseRange } from '../../server/src/lib/byte-range';

test.describe('parseRange', () => {
  const size = 1000;

  test('serves the whole file without a usable header', () => {
    expect(parseRange(undefined, size)).toBeNull();
    expect(parseRange('bytes=-', size)).toBeNull();
    expect(parseRange('bytes=0-9,20-29', size)).toBeNull();
    expect(parseRange('items=0-9', size)).toBeNull();
  });

  test('parses closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', size)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', size)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', size)).toEqual({ start: 900, end: 999 });
  });

  test('clamps ranges that run past the end', () => {
    expect(parseRange('bytes=990-5000', size)).toEqual({
      start: 990,
      end: 999,
    });
    expect(parseRange('bytes=-5000', size)).toEqual({ start: 0, end: 999 });
  });

  test('rejects ranges outside the file', () => {
    expect(parseRange('bytes=1000-', size)).toBe('unsatisfiable');
    expect(parseRange('bytes=50-10', size)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', size)).toBe('unsatisfiable');
  });
});
