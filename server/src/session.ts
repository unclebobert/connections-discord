import { DurableObject } from 'cloudflare:workers';

type PlayerGuess = [number, number, number, number];
type PlayerProgress = Array<PlayerGuess>;

export class ProgressRoom extends DurableObject<Env> {
  sql: SqlStorage;
  users: Map<string, WebSocket>;
  userProgress: Map<string, PlayerProgress>;

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
    const cursor = this.sql.exec(`
      CREATE TABLE IF NOT EXISTS progress (
        user_id TEXT NOT NULL PRIMARY KEY,
        progress JSON NOT NULL
      );
      SELECT * FROM progress;
    `)
    for (const { user_id: userId, progress } of cursor.toArray() as Array<{
      user_id: string,
      progress: string, // Stored as JSON string in SQL (?)
    }>) {
      this.userProgress.set(userId, JSON.parse(progress));
    }
  }

  async join(userId: string) {
    const existingSocket = this.users.get(userId);
    if (existingSocket && existingSocket.readyState === WebSocket.OPEN) {
      // If the user is already connected, return the existing socket instead of creating a new one
      return existingSocket;
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // use this instead of websocket.accept() since it allows hibernation
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(userId);
    this.users.set(userId, server);

    // send initial progress of all users to the newly connected client
    const usersProgress: Record<string, PlayerProgress> = {};
    for (const [userId, progress] of this.userProgress.entries()) {
      usersProgress[userId] = progress;
    }
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
      const { userId, guess } = JSON.parse(message);
      this.saveGuess(userId, guess);
    } catch (error) {
      console.error('Error parsing guess:', error);
    }
  }

  async saveGuess(userId: string, progress: PlayerGuess) {
    // Update in-memory progress and persist to SQL storage
    if (this.userProgress.has(userId)) {
      this.userProgress.get(userId)?.push(progress);
    } else {
      this.userProgress.set(userId, [progress]);
    }
    this.sql.exec(`
      INSERT INTO progress (user_id, progress)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET progress=excluded.progress;
    `, [userId, JSON.stringify(progress)]);
    // Send progress update to all connected clients via websocket
    for (const [observerUserId, socket] of this.users.entries()) {
      if (observerUserId === userId) continue; // Don't send progress update to the user who made the update
      socket.send(JSON.stringify({ userId, progress }));
    }
  }
}
