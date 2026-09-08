import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createUpgradeHandler } from './connections.ts';
import { Database } from './db.ts';
import { loadConfig, type AppEnv } from './env.ts';
import { SocketHeartbeat } from './heartbeat.ts';
import { RoomRegistry } from './rooms.ts';

// Comfortably inside the idle timeouts applied by Cloudflare's proxy and by Discord's,
// neither of which is documented precisely.
const HEARTBEAT_INTERVAL_MS = 30_000;

const port = Number(process.env.PORT ?? 8787);
const databasePath = process.env.DATABASE_PATH ?? './data/connections.sqlite';

mkdirSync(dirname(databasePath), { recursive: true });

const config = loadConfig();
const db = new Database(databasePath);
const rooms = new RoomRegistry(db, config);
const env: AppEnv = { config, db, rooms };
const heartbeat = new SocketHeartbeat(HEARTBEAT_INTERVAL_MS).start();

const app = createApp(env);
const handleUpgrade = createUpgradeHandler(env, heartbeat);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log({ msg: 'server:listening', port: info.port, databasePath });
});

server.on('upgrade', (request, socket, head) => {
  void handleUpgrade(request, socket, head).catch((error: unknown) => {
    console.error('progress_ws:upgrade_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    socket.destroy();
  });
});

// 1001 "going away": clients treat it as a normal close and reconnect with backoff.
const WS_CLOSE_GOING_AWAY = 1001;
// Long enough for a closing handshake to complete, short enough that a deploy is quick.
const SHUTDOWN_GRACE_MS = 5_000;

let shuttingDown = false;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log({ msg: 'server:shutting_down', signal, connections: rooms.connectionCount });
    heartbeat.stop();
    rooms.closeAll(WS_CLOSE_GOING_AWAY, 'Server restarting');

    server.close(() => {
      db.close();
      process.exit(0);
    });

    setTimeout(() => {
      console.warn({ msg: 'server:shutdown_forced', connections: rooms.connectionCount });
      rooms.terminateAll();
      db.close();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
  });
}
