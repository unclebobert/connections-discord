import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.ts';
import type { ProgressRoom } from '../src/session.ts';
import { attachmentFor, callsFor, changesFor, createRoom, createTestDatabase, DATE, resetUsage } from './helpers.ts';

/**
 * These were row-count invariants when Durable Objects billed per row written. SQLite
 * writes are free here, so the exact counts no longer matter — but the behaviour they
 * were protecting still does: a duplicate guess must not be recorded, and a reconnect
 * must not rewrite an unchanged profile.
 */

let db: Database;
let room: ProgressRoom;

beforeEach(() => {
  db = createTestDatabase();
  room = createRoom(db);
});

describe('guesses', () => {
  it('records a new guess and rejects a duplicate regardless of card order', () => {
    const attachment = attachmentFor('u1');
    room.ensurePlayerProgress('u1', DATE);

    resetUsage(room);
    const first = room.saveGuess(attachment, [0, 5, 10, 15]);
    expect(first.wasSaved).toBe(true);
    expect(first.progress).toHaveLength(1);
    expect(changesFor(room, 'progress:save_guess')).toBe(1);

    resetUsage(room);
    const repeat = room.saveGuess(attachment, [15, 10, 5, 0]);
    expect(repeat.wasSaved).toBe(false);
    expect(repeat.progress).toHaveLength(1);
    expect(callsFor(room, 'progress:save_guess')).toBe(0);
  });

  it('accumulates distinct guesses in order', () => {
    const attachment = attachmentFor('u1');
    room.ensurePlayerProgress('u1', DATE);

    room.saveGuess(attachment, [0, 1, 2, 3]);
    room.saveGuess(attachment, [4, 5, 6, 7]);

    expect(room.getDateProgress(DATE)).toEqual([['u1', [[0, 1, 2, 3], [4, 5, 6, 7]]]]);
  });
});

describe('profiles', () => {
  it('writes once and skips while nothing has changed', () => {
    resetUsage(room);
    room.saveProfile('u1', { displayName: 'Ada', avatarUrl: null });
    expect(callsFor(room, 'profiles:save')).toBe(1);

    resetUsage(room);
    room.saveProfile('u1', { displayName: 'Ada', avatarUrl: null });
    expect(callsFor(room, 'profiles:save')).toBe(0);

    resetUsage(room);
    room.saveProfile('u1', { displayName: 'Ada Lovelace', avatarUrl: null });
    expect(callsFor(room, 'profiles:save')).toBe(1);

    resetUsage(room);
    room.saveProfile('u1', { displayName: 'Ada Lovelace', avatarUrl: 'https://cdn/a.png' });
    expect(callsFor(room, 'profiles:save')).toBe(1);
  });

  it('recognises a profile written by another room in the same process', () => {
    // Profiles are global now. They used to be duplicated per guild because every
    // Durable Object had its own database.
    room.saveProfile('u1', { displayName: 'Ada', avatarUrl: null });

    const otherGuild = createRoom(db, 'guild:999999999999999999');
    resetUsage(otherGuild);
    otherGuild.saveProfile('u1', { displayName: 'Ada', avatarUrl: null });

    expect(callsFor(otherGuild, 'profiles:save')).toBe(0);
  });
});

describe('scope isolation', () => {
  it('keeps progress in one guild invisible to another', () => {
    room.ensurePlayerProgress('u1', DATE);
    room.saveGuess(attachmentFor('u1'), [0, 1, 2, 3]);

    // A single shared database replaced per-guild Durable Object storage, so this is
    // now enforced by the scope_id column rather than by the platform.
    const otherGuild = createRoom(db, 'guild:999999999999999999');

    expect(otherGuild.getDateProgress(DATE)).toEqual([]);
    expect(room.getDateProgress(DATE)).toHaveLength(1);
  });
});

describe('surviving a restart', () => {
  it('reloads progress written before the process stopped', () => {
    room.ensurePlayerProgress('u1', DATE);
    room.saveGuess(attachmentFor('u1'), [0, 1, 2, 3]);
    room.saveProfile('u1', { displayName: 'Ada', avatarUrl: null });

    // In-memory state is lost on restart; the database is not.
    const restarted = createRoom(db);

    expect(restarted.getDateProgress(DATE)).toEqual([['u1', [[0, 1, 2, 3]]]]);
    expect(restarted.getActivityMessagePlayers(DATE, {
      categories: [{ cards: [{ position: 0 }, { position: 1 }, { position: 2 }, { position: 3 }] }],
    })).toEqual([
      { userId: 'u1', displayName: 'Ada', correctGuesses: 1, progressCells: [0] },
    ]);
  });
});
