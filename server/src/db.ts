import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * Thin wrapper over node:sqlite.
 *
 * node:sqlite is built into Node, so there is no native module to compile — which keeps
 * deployment to copying a single bundled file onto the instance.
 *
 * Each Durable Object used to own a private database, so tables were partitioned
 * implicitly by guild. One process now shares a single file, so `progress` carries an
 * explicit `scope_id`. `profiles` deliberately does not: a Discord display name is the
 * same everywhere, and the old per-guild copies were duplication.
 */
export class Database {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(location: string) {
    this.db = new DatabaseSync(location);
    // WAL keeps reads from blocking on writes and survives an unclean shutdown, which
    // matters when the process can be killed by a host reboot at any time.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.applySchema();
  }

  run(query: string, ...bindings: SqlValue[]) {
    return this.prepare(query).run(...bindings);
  }

  all<T>(query: string, ...bindings: SqlValue[]): T[] {
    return this.prepare(query).all(...bindings) as T[];
  }

  close() {
    this.statements.clear();
    this.db.close();
  }

  /** Statements are reused; re-preparing on every guess is pure overhead. */
  private prepare(query: string) {
    const cached = this.statements.get(query);
    if (cached) {
      return cached;
    }

    const statement = this.db.prepare(query);
    this.statements.set(query, statement);
    return statement;
  }

  private applySchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS progress (
        scope_id TEXT NOT NULL,
        date TEXT NOT NULL,
        user_id TEXT NOT NULL,
        progress TEXT NOT NULL,
        PRIMARY KEY (scope_id, date, user_id)
      );

      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT NOT NULL PRIMARY KEY,
        display_name TEXT NOT NULL,
        avatar_url TEXT
      );

      CREATE TABLE IF NOT EXISTS activity_messages (
        date TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        interaction_token TEXT,
        token_expires_at INTEGER NOT NULL,
        last_updated_at INTEGER NOT NULL,
        PRIMARY KEY (date, channel_id)
      );

      CREATE TABLE IF NOT EXISTS launch_tokens (
        channel_id TEXT NOT NULL PRIMARY KEY,
        interaction_token TEXT NOT NULL,
        token_expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS puzzles (
        date TEXT NOT NULL PRIMARY KEY,
        data TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `);
  }
}
