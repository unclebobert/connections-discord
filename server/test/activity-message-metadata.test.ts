import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_MESSAGE_PERSIST_INTERVAL_MS, type ProgressRoom } from '../src/session';
import { MESSAGE_STALE_AFTER_MS } from '../src/discord';
import { CHANNEL_ID, DATE, SCOPE_ID, progressRoom, resetUsage, rowsWritten } from './helpers';

/**
 * activity_message_update was the single largest consumer of rows written (43% of the
 * daily total), because the metadata row was rewritten on every guess even though only
 * last_updated_at had moved. Persisting that column lazily is what removed the cost —
 * at the price of the stored value lagging reality, which these tests bound.
 */

const baseMetadata = (overrides: Partial<{ messageId: string; interactionToken: string; tokenExpiresAt: number; lastUpdatedAt: number }> = {}) => ({
  scopeId: SCOPE_ID,
  channelId: CHANNEL_ID,
  date: DATE,
  messageId: 'message-1',
  interactionToken: 'token-1',
  tokenExpiresAt: 1_000_000,
  lastUpdatedAt: 1_000,
  ...overrides,
});

describe('metadata persistence', () => {
  it('writes on the first save and skips when only lastUpdatedAt moved', async () => {
    await runInDurableObject(progressRoom('guild:meta-skip'), (room: ProgressRoom) => {
      resetUsage(room);
      room.saveActivityMessageMetadata(baseMetadata());
      expect(rowsWritten(room)).toBe(2);

      resetUsage(room);
      room.saveActivityMessageMetadata(baseMetadata({ lastUpdatedAt: 1_000 + 60_000 }));
      expect(rowsWritten(room)).toBe(0);
    });
  });

  it('always writes when the message identity changes', async () => {
    await runInDurableObject(progressRoom('guild:meta-identity'), (room: ProgressRoom) => {
      room.saveActivityMessageMetadata(baseMetadata());

      resetUsage(room);
      room.saveActivityMessageMetadata(baseMetadata({ messageId: 'message-2' }));
      expect(rowsWritten(room)).toBe(1);

      resetUsage(room);
      room.saveActivityMessageMetadata(baseMetadata({ messageId: 'message-2', interactionToken: 'token-2' }));
      expect(rowsWritten(room)).toBe(1);

      resetUsage(room);
      room.saveActivityMessageMetadata(
        baseMetadata({ messageId: 'message-2', interactionToken: 'token-2', tokenExpiresAt: 2_000_000 }),
      );
      expect(rowsWritten(room)).toBe(1);
    });
  });

  it('writes again once the persist interval has elapsed', async () => {
    await runInDurableObject(progressRoom('guild:meta-interval'), (room: ProgressRoom) => {
      room.saveActivityMessageMetadata(baseMetadata());

      resetUsage(room);
      room.saveActivityMessageMetadata(
        baseMetadata({ lastUpdatedAt: 1_000 + ACTIVITY_MESSAGE_PERSIST_INTERVAL_MS }),
      );
      expect(rowsWritten(room)).toBe(1);
    });
  });

  it('serves the in-memory value while the object is alive', async () => {
    await runInDurableObject(progressRoom('guild:meta-warm'), (room: ProgressRoom) => {
      room.saveActivityMessageMetadata(baseMetadata());
      room.saveActivityMessageMetadata(baseMetadata({ lastUpdatedAt: 61_000 }));

      // Not persisted, but reads must still see it or the object would act on a
      // staler timestamp than it actually knows about.
      expect(room.getActivityMessageMetadata(SCOPE_ID, CHANNEL_ID, DATE)?.lastUpdatedAt).toBe(61_000);
    });
  });
});

describe('surviving hibernation', () => {
  it('restores metadata that lags by no more than the persist interval', async () => {
    const stub = progressRoom('guild:meta-evict');
    const start = 5_000_000;
    const latest = start + 5 * 60_000;

    await runInDurableObject(stub, (room: ProgressRoom) => {
      room.saveActivityMessageMetadata(baseMetadata({ lastUpdatedAt: start }));
      // Five updates that all skip the write.
      for (let minute = 1; minute <= 5; minute += 1) {
        room.saveActivityMessageMetadata(baseMetadata({ lastUpdatedAt: start + minute * 60_000 }));
      }
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, (room: ProgressRoom) => {
      const restored = room.getActivityMessageMetadata(SCOPE_ID, CHANNEL_ID, DATE);

      expect(restored).not.toBeNull();
      expect(restored!.messageId).toBe('message-1');
      expect(restored!.interactionToken).toBe('token-1');
      expect(latest - restored!.lastUpdatedAt).toBeLessThanOrEqual(ACTIVITY_MESSAGE_PERSIST_INTERVAL_MS);
    });
  });

  it('cannot lag far enough to make a live message look stale', () => {
    // sendActivityLaunchMessage refuses to edit a message older than
    // MESSAGE_STALE_AFTER_MS and posts a fresh one instead. If the persist interval
    // ever grew past that window, lazy persistence would start spamming the channel
    // with duplicate "Play now!" messages after a hibernation.
    expect(ACTIVITY_MESSAGE_PERSIST_INTERVAL_MS).toBeLessThan(MESSAGE_STALE_AFTER_MS);
  });
});
