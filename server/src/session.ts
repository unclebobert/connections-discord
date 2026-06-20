import { DurableObject } from 'cloudflare:workers';
import {
  INTERACTION_TOKEN_TTL_MS,
  sendActivityLaunchMessage,
  type ActivityLaunchTokenState,
  type ActivityMessageMetadata,
  type ActivityMessagePlayer,
} from './discord';
import type { Bindings } from './env';
import { getPuzzleData, summarizeProgressForMessage, type PlayerGuess, type PlayerProgress } from './puzzles';

type PlayerProfile = {
  displayName: string;
  avatarUrl: string | null;
};
type SocketAttachment = {
  userId: string;
  scopeId: string;
  channelId: string;
  date: string;
};
type ActivityInteractionRequest = {
  interactionToken: string;
  scopeId: string;
  channelId: string;
};
type ProgressGuessMessage = {
  messageId?: string;
  guess: PlayerGuess;
};
type ActivityMessageUpdate = {
  scopeId: string;
  channelId: string;
  date: string;
};

export class ProgressRoom extends DurableObject<Bindings> {
  sql: SqlStorage;
  env: Bindings;
  users: Map<string, WebSocket>;
  userProgress: Map<string, PlayerProgress>;
  loadedProgressDates: Set<string>;
  userProfiles: Map<string, PlayerProfile>;
  pendingActivityMessageUpdates: Map<string, ActivityMessageUpdate>;
  activityMessageUpdateTask: Promise<void> | null;

  constructor(ctx: DurableObjectState, env: Bindings) {
    // Required, as we're extending the base class.
    super(ctx, env)
    this.env = env;
    this.sql = ctx.storage.sql;
    // Since this can hibernate when websockets are idle, need to restore
    // the users map from the stored currently connected websockets,
    // because DOs get killed when hibernating
    this.users = new Map();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.getSocketAttachment(socket);
      this.users.set(getSocketKey(attachment.date, attachment.userId), socket);
    }
    this.userProgress = new Map();
    this.loadedProgressDates = new Set();
    this.pendingActivityMessageUpdates = new Map();
    this.activityMessageUpdateTask = null;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS progress (
        date TEXT NOT NULL,
        user_id TEXT NOT NULL,
        progress JSON NOT NULL,
        PRIMARY KEY (date, user_id)
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT NOT NULL PRIMARY KEY,
        display_name TEXT NOT NULL,
        avatar_url TEXT
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS activity_messages (
        date TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        interaction_token TEXT,
        token_expires_at INTEGER NOT NULL,
        last_updated_at INTEGER NOT NULL,
        PRIMARY KEY (date, channel_id)
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS launch_tokens (
        channel_id TEXT NOT NULL PRIMARY KEY,
        interaction_token TEXT NOT NULL,
        token_expires_at INTEGER NOT NULL
      );
    `)

    this.userProfiles = new Map();
    const profiles = this.sql.exec(`
      SELECT * FROM profiles;
    `)
    for (const { user_id: userId, display_name: displayName, avatar_url: avatarUrl } of profiles.toArray() as Array<{
      user_id: string,
      display_name: string,
      avatar_url: string | null,
    }>) {
      this.userProfiles.set(userId, {
        displayName,
        avatarUrl,
      });
    }
  }

  removeSocket(ws: WebSocket) {
    const attachment = this.getSocketAttachment(ws);
    const socketKey = getSocketKey(attachment.date, attachment.userId);
    if (this.users.get(socketKey) === ws) {
      this.users.delete(socketKey);
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/activity/launch-token' && request.method === 'POST') {
      return this.handleActivityLaunchToken(request);
    }

    if (url.pathname === '/activity/launch-token' && request.method === 'GET') {
      return this.handleGetActivityLaunchToken(url);
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('ProgressRoom expected Upgrade: websocket', {
        status: 426,
      });
    }

    const userId = request.headers.get('x-progress-user-id');
    const scopeId = request.headers.get('x-progress-scope-id');
    const channelId = request.headers.get('x-progress-channel-id');
    const date = request.headers.get('x-progress-date');
    const encodedProfile = request.headers.get('x-progress-profile');
    if (!userId || !scopeId || !channelId || !date || !encodedProfile) {
      console.warn('progress_room:missing_authenticated_user', {
        hasUserId: Boolean(userId),
        hasScopeId: Boolean(scopeId),
        hasChannelId: Boolean(channelId),
        hasDate: Boolean(date),
        hasProfile: Boolean(encodedProfile),
      });
      return new Response('Missing authenticated progress user', {
        status: 401,
      });
    }

    try {
      return await this.join(
        userId,
        scopeId,
        channelId,
        date,
        JSON.parse(decodeURIComponent(encodedProfile)) as PlayerProfile,
      );
    } catch (error) {
      console.error('Error opening progress socket:', error);
      return new Response('Invalid progress user metadata', {
        status: 400,
      });
    }
  }

  async handleActivityLaunchToken(request: Request) {
    const body = await request.json<ActivityInteractionRequest>().catch(() => null);
    if (!isActivityInteractionRequest(body)) {
      return new Response('Invalid activity launch token payload', {
        status: 400,
      });
    }

    this.saveLatestActivityLaunchToken(body.scopeId, body.channelId, body.interactionToken);

    return new Response(null, {
      status: 204,
    });
  }

  handleGetActivityLaunchToken(url: URL) {
    const channelId = url.searchParams.get('channelId');
    if (!channelId) {
      return new Response('Missing channelId', {
        status: 400,
      });
    }

    return Response.json(this.getStoredActivityLaunchToken(channelId));
  }

  join(userId: string, scopeId: string, channelId: string, date: string, profile: PlayerProfile) {
    console.log('progress_room:join', {
      scopeId,
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

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // use this instead of websocket.accept() since it allows hibernation
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, scopeId, channelId, date } satisfies SocketAttachment);
    this.users.set(socketKey, server);
    this.saveProfile(userId, profile);
    this.ensurePlayerProgress(userId, date);

    // send initial progress of all users to the newly connected client
    const usersProgress = this.getDateProgress(date)
      .map(([userId, progress]) => ({
        userId,
        progress,
        profile: this.userProfiles.get(userId) ?? null,
      }));
    server.send(JSON.stringify(usersProgress));
    this.queueActivityMessageUpdateForPlayer(userId, scopeId, channelId, date);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
  
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // listen for updates and push them to all connected clients
    if (message instanceof ArrayBuffer) {
      console.error('Binary messages are not supported');
      return;
    }
    try {
      const parsed = JSON.parse(message) as Partial<ProgressGuessMessage>;
      const { guess } = parsed;
      const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : null;
      if (!isPlayerGuess(guess)) {
        console.error('Invalid guess format');
        return;
      }
      const attachment = this.getSocketAttachment(ws);
      console.log('progress_room:message_guess', {
        scopeId: attachment.scopeId,
        channelId: attachment.channelId,
        date: attachment.date,
        userId: attachment.userId,
        messageId,
      });
      const { progress, wasSaved } = this.saveGuess(attachment, guess);
      if (messageId) {
        this.sendProgressAck(ws, messageId, attachment.userId, progress);
      }
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

  async webSocketClose(ws: WebSocket, code?: number, reason?: string, wasClean?: boolean) {
    const attachment = this.getSocketAttachment(ws);
    console.log('progress_room:socket_close', {
      scopeId: attachment.scopeId,
      channelId: attachment.channelId,
      date: attachment.date,
      userId: attachment.userId,
      code: code ?? null,
      reason: reason ?? null,
      wasClean: wasClean ?? null,
    });
    this.removeSocket(ws);
  }

  async webSocketError(ws: WebSocket, error?: unknown) {
    const attachment = this.getSocketAttachment(ws);
    console.warn('progress_room:socket_error', {
      scopeId: attachment.scopeId,
      channelId: attachment.channelId,
      date: attachment.date,
      userId: attachment.userId,
      error: error instanceof Error ? error.message : String(error ?? ''),
    });
    this.removeSocket(ws);
  }

  saveProfile(userId: string, profile: PlayerProfile) {
    this.userProfiles.set(userId, profile);
    this.sql.exec(`
      INSERT INTO profiles (user_id, display_name, avatar_url)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        display_name=excluded.display_name,
        avatar_url=excluded.avatar_url;
    `, userId, profile.displayName, profile.avatarUrl);
  }

  loadDateProgress(date: string) {
    if (this.loadedProgressDates.has(date)) {
      return;
    }

    const cursor = this.sql.exec(`
      SELECT user_id, progress
      FROM progress
      WHERE date = ?;
    `, date);
    for (const { user_id: userId, progress } of cursor.toArray() as Array<{
      user_id: string,
      progress: string,
    }>) {
      this.userProgress.set(getProgressKey(date, userId), JSON.parse(progress));
    }
    this.loadedProgressDates.add(date);
  }

  ensurePlayerProgress(userId: string, date: string) {
    this.loadDateProgress(date);
    const progressKey = getProgressKey(date, userId);
    if (this.userProgress.has(progressKey)) {
      return;
    }

    this.userProgress.set(progressKey, []);
    this.sql.exec(`
      INSERT INTO progress (date, user_id, progress)
      VALUES (?, ?, ?)
      ON CONFLICT(date, user_id) DO NOTHING;
    `, date, userId, JSON.stringify([]));
  }

  getSocketAttachment(ws: WebSocket): SocketAttachment {
    const attachment = ws.deserializeAttachment();

    if (typeof attachment === 'string') {
      return {
        userId: attachment,
        scopeId: '',
        channelId: '',
        date: '',
      };
    }

    return attachment as SocketAttachment;
  }

  getDateProgress(date: string): Array<[string, PlayerProgress]> {
    this.loadDateProgress(date);
    const prefix = `${date}:`;
    return Array.from(this.userProgress.entries())
      .filter(([progressKey]) => progressKey.startsWith(prefix))
      .map(([progressKey, progress]) => [progressKey.slice(prefix.length), progress]);
  }

  saveGuess({ userId, scopeId, channelId, date }: SocketAttachment, newGuess: PlayerGuess) {
    // Update in-memory progress and persist to SQL storage
    this.loadDateProgress(date);
    const progressKey = getProgressKey(date, userId);
    const currentProgress = this.userProgress.get(progressKey) ?? [];
    const isDuplicateGuess = currentProgress.some((guess) => areSameGuess(guess, newGuess));
    if (isDuplicateGuess) {
      console.log('progress:guess_duplicate', {
        scopeId,
        channelId,
        date,
        userId,
        guessCount: currentProgress.length,
      });
      return { progress: currentProgress, wasSaved: false };
    }

    const progress = [...currentProgress, newGuess];
    this.userProgress.set(progressKey, progress);
    this.sql.exec(`
      INSERT INTO progress (date, user_id, progress)
      VALUES (?, ?, ?)
      ON CONFLICT(date, user_id) DO UPDATE SET progress=excluded.progress;
    `, date, userId, JSON.stringify(progress));

    console.log('progress:guess_saved', {
      scopeId,
      channelId,
      date,
      userId,
      guessCount: progress.length,
    });

    // Send progress update to all connected clients via websocket
    for (const [socketKey, socket] of this.users.entries()) {
      const attachment = this.getSocketAttachment(socket);
      if (attachment.date !== date) continue;
      if (attachment.userId === userId) continue; // Don't send progress update to the user who made the update
      if (socket.readyState !== WebSocket.OPEN) {
        this.users.delete(socketKey);
        continue;
      }

      try {
        socket.send(JSON.stringify({
          userId,
          progress,
          profile: this.userProfiles.get(userId) ?? null,
        }));
      } catch (error) {
        this.users.delete(socketKey);
        console.error('Error sending progress update:', error);
      }
    }

    return { progress, wasSaved: true };
  }

  sendProgressAck(ws: WebSocket, messageId: string, userId: string, progress: PlayerProgress) {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      ws.send(JSON.stringify({
        type: 'ack',
        messageId,
        player: {
          userId,
          progress,
          profile: this.userProfiles.get(userId) ?? null,
        },
      }));
    } catch (error) {
      console.error('progress_room:ack_failed', {
        userId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
    this.ctx.waitUntil(task.finally(() => {
      if (this.activityMessageUpdateTask !== task) {
        return;
      }

      this.activityMessageUpdateTask = null;
      if (this.pendingActivityMessageUpdates.size > 0) {
        this.startActivityMessageUpdateTask();
      }
    }));
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
    const puzzle = await getPuzzleData(this.env, date);
    if (!puzzle) {
      console.warn('activity_message:skip_missing_puzzle', {
        scopeId,
        channelId,
        date,
      });
      return;
    }

    const players = this.getActivityMessagePlayers(date, puzzle);
    if (players.length === 0) {
      return;
    }

    let metadata = this.getActivityMessageMetadata(scopeId, channelId, date);
    let result = await sendActivityLaunchMessage(this.env, {
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

      console.log('activity_message:reuse_current_launch_token', {
        scopeId,
        channelId,
        date,
      });
      metadata = result.metadata;
      result = await sendActivityLaunchMessage(this.env, {
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

  getActivityMessagePlayers(date: string, puzzle: NonNullable<Awaited<ReturnType<typeof getPuzzleData>>>): ActivityMessagePlayer[] {
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
    this.sql.exec(`
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
    const token = this.sql.exec<{
      interaction_token: string;
      token_expires_at: number;
    }>(`
      SELECT interaction_token, token_expires_at
      FROM launch_tokens
      WHERE channel_id = ?;
    `, channelId).toArray()[0];

    if (!token) {
      return null;
    }

    return {
      interactionToken: token.interaction_token,
      tokenExpiresAt: token.token_expires_at,
    };
  }

  getStoredActivityLaunchToken(channelId: string): ActivityLaunchTokenState | null {
    return this.getLatestActivityLaunchToken(channelId);
  }

  getActivityMessageMetadata(scopeId: string, channelId: string, date: string): ActivityMessageMetadata | null {
    const metadata = this.sql.exec<{
      message_id: string | null;
      interaction_token: string | null;
      token_expires_at: number;
      last_updated_at: number;
    }>(`
      SELECT message_id, interaction_token, token_expires_at, last_updated_at
      FROM activity_messages
      WHERE date = ? AND channel_id = ?;
    `, date, channelId).toArray()[0];

    if (!metadata) {
      return null;
    }

    return {
      scopeId,
      channelId,
      date,
      messageId: metadata.message_id,
      interactionToken: metadata.interaction_token,
      tokenExpiresAt: metadata.token_expires_at,
      lastUpdatedAt: metadata.last_updated_at,
    };
  }

  saveActivityMessageMetadata(metadata: ActivityMessageMetadata) {
    this.sql.exec(`
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

function isActivityInteractionRequest(value: unknown): value is ActivityInteractionRequest {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as ActivityInteractionRequest).interactionToken === 'string' &&
    typeof (value as ActivityInteractionRequest).scopeId === 'string' &&
    typeof (value as ActivityInteractionRequest).channelId === 'string';
}

function isPlayerGuess(value: unknown): value is PlayerGuess {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((position) => Number.isInteger(position));
}

function areSameGuess(left: PlayerGuess, right: PlayerGuess) {
  return getGuessKey(left) === getGuessKey(right);
}

function getGuessKey(guess: PlayerGuess) {
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
