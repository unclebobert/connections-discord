import { beforeEach, describe, expect, it } from 'vitest';
import { MESSAGE_STALE_AFTER_MS } from '../src/discord.ts';
import type { Database } from '../src/db.ts';
import type { ProgressRoom } from '../src/session.ts';
import { CHANNEL_ID, DATE, SCOPE_ID, callsFor, createRoom, createTestDatabase, resetUsage } from './helpers.ts';

/**
 * The Durable Object version persisted `last_updated_at` lazily to save billed row
 * writes, which let the stored timestamp fall behind reality across an eviction. That
 * scheme is gone; these tests pin the behaviour that replaced it — every update is
 * durable immediately, and a restart sees exactly what was written.
 */

let db: Database;
let room: ProgressRoom;

const metadata = (overrides: Partial<{ messageId: string; interactionToken: string; tokenExpiresAt: number; lastUpdatedAt: number }> = {}) => ({
  scopeId: SCOPE_ID,
  channelId: CHANNEL_ID,
  date: DATE,
  messageId: 'message-1',
  interactionToken: 'token-1',
  tokenExpiresAt: 1_000_000,
  lastUpdatedAt: 1_000,
  ...overrides,
});

beforeEach(() => {
  db = createTestDatabase();
  room = createRoom(db);
});

describe('metadata persistence', () => {
  it('has nothing to report before a message exists', () => {
    expect(room.getActivityMessageMetadata(SCOPE_ID, CHANNEL_ID, DATE)).toBeNull();
  });

  it('round-trips through the in-memory cache while the process is alive', () => {
    room.saveActivityMessageMetadata(metadata());
    room.saveActivityMessageMetadata(metadata({ lastUpdatedAt: 61_000 }));

    expect(room.getActivityMessageMetadata(SCOPE_ID, CHANNEL_ID, DATE)?.lastUpdatedAt).toBe(61_000);
  });

  it('persists every update, so a restart loses nothing', () => {
    room.saveActivityMessageMetadata(metadata());
    room.saveActivityMessageMetadata(metadata({ lastUpdatedAt: 61_000 }));

    const restarted = createRoom(db);
    const restored = restarted.getActivityMessageMetadata(SCOPE_ID, CHANNEL_ID, DATE);

    expect(restored).not.toBeNull();
    expect(restored!.messageId).toBe('message-1');
    expect(restored!.interactionToken).toBe('token-1');
    // Exact, not merely within a staleness window — the lag the old scheme allowed is
    // what could make a live message look stale and post a duplicate.
    expect(restored!.lastUpdatedAt).toBe(61_000);
    expect(MESSAGE_STALE_AFTER_MS - (61_000 - restored!.lastUpdatedAt)).toBe(MESSAGE_STALE_AFTER_MS);
  });

  it('reads from storage only once per channel and date', () => {
    room.saveActivityMessageMetadata(metadata());

    const restarted = createRoom(db);
    resetUsage(restarted);
    restarted.getActivityMessageMetadata(SCOPE_ID, CHANNEL_ID, DATE);
    restarted.getActivityMessageMetadata(SCOPE_ID, CHANNEL_ID, DATE);

    expect(callsFor(restarted, 'activity_messages:get')).toBe(1);
  });
});

describe('launch tokens', () => {
  it('stores the newest token and survives a restart', () => {
    room.saveLatestActivityLaunchToken(SCOPE_ID, CHANNEL_ID, 'token-1');
    room.saveLatestActivityLaunchToken(SCOPE_ID, CHANNEL_ID, 'token-2');

    const restarted = createRoom(db);
    const stored = restarted.getLatestActivityLaunchToken(CHANNEL_ID);

    expect(stored?.interactionToken).toBe('token-2');
    expect(stored!.tokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it('reports nothing for a channel that has never launched', () => {
    expect(room.getLatestActivityLaunchToken('999999999999999999')).toBeNull();
  });
});
