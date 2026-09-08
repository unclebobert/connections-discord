import { WebSocket } from 'ws';
import {
  INTERACTION_TOKEN_TTL_MS,
  sendActivityLaunchMessage,
  type ActivityLaunchTokenState,
  type ActivityMessageMetadata,
  type ActivityMessagePlayer,
  type DiscordCredentials,
} from './discord.ts';
import type { Database } from './db.ts';
import { getPuzzleData, summarizeProgressForMessage, type PlayerGuess, type PlayerProgress } from './puzzles.ts';

export type PlayerProfile = {
  displayName: string;
  avatarUrl: string | null;
};
type SocketAttachment = {
  userId: string;
  scopeId: string;
  channelId: string;
  date: string;
};
type ProgressGuessMessage = {
  guess: PlayerGuess;
};
type ActivityMessageUpdate = {
  scopeId: string;
  channelId: string;
  date: string;
};
type SqlUsage = {
  calls: number;
  changes: number;
};

/**
 * One room per Discord scope (a guild, or a DM channel).
 *
 * This was a Durable Object. The hibernation machinery it needed — serialised socket
 * attachments, rebuilding the socket map in the constructor, an auto-response for
 * application-level pings — is all gone: the process holds this in memory and the
 * server sends real WebSocket protocol pings instead.
 *
 * Every Durable Object had a private database, so `progress` was implicitly scoped to
 * one guild. There is now a single shared database, so `scopeId` is a field on the
 * room and every progress query filters by it.
 */
export class ProgressRoom {
  readonly scopeId: string;
  sqlUsage: Map<string, SqlUsage>;

  private readonly db: Database;
  private readonly credentials: DiscordCredentials;
  private readonly users: Map<string, WebSocket>;
  private readonly attachments: WeakMap<WebSocket, SocketAttachment>;
  private readonly userProgress: Map<string, PlayerProgress>;
  private readonly loadedProgressDates: Set<string>;
  private readonly userProfiles: Map<string, PlayerProfile>;
  private readonly loadedProfileIds: Set<string>;
  private readonly activityMessageMetadata: Map<string, ActivityMessageMetadata>;
  private readonly pendingActivityMessageUpdates: Map<string, ActivityMessageUpdate>;
  private activityMessageUpdateTask: Promise<void> | null;

  constructor(scopeId: string, db: Database, credentials: DiscordCredentials) {
    this.scopeId = scopeId;
    this.db = db;
    this.credentials = credentials;
    this.sqlUsage = new Map();
    this.users = new Map();
    this.attachments = new WeakMap();
    this.userProgress = new Map();
    this.loadedProgressDates = new Set();
    this.userProfiles = new Map();
    this.loadedProfileIds = new Set();
    this.activityMessageMetadata = new Map();
    this.pendingActivityMessageUpdates = new Map();
    this.activityMessageUpdateTask = null;
  }

  // --- instrumentation -------------------------------------------------------
  // Kept from the Cloudflare era, but for timing and diagnostics rather than
  // billing: SQLite writes are free here, so exact row counts no longer matter.

  trackedExec(site: string, query: string, ...bindings: Array<string | number | null>) {
    const result = this.db.run(query, ...bindings);
    this.recordSqlUsage(site, Number(result.changes));
    return result;
  }

  trackedQuery<T>(site: string, query: string, ...bindings: Array<string | number | null>): T[] {
    const rows = this.db.all<T>(query, ...bindings);
    this.recordSqlUsage(site, 0);
    return rows;
  }

  private recordSqlUsage(site: string, changes: number) {
    const usage = this.sqlUsage.get(site) ?? { calls: 0, changes: 0 };
    usage.calls += 1;
    usage.changes += changes;
    this.sqlUsage.set(site, usage);
  }

  // --- connection lifecycle --------------------------------------------------

  join(socket: WebSocket, userId: string, channelId: string, date: string, profile: PlayerProfile) {
    console.log('progress_room:join', {
      scopeId: this.scopeId,
      channelId,
      date,
      userId,
      hasAvatar: Boolean(profile.avatarUrl),
    });

    const socketKey = getSocketKey(date, userId);
    const existingSocket = this.users.get(socketKey);
    if (existingSocket && existingSocket.readyState === WebSocket.OPEN) {
      existingSocket.close(1000, 'New connection established');
    }

    const attachment = { userId, scopeId: this.scopeId, channelId, date } satisfies SocketAttachment;
    this.attachments.set(socket, attachment);
    this.users.set(socketKey, socket);

    socket.on('message', (data, isBinary) => {
      void this.handleMessage(socket, data.toString(), isBinary);
    });
    socket.on('close', (code, reason) => {
      this.handleClose(socket, code, reason.toString());
    });
    socket.on('error', (error) => {
      this.handleError(socket, error);
    });

    this.saveProfile(userId, profile);
    this.ensurePlayerProgress(userId, date);

    // Send the current progress of everyone on this date to the new client.
    const usersProgress = this.getDateProgress(date)
      .map(([progressUserId, progress]) => ({
        userId: progressUserId,
        progress,
        profile: this.userProfiles.get(progressUserId) ?? null,
      }));
    socket.send(JSON.stringify(usersProgress));
    this.queueActivityMessageUpdateForPlayer(userId, this.scopeId, channelId, date);
  }

  private async handleMessage(socket: WebSocket, message: string, isBinary: boolean) {
    if (isBinary) {
      console.error('Binary messages are not supported');
      return;
    }

    const attachment = this.attachments.get(socket);
    if (!attachment) {
      return;
    }

    try {
      const parsed = JSON.parse(message) as Partial<ProgressGuessMessage>;
      const { guess } = parsed;
      if (!isPlayerGuess(guess)) {
        console.error('Invalid guess format');
        return;
      }

      const { wasSaved } = this.saveGuess(attachment, guess);
      if (wasSaved) {
        this.queueActivityMessageUpdateForPlayer(
          attachment.userId,
          attachment.scopeId,
          attachment.channelId,
          attachment.date,
        );
      }
    } catch (error) {
      console.error('Error parsing guess:', error);
    }
  }

  private handleClose(socket: WebSocket, code?: number, reason?: string) {
    const attachment = this.attachments.get(socket);
    console.log('progress_room:socket_close', {
      scopeId: this.scopeId,
      channelId: attachment?.channelId ?? null,
      date: attachment?.date ?? null,
      userId: attachment?.userId ?? null,
      code: code ?? null,
      reason: reason || null,
    });
    this.removeSocket(socket);
  }

  private handleError(socket: WebSocket, error: unknown) {
    const attachment = this.attachments.get(socket);
    console.warn('progress_room:socket_error', {
      scopeId: this.scopeId,
      channelId: attachment?.channelId ?? null,
      userId: attachment?.userId ?? null,
      error: error instanceof Error ? error.message : String(error ?? ''),
    });
    this.removeSocket(socket);
  }

  removeSocket(socket: WebSocket) {
    const attachment = this.attachments.get(socket);
    if (!attachment) {
      return;
    }

    const socketKey = getSocketKey(attachment.date, attachment.userId);
    if (this.users.get(socketKey) === socket) {
      this.users.delete(socketKey);
    }
    this.attachments.delete(socket);
  }

  get connectionCount() {
    return this.users.size;
  }

  // --- persistence -----------------------------------------------------------

  saveProfile(userId: string, profile: PlayerProfile) {
    this.loadProfiles([userId]);
    const storedProfile = this.userProfiles.get(userId);
    if (
      storedProfile &&
      storedProfile.displayName === profile.displayName &&
      storedProfile.avatarUrl === profile.avatarUrl
    ) {
      // Display name and avatar are stable across sessions; rewriting them on every
      // connect is pure churn.
      return;
    }

    this.userProfiles.set(userId, profile);
    this.trackedExec('profiles:save', `
      INSERT INTO profiles (user_id, display_name, avatar_url)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        display_name=excluded.display_name,
        avatar_url=excluded.avatar_url;
    `, userId, profile.displayName, profile.avatarUrl);
  }

  /** Profiles are global, so only the ids actually in play are ever loaded. */
  private loadProfiles(userIds: string[]) {
    const missing = userIds.filter((userId) => !this.loadedProfileIds.has(userId));
    if (missing.length === 0) {
      return;
    }

    const placeholders = missing.map(() => '?').join(', ');
    const rows = this.trackedQuery<{
      user_id: string,
      display_name: string,
      avatar_url: string | null,
    }>('profiles:load', `
      SELECT user_id, display_name, avatar_url
      FROM profiles
      WHERE user_id IN (${placeholders});
    `, ...missing);

    for (const { user_id: userId, display_name: displayName, avatar_url: avatarUrl } of rows) {
      this.userProfiles.set(userId, { displayName, avatarUrl });
    }

    // Remember the misses too, so an unknown user is not re-queried on every guess.
    for (const userId of missing) {
      this.loadedProfileIds.add(userId);
    }
  }

  loadDateProgress(date: string) {
    if (this.loadedProgressDates.has(date)) {
      return;
    }

    const rows = this.trackedQuery<{
      user_id: string,
      progress: string,
    }>('progress:load_date', `
      SELECT user_id, progress
      FROM progress
      WHERE scope_id = ? AND date = ?;
    `, this.scopeId, date);

    for (const { user_id: userId, progress } of rows) {
      this.userProgress.set(getProgressKey(date, userId), JSON.parse(progress) as PlayerProgress);
    }
    this.loadedProgressDates.add(date);
    this.loadProfiles(rows.map((row) => row.user_id));
  }

  ensurePlayerProgress(userId: string, date: string) {
    this.loadDateProgress(date);
    const progressKey = getProgressKey(date, userId);
    if (this.userProgress.has(progressKey)) {
      return;
    }

    this.userProgress.set(progressKey, []);
    this.trackedExec('progress:ensure', `
      INSERT INTO progress (scope_id, date, user_id, progress)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_id, date, user_id) DO NOTHING;
    `, this.scopeId, date, userId, JSON.stringify([]));
  }

  getDateProgress(date: string): Array<[string, PlayerProgress]> {
    this.loadDateProgress(date);
    const prefix = `${date}:`;
    return Array.from(this.userProgress.entries())
      .filter(([progressKey]) => progressKey.startsWith(prefix))
      .map(([progressKey, progress]) => [progressKey.slice(prefix.length), progress]);
  }

  saveGuess({ userId, channelId, date }: SocketAttachment, newGuess: PlayerGuess) {
    this.loadDateProgress(date);
    const progressKey = getProgressKey(date, userId);
    const currentProgress = this.userProgress.get(progressKey) ?? [];
    const isDuplicateGuess = currentProgress.some((guess) => areSameGuess(guess, newGuess));
    if (isDuplicateGuess) {
      console.log('progress:guess_duplicate', {
        scopeId: this.scopeId,
        channelId,
        date,
        userId,
        guessCount: currentProgress.length,
      });
      return { progress: currentProgress, wasSaved: false };
    }

    const progress = [...currentProgress, newGuess];
    this.userProgress.set(progressKey, progress);
    this.trackedExec('progress:save_guess', `
      INSERT INTO progress (scope_id, date, user_id, progress)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_id, date, user_id) DO UPDATE SET progress=excluded.progress;
    `, this.scopeId, date, userId, JSON.stringify(progress));

    console.log('progress:guess_saved', {
      scopeId: this.scopeId,
      channelId,
      date,
      userId,
      guessCount: progress.length,
    });

    this.broadcastProgress(userId, date, progress);

    return { progress, wasSaved: true };
  }

  private broadcastProgress(userId: string, date: string, progress: PlayerProgress) {
    const payload = JSON.stringify({
      userId,
      progress,
      profile: this.userProfiles.get(userId) ?? null,
    });

    for (const [socketKey, socket] of this.users.entries()) {
      const attachment = this.attachments.get(socket);
      if (!attachment || attachment.date !== date) continue;
      // The sender already applied this optimistically.
      if (attachment.userId === userId) continue;
      if (socket.readyState !== WebSocket.OPEN) {
        this.users.delete(socketKey);
        continue;
      }

      try {
        socket.send(payload);
      } catch (error) {
        this.users.delete(socketKey);
        console.error('Error sending progress update:', error);
      }
    }
  }

  // --- Discord launch message ------------------------------------------------

  queueActivityMessageUpdateForPlayer(userId: string, scopeId: string, channelId: string, date: string) {
    if (!scopeId || !channelId || !date) {
      return;
    }

    if (!this.userProgress.has(getProgressKey(date, userId))) {
      return;
    }

    const update = { scopeId, channelId, date } satisfies ActivityMessageUpdate;
    this.pendingActivityMessageUpdates.set(getActivityMessageUpdateKey(channelId, date), update);
    this.startActivityMessageUpdateTask();
  }

  startActivityMessageUpdateTask() {
    if (this.activityMessageUpdateTask) {
      return;
    }

    const task = this.flushActivityMessageUpdates();
    this.activityMessageUpdateTask = task;
    void task.finally(() => {
      if (this.activityMessageUpdateTask !== task) {
        return;
      }

      this.activityMessageUpdateTask = null;
      if (this.pendingActivityMessageUpdates.size > 0) {
        this.startActivityMessageUpdateTask();
      }
    });
  }

  async flushActivityMessageUpdates() {
    while (this.pendingActivityMessageUpdates.size > 0) {
      const nextEntry = this.pendingActivityMessageUpdates.entries().next().value;
      if (!nextEntry) {
        return;
      }

      const [updateKey, update] = nextEntry;
      this.pendingActivityMessageUpdates.delete(updateKey);

      try {
        await this.updateActivityMessage(update.scopeId, update.channelId, update.date);
      } catch (error) {
        console.warn('activity_message:update_failed', {
          ...update,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async updateActivityMessage(
    scopeId: string,
    channelId: string,
    date: string,
    interactionToken?: string,
  ) {
    const puzzle = await getPuzzleData(this.db, date);
    if (!puzzle) {
      console.warn('activity_message:skip_missing_puzzle', { scopeId, channelId, date });
      return;
    }

    const players = this.getActivityMessagePlayers(date, puzzle);
    if (players.length === 0) {
      return;
    }

    let metadata = this.getActivityMessageMetadata(scopeId, channelId, date);
    let result = await sendActivityLaunchMessage(this.credentials, {
      scopeId,
      channelId,
      date,
      metadata,
      interactionToken,
      players,
      canCreateMessage: Boolean(interactionToken),
    });

    if (result.result === 'needs_interaction') {
      const launchToken = this.getLatestActivityLaunchToken(channelId);
      if (!launchToken || launchToken.tokenExpiresAt <= Date.now()) {
        console.warn('activity_message:skip_no_current_launch_token', {
          scopeId,
          channelId,
          date,
          hasLaunchToken: Boolean(launchToken),
          expiredByMs: launchToken ? Date.now() - launchToken.tokenExpiresAt : null,
        });
        return;
      }

      console.log('activity_message:reuse_current_launch_token', { scopeId, channelId, date });
      metadata = result.metadata;
      result = await sendActivityLaunchMessage(this.credentials, {
        scopeId,
        channelId,
        date,
        metadata,
        interactionToken: launchToken.interactionToken,
        players,
        canCreateMessage: true,
      });
    }

    if (result.result === 'updated') {
      this.saveActivityMessageMetadata(result.metadata);
    }
  }

  getActivityMessagePlayers(
    date: string,
    puzzle: NonNullable<Awaited<ReturnType<typeof getPuzzleData>>>,
  ): ActivityMessagePlayer[] {
    return this.getDateProgress(date)
      .map(([userId, progress]) => {
        const progressSummary = summarizeProgressForMessage(progress, puzzle);
        return {
          userId,
          displayName: this.userProfiles.get(userId)?.displayName ?? 'Someone',
          correctGuesses: progressSummary.correctGuesses,
          progressCells: progressSummary.progressCells,
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  saveLatestActivityLaunchToken(scopeId: string, channelId: string, interactionToken: string) {
    const tokenExpiresAt = Date.now() + INTERACTION_TOKEN_TTL_MS;
    this.trackedExec('launch_tokens:save', `
      INSERT INTO launch_tokens (channel_id, interaction_token, token_expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        interaction_token=excluded.interaction_token,
        token_expires_at=excluded.token_expires_at;
    `, channelId, interactionToken, tokenExpiresAt);
    console.log('activity_message:launch_token_stored', {
      scopeId,
      channelId,
      expiresInMs: INTERACTION_TOKEN_TTL_MS,
    });
  }

  getLatestActivityLaunchToken(channelId: string): ActivityLaunchTokenState | null {
    const token = this.trackedQuery<{
      interaction_token: string;
      token_expires_at: number;
    }>('launch_tokens:get', `
      SELECT interaction_token, token_expires_at
      FROM launch_tokens
      WHERE channel_id = ?;
    `, channelId)[0];

    if (!token) {
      return null;
    }

    return {
      interactionToken: token.interaction_token,
      tokenExpiresAt: Number(token.token_expires_at),
    };
  }

  getActivityMessageMetadata(scopeId: string, channelId: string, date: string): ActivityMessageMetadata | null {
    const cacheKey = getActivityMessageUpdateKey(channelId, date);
    const cachedMetadata = this.activityMessageMetadata.get(cacheKey);
    if (cachedMetadata) {
      return cachedMetadata;
    }

    const metadata = this.trackedQuery<{
      message_id: string | null;
      interaction_token: string | null;
      token_expires_at: number;
      last_updated_at: number;
    }>('activity_messages:get', `
      SELECT message_id, interaction_token, token_expires_at, last_updated_at
      FROM activity_messages
      WHERE date = ? AND channel_id = ?;
    `, date, channelId)[0];

    if (!metadata) {
      return null;
    }

    const restoredMetadata = {
      scopeId,
      channelId,
      date,
      messageId: metadata.message_id,
      interactionToken: metadata.interaction_token,
      tokenExpiresAt: Number(metadata.token_expires_at),
      lastUpdatedAt: Number(metadata.last_updated_at),
    };
    this.activityMessageMetadata.set(cacheKey, restoredMetadata);

    return restoredMetadata;
  }

  saveActivityMessageMetadata(metadata: ActivityMessageMetadata) {
    // Written every time. The lazy-persistence scheme this replaces existed only to
    // save billed row writes on Durable Objects, and let the stored timestamp fall
    // behind reality across a restart.
    this.activityMessageMetadata.set(getActivityMessageUpdateKey(metadata.channelId, metadata.date), metadata);
    this.trackedExec('activity_messages:save', `
      INSERT INTO activity_messages (
        date,
        channel_id,
        message_id,
        interaction_token,
        token_expires_at,
        last_updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, channel_id) DO UPDATE SET
        message_id=excluded.message_id,
        interaction_token=excluded.interaction_token,
        token_expires_at=excluded.token_expires_at,
        last_updated_at=excluded.last_updated_at;
    `, metadata.date, metadata.channelId, metadata.messageId, metadata.interactionToken, metadata.tokenExpiresAt, metadata.lastUpdatedAt);
  }
}

export function isPlayerGuess(value: unknown): value is PlayerGuess {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((position) => Number.isInteger(position));
}

export function areSameGuess(left: PlayerGuess, right: PlayerGuess) {
  return getGuessKey(left) === getGuessKey(right);
}

export function getGuessKey(guess: PlayerGuess) {
  return [...guess].sort((left, right) => left - right).join(':');
}

function getProgressKey(date: string, userId: string) {
  return `${date}:${userId}`;
}

function getSocketKey(date: string, userId: string) {
  return getProgressKey(date, userId);
}

function getActivityMessageUpdateKey(channelId: string, date: string) {
  return `${date}:${channelId}`;
}
