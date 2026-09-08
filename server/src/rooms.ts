import type { Database } from './db.ts';
import type { DiscordCredentials } from './discord.ts';
import { ProgressRoom } from './session.ts';

/**
 * Replaces `env.PROGRESS_ROOMS.getByName(scopeId)`.
 *
 * Durable Objects placed one instance per guild automatically; a single process just
 * keeps them in a Map. Rooms are cheap — maps and a reference to the shared database —
 * so they are created lazily and never evicted.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, ProgressRoom>();
  private readonly db: Database;
  private readonly credentials: DiscordCredentials;

  // Not parameter properties: Node strips types without emitting code, so the implied
  // field assignments would never happen.
  constructor(db: Database, credentials: DiscordCredentials) {
    this.db = db;
    this.credentials = credentials;
  }

  get(scopeId: string) {
    const existing = this.rooms.get(scopeId);
    if (existing) {
      return existing;
    }

    const room = new ProgressRoom(scopeId, this.db, this.credentials);
    this.rooms.set(scopeId, room);
    return room;
  }

  get size() {
    return this.rooms.size;
  }

  get connectionCount() {
    let total = 0;
    for (const room of this.rooms.values()) {
      total += room.connectionCount;
    }
    return total;
  }
}
