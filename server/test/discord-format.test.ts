import { describe, expect, it } from 'vitest';
import {
  createActivityMessagePayload,
  formatPlayerList,
  formatPlayerNameForRow,
  formatProgressCells,
  formatProgressRow,
  hexToBytes,
} from '../src/discord.ts';

const player = (overrides: Partial<{ displayName: string; correctGuesses: number; progressCells: Array<number | null> }> = {}) => ({
  userId: 'u1',
  displayName: 'Ada',
  correctGuesses: 0,
  progressCells: [] as Array<number | null>,
  ...overrides,
});

describe('formatProgressCells', () => {
  it('shows four blanks before anything has been guessed', () => {
    expect(formatProgressCells(player())).toBe('⬜⬜⬜⬜');
  });

  it('renders solved categories in their own colour', () => {
    expect(formatProgressCells(player({ progressCells: [0], correctGuesses: 1 }))).toBe('🟨⬜⬜⬜');
    expect(formatProgressCells(player({ progressCells: [3], correctGuesses: 1 }))).toBe('🟪⬜⬜⬜');
  });

  it('grows the row by one cell for each mistake', () => {
    expect(formatProgressCells(player({ progressCells: [null] }))).toBe('⬛⬜⬜⬜⬜');
    expect(formatProgressCells(player({ progressCells: [null, null] }))).toBe('⬛⬛⬜⬜⬜⬜');
  });

  it('never grows past seven cells', () => {
    const cells = [null, 0, null, 1, null, 2, 3] as Array<number | null>;

    expect([...formatProgressCells(player({ progressCells: cells, correctGuesses: 4 }))].length)
      .toBeLessThanOrEqual(7 * 2);
    expect(formatProgressCells(player({ progressCells: [null, null, null] })))
      .toBe('⬛⬛⬛⬜⬜⬜⬜');
  });

  it('collapses to the exact guesses played once the game is over', () => {
    expect(formatProgressCells(player({ progressCells: [0, 1, 2, 3], correctGuesses: 4 })))
      .toBe('🟨🟩🟦🟪');
    expect(formatProgressCells(player({ progressCells: [null, null, null, null] })))
      .toBe('⬛⬛⬛⬛');
  });
});

describe('formatPlayerNameForRow', () => {
  it('leaves short names alone', () => {
    expect(formatPlayerNameForRow('Ada')).toBe('Ada');
    expect(formatPlayerNameForRow('a'.repeat(13))).toBe('a'.repeat(13));
  });

  it('truncates long names with an ellipsis', () => {
    expect(formatPlayerNameForRow('a'.repeat(14))).toBe(`${'a'.repeat(12)}…`);
  });

  it('strips characters that would break out of the code block', () => {
    // The row is rendered inside a ```text fence, so an unescaped backtick or newline
    // in a display name would escape it and corrupt the whole message.
    expect(formatPlayerNameForRow('a`b')).toBe('a b');
    expect(formatPlayerNameForRow('a\nb')).toBe('a b');
    expect(formatPlayerNameForRow('a\r\nb')).toBe('a b');
    expect(formatPlayerNameForRow('a\\b')).toBe('a b');
    expect(formatPlayerNameForRow('```')).toBe('Someone');
  });

  it('falls back when the name is empty or whitespace', () => {
    expect(formatPlayerNameForRow('')).toBe('Someone');
    expect(formatPlayerNameForRow('   ')).toBe('Someone');
  });
});

describe('formatProgressRow', () => {
  it('pads the name column so the emoji grids line up', () => {
    const row = formatProgressRow(player({ displayName: 'Ada', correctGuesses: 1, progressCells: [0] }));

    expect(row).toBe(`Ada${' '.repeat(11)}🟨⬜⬜⬜ 1/4`);
  });

  it('aligns a truncated name with a short one', () => {
    const short = formatProgressRow(player({ displayName: 'Ada' }));
    const long = formatProgressRow(player({ displayName: 'a'.repeat(30) }));

    expect(short.indexOf('⬜')).toBe(long.indexOf('⬜'));
  });
});

describe('formatPlayerList', () => {
  it.each([
    [[], 'Someone'],
    [['Ada'], 'Ada'],
    [['Ada', 'Bob'], 'Ada and Bob'],
    [['Ada', 'Bob', 'Cy'], 'Ada, Bob, and Cy'],
  ])('formats %j', (names, expected) => {
    expect(formatPlayerList(names as string[])).toBe(expected);
  });
});

describe('createActivityMessagePayload', () => {
  const state = (players: ReturnType<typeof player>[]) => ({
    scopeId: 'guild:1',
    channelId: 'c1',
    date: '2026-08-20',
    messageId: null,
    interactionToken: null,
    tokenExpiresAt: 0,
    lastUpdatedAt: 0,
    players,
  });

  it('uses singular phrasing and suppresses mentions for one player', () => {
    const payload = createActivityMessagePayload(state([player({ correctGuesses: 1, progressCells: [0] })]));

    expect(payload.content).toBe('Ada was playing Connections\n```text\nAda           🟨⬜⬜⬜ 1/4\n```');
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.components[0].components[0].label).toBe('Play now!');
  });

  it('uses plural phrasing and one row per player', () => {
    const payload = createActivityMessagePayload(
      state([player({ displayName: 'Ada' }), player({ displayName: 'Bob' })]),
    );

    expect(payload.content.startsWith('Ada and Bob were playing Connections')).toBe(true);
    expect(payload.content.split('\n').filter((line) => line.includes('/4'))).toHaveLength(2);
  });
});

describe('hexToBytes', () => {
  it('decodes a hex string', () => {
    expect([...hexToBytes('00ff10')]).toEqual([0, 255, 16]);
  });

  it('rejects malformed input rather than decoding garbage', () => {
    expect(() => hexToBytes('abc')).toThrow();
    expect(() => hexToBytes('zz')).toThrow();
  });
});
