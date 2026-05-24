import { DurableObject } from 'cloudflare:workers';

type PlayerGuess = [number, number, number, number];
type PlayerProgress = Array<PlayerGuess>;
type PlayerProfile = {
  displayName: string;
  avatarUrl: string | null;
};

export class ProgressRoom extends DurableObject<Env> {
  sql: SqlStorage;
  users: Map<string, WebSocket>;
  userProgress: Map<string, PlayerProgress>;
  userProfiles: Map<string, PlayerProfile>;

  constructor(ctx: DurableObjectState, env: Env) {
    // Required, as we're extending the base class.
    super(ctx, env)
    this.sql = ctx.storage.sql;
    // Since this can hibernate when websockets are idle, need to restore
    // the users map from the stored currently connected websockets,
    // because DOs get killed when hibernating
    this.users = new Map();
    for (const socket of this.ctx.getWebSockets()) {
      this.users.set(socket.deserializeAttachment(), socket);
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
    const userId = ws.deserializeAttachment();
    if (this.users.get(userId) === ws) {
      this.users.delete(userId);
    }
  }

  async join(userId: string, profile: PlayerProfile) {
    const existingSocket = this.users.get(userId);
    if (existingSocket && existingSocket.readyState === WebSocket.OPEN) {
      existingSocket.close(1000, 'New connection established');
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // use this instead of websocket.accept() since it allows hibernation
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(userId);
    this.users.set(userId, server);
    this.saveProfile(userId, profile);

    // send initial progress of all users to the newly connected client
    const usersProgress = Array.from(this.userProgress.entries())
      .map(([userId, progress]) => ({
        userId,
        progress,
        profile: this.userProfiles.get(userId) ?? null,
      }));
    server.send(JSON.stringify(usersProgress));

    return client;
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
      const userId = ws.deserializeAttachment();
      this.saveGuess(userId, guess as PlayerGuess);
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
    `, [userId, profile.displayName, profile.avatarUrl]);
  }

  async saveGuess(userId: string, newGuess: PlayerGuess) {
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
    `, [userId, JSON.stringify(progress)]);
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
}
