import { describe, expect, it } from 'vitest';
import {
  getGuildIdFromActivityScope,
  isActivityScopeId,
  isDiscordSnowflake,
  isPuzzleDateTooFarFromToday,
} from '../src/connections.ts';
import { areSameGuess, getGuessKey, isPlayerGuess } from '../src/session.ts';
import { isValidPuzzleDate } from '../src/puzzles.ts';

// These guard the only inputs a client controls directly: the WebSocket URL path and
// the guess payload.

describe('isDiscordSnowflake', () => {
  it.each([
    ['123456789012', true],
    ['1'.repeat(24), true],
    ['12345678901', false],
    ['1'.repeat(25), false],
    ['12345678901a', false],
    ['', false],
    ['-123456789012', false],
  ])('%s -> %s', (value, expected) => {
    expect(isDiscordSnowflake(value)).toBe(expected);
  });
});

describe('isActivityScopeId', () => {
  it.each([
    ['guild:123456789012', true],
    ['dm:123456789012', true],
    ['guild:abc', false],
    ['other:123456789012', false],
    ['guild', false],
    ['guild:123456789012:extra', false],
    ['guild:', false],
  ])('%s -> %s', (value, expected) => {
    expect(isActivityScopeId(value)).toBe(expected);
  });
});

describe('getGuildIdFromActivityScope', () => {
  it('extracts a guild id and returns null for a DM scope', () => {
    expect(getGuildIdFromActivityScope('guild:123456789012')).toBe('123456789012');
    expect(getGuildIdFromActivityScope('dm:123456789012')).toBeNull();
  });
});

describe('isValidPuzzleDate', () => {
  it.each([
    ['2026-08-20', true],
    ['2026-8-20', false],
    ['20260820', false],
    ['not-a-date', false],
    ['', false],
  ])('%s -> %s', (value, expected) => {
    expect(isValidPuzzleDate(value)).toBe(expected);
  });
});

describe('isPuzzleDateTooFarFromToday', () => {
  const isoDaysFromNow = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  it('accepts dates near today and rejects distant ones', () => {
    expect(isPuzzleDateTooFarFromToday(isoDaysFromNow(0))).toBe(false);
    expect(isPuzzleDateTooFarFromToday(isoDaysFromNow(2))).toBe(false);
    expect(isPuzzleDateTooFarFromToday(isoDaysFromNow(-2))).toBe(false);
    expect(isPuzzleDateTooFarFromToday(isoDaysFromNow(10))).toBe(true);
    expect(isPuzzleDateTooFarFromToday(isoDaysFromNow(-10))).toBe(true);
  });
});

describe('isPlayerGuess', () => {
  it.each([
    [[0, 1, 2, 3], true],
    [[0, 1, 2], false],
    [[0, 1, 2, 3, 4], false],
    [[0, 1, 2, 3.5], false],
    [[0, 1, 2, '3'], false],
    ['0,1,2,3', false],
    [null, false],
    [undefined, false],
    [{}, false],
  ])('%j -> %s', (value, expected) => {
    expect(isPlayerGuess(value)).toBe(expected);
  });
});

describe('guess identity', () => {
  it('ignores the order cards were selected in', () => {
    expect(areSameGuess([0, 1, 2, 3], [3, 2, 1, 0])).toBe(true);
    expect(areSameGuess([0, 1, 2, 3], [0, 1, 2, 4])).toBe(false);
    expect(getGuessKey([3, 2, 1, 0])).toBe(getGuessKey([0, 1, 2, 3]));
  });

  it('does not confuse positions that share digits', () => {
    // A naive string key would collide 1,12 with 11,2.
    expect(areSameGuess([1, 12, 3, 4], [11, 2, 3, 4])).toBe(false);
  });
});
