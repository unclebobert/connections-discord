import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ProgressRoom } from '../src/session';
import {
  attachmentFor,
  progressRoom,
  DATE,
  CHANNEL_ID,
  SCOPE_ID,
  resetUsage,
  rowsWritten,
  rowsWrittenForPrefix,
} from './helpers';

/**
 * These lock in the write costs measured against workerd during the quota work:
 * inserting a new key costs 2 rows (the row plus its primary-key autoindex entry),
 * updating only non-indexed columns costs 1, and re-running CREATE TABLE IF NOT
 * EXISTS costs nothing. Durable Object rows written sat at ~90% of the daily free
 * limit, so a change that quietly reintroduces a per-guess write needs to fail here
 * rather than on the usage meter.
 */

describe('launch tokens', () => {
  it('costs 2 rows to insert and 1 row to update', async () => {
    await runInDurableObject(progressRoom('guild:tokens'), (instance: ProgressRoom) => {
      resetUsage(instance);
      instance.saveLatestActivityLaunchToken(SCOPE_ID, CHANNEL_ID, 'token-1');
      expect(rowsWritten(instance)).toBe(2);

      resetUsage(instance);
      instance.saveLatestActivityLaunchToken(SCOPE_ID, CHANNEL_ID, 'token-2');
      // interaction_token and token_expires_at are not indexed, so the autoindex is
      // untouched. This is why WITHOUT ROWID was not worth migrating to.
      expect(rowsWritten(instance)).toBe(1);
    });
  });
});

describe('schema setup', () => {
  it('writes nothing when the tables already exist', async () => {
    const stub = progressRoom('guild:schema');
    await runInDurableObject(stub, (instance: ProgressRoom) => {
      expect(rowsWrittenForPrefix(instance, 'schema:')).toBeGreaterThan(0);
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, (instance: ProgressRoom) => {
      // The constructor re-runs on every wake from hibernation. If this ever stops
      // being free it becomes a per-wake tax that no other metric would surface.
      expect(rowsWrittenForPrefix(instance, 'schema:')).toBe(0);
    });
  });
});

describe('profiles', () => {
  it('skips the write when nothing about the profile changed', async () => {
    await runInDurableObject(progressRoom('guild:profiles'), (instance: ProgressRoom) => {
      resetUsage(instance);
      instance.saveProfile('u1', { displayName: 'Ada', avatarUrl: null });
      expect(rowsWritten(instance)).toBe(2);

      resetUsage(instance);
      instance.saveProfile('u1', { displayName: 'Ada', avatarUrl: null });
      expect(rowsWritten(instance)).toBe(0);

      resetUsage(instance);
      instance.saveProfile('u1', { displayName: 'Ada Lovelace', avatarUrl: null });
      expect(rowsWritten(instance)).toBe(1);

      resetUsage(instance);
      instance.saveProfile('u1', { displayName: 'Ada Lovelace', avatarUrl: 'https://cdn/a.png' });
      expect(rowsWritten(instance)).toBe(1);
    });
  });
});

describe('guesses', () => {
  it('writes one row per new guess and nothing for a duplicate', async () => {
    await runInDurableObject(progressRoom('guild:guesses'), (instance: ProgressRoom) => {
      const attachment = attachmentFor('u1');
      instance.ensurePlayerProgress('u1', DATE);

      resetUsage(instance);
      const first = instance.saveGuess(attachment, [0, 5, 10, 15]);
      expect(first.wasSaved).toBe(true);
      expect(rowsWritten(instance)).toBe(1);

      resetUsage(instance);
      // Same four cards, selected in a different order.
      const repeat = instance.saveGuess(attachment, [15, 10, 5, 0]);
      expect(repeat.wasSaved).toBe(false);
      expect(repeat.progress).toHaveLength(1);
      expect(rowsWritten(instance)).toBe(0);
    });
  });

  it('keeps a whole session inside its row budget', async () => {
    await runInDurableObject(progressRoom('guild:session'), (instance: ProgressRoom) => {
      const attachment = attachmentFor('u1');

      resetUsage(instance);
      // What one player joining and playing out a full game costs.
      instance.saveProfile('u1', { displayName: 'Ada', avatarUrl: null });
      instance.ensurePlayerProgress('u1', DATE);
      for (let guess = 0; guess < 6; guess += 1) {
        instance.saveGuess(attachment, [guess * 4, guess * 4 + 1, guess * 4 + 2, guess * 4 + 3]);
      }

      // 2 (profile insert) + 2 (progress insert) + 6 (one per guess).
      expect(rowsWritten(instance)).toBe(10);
    });
  });
});
