import { Database } from '../src/db.ts';
import type { DiscordCredentials } from '../src/discord.ts';
import { ProgressRoom } from '../src/session.ts';

export const DATE = '2026-08-20';
export const SCOPE_ID = 'guild:111111111111111111';
export const CHANNEL_ID = '222222222222222222';

export const TEST_CREDENTIALS: DiscordCredentials = {
  clientId: '000000000000000000',
  clientSecret: 'test-client-secret',
};

/**
 * An in-memory database per test. Durable Objects gave each guild its own storage and
 * the test pool isolated it per file; a plain SQLite file has neither, so isolation is
 * explicit here.
 */
export function createTestDatabase() {
  return new Database(':memory:');
}

export function createRoom(db: Database, scopeId = SCOPE_ID) {
  return new ProgressRoom(scopeId, db, TEST_CREDENTIALS);
}

export function callsFor(room: ProgressRoom, site: string) {
  return room.sqlUsage.get(site)?.calls ?? 0;
}

export function changesFor(room: ProgressRoom, site: string) {
  return room.sqlUsage.get(site)?.changes ?? 0;
}

export function resetUsage(room: ProgressRoom) {
  room.sqlUsage.clear();
}

export const attachmentFor = (userId: string) => ({
  userId,
  scopeId: SCOPE_ID,
  channelId: CHANNEL_ID,
  date: DATE,
});
