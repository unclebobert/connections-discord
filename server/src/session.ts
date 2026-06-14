import { DurableObject } from 'cloudflare:workers';
import { updateActivityLaunchMessageForProgress } from './discord';
import { countCorrectGuesses, getPuzzleData, type PlayerGuess, type PlayerProgress } from './puzzles';

type PlayerProfile = {
  displayName: string;
  avatarUrl: string | null;
};
type SocketAttachment = {
  userId: string;
  guildId: string;
  channelId: string;
  date: string;
};

export class ProgressRoom extends DurableObject<Env> {
  sql: SqlStorage;
  env: Env;
  users: Map<string, WebSocket>;
  userProgress: Map<string, PlayerProgress>;
  userProfiles: Map<string, PlayerProfile>;

  constructor(ctx: DurableObjectState, env: Env) {
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
      this.users.set(attachment.userId, socket);
    }
    // Repopulate user progress from SQL storage, after hibernation
    this.userProgress = new Map();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS progress (
        user_id TEXT NOT NULL PRIMARY KEY,
        progress JSON NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT NOT NULL PRIMARY KEY,
        display_name TEXT NOT NULL,
        avatar_url TEXT
      );
    `)

    const cursor = this.sql.exec(`
      SELECT * FROM progress;
    `)
    for (const { user_id: userId, progress } of cursor.toArray() as Array<{
      user_id: string,
      progress: string, // Stored as JSON string in SQL (?)
    }>) {
      this.userProgress.set(userId, JSON.parse(progress));
    }

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
    if (this.users.get(attachment.userId) === ws) {
      this.users.delete(attachment.userId);
    }
  }

  async fetch(request: Request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('ProgressRoom expected Upgrade: websocket', {
        status: 426,
      });
    }

    const userId = request.headers.get('x-progress-user-id');
    const guildId = request.headers.get('x-progress-guild-id');
    const channelId = request.headers.get('x-progress-channel-id');
    const date = request.headers.get('x-progress-date');
    const encodedProfile = request.headers.get('x-progress-profile');
    if (!userId || !guildId || !channelId || !date || !encodedProfile) {
      console.warn('progress_room:missing_authenticated_user', {
        hasUserId: Boolean(userId),
        hasGuildId: Boolean(guildId),
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
        guildId,
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

  async join(userId: string, guildId: string, channelId: string, date: string, profile: PlayerProfile) {
    console.log('progress_room:join', {
      guildId,
      channelId,
      date,
      userId,
      hasAvatar: Boolean(profile.avatarUrl),
    });

    const existingSocket = this.users.get(userId);
    if (existingSocket && existingSocket.readyState === WebSocket.OPEN) {
      existingSocket.close(1000, 'New connection established');
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // use this instead of websocket.accept() since it allows hibernation
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, guildId, channelId, date } satisfies SocketAttachment);
    this.users.set(userId, server);
    this.saveProfile(userId, profile);
    await this.updateActivityMessageForPlayer(userId, guildId, channelId, date);

    // send initial progress of all users to the newly connected client
    const usersProgress = Array.from(this.userProgress.entries())
      .map(([userId, progress]) => ({
        userId,
        progress,
        profile: this.userProfiles.get(userId) ?? null,
      }));
    server.send(JSON.stringify(usersProgress));

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
      const { guess } = JSON.parse(message);
      if (!(guess instanceof Array)
        || guess.length !== 4
        || !guess.every(num => typeof num === 'number')
      ) {
        console.error('Invalid guess format');
        return;
      }
      const attachment = this.getSocketAttachment(ws);
      console.log('progress_room:message_guess', {
        guildId: attachment.guildId,
        channelId: attachment.channelId,
        date: attachment.date,
        userId: attachment.userId,
      });
      await this.saveGuess(attachment, guess as PlayerGuess);
    } catch (error) {
      console.error('Error parsing guess:', error);
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.removeSocket(ws);
  }

  async webSocketError(ws: WebSocket) {
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

  getSocketAttachment(ws: WebSocket): SocketAttachment {
    const attachment = ws.deserializeAttachment();

    if (typeof attachment === 'string') {
      return {
        userId: attachment,
        guildId: '',
        channelId: '',
        date: '',
      };
    }

    return attachment as SocketAttachment;
  }

  async saveGuess({ userId, guildId, channelId, date }: SocketAttachment, newGuess: PlayerGuess) {
    // Update in-memory progress and persist to SQL storage
    if (this.userProgress.has(userId)) {
      this.userProgress.get(userId)?.push(newGuess);
    } else {
      this.userProgress.set(userId, [newGuess]);
    }
    const progress = this.userProgress.get(userId)!;
    this.sql.exec(`
      INSERT INTO progress (user_id, progress)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET progress=excluded.progress;
    `, userId, JSON.stringify(progress));

    console.log('progress:guess_saved', {
      guildId,
      channelId,
      date,
      userId,
      guessCount: progress.length,
    });

    await this.updateActivityMessageForPlayer(userId, guildId, channelId, date);

    // Send progress update to all connected clients via websocket
    for (const [observerUserId, socket] of this.users.entries()) {
      if (observerUserId === userId) continue; // Don't send progress update to the user who made the update
      if (socket.readyState !== WebSocket.OPEN) {
        this.users.delete(observerUserId);
        continue;
      }

      try {
        socket.send(JSON.stringify({
          userId,
          progress,
          profile: this.userProfiles.get(userId) ?? null,
        }));
      } catch (error) {
        this.users.delete(observerUserId);
        console.error('Error sending progress update:', error);
      }
    }
  }

  async updateActivityMessageForPlayer(userId: string, guildId: string, channelId: string, date: string) {
    if (!guildId || !channelId || !date) {
      return;
    }

    const progress = this.userProgress.get(userId) ?? [];
    const puzzle = await getPuzzleData(this.env, date);
    if (!puzzle) {
      console.warn('activity_message:skip_missing_puzzle', {
        guildId,
        channelId,
        date,
        userId,
      });
      return;
    }

    await updateActivityLaunchMessageForProgress(this.env, guildId, channelId, date, {
      userId,
      displayName: this.userProfiles.get(userId)?.displayName ?? 'Someone',
      correctGuesses: countCorrectGuesses(progress, puzzle),
    });
  }
}
