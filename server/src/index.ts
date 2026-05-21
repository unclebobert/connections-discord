import { Hono } from 'hono'
import { cors } from 'hono/cors';

import {
  DurableObjectNamespace,
  DurableObjectState,
  KVNamespace,
} from '@cloudflare/workers-types';

type PlayerProgress = {
  userId: string;
  username: string;
  avatarUrl: string | null;
  solvedCount: number;
  mistakesMade: number;
  completed: boolean;
  resultLabel: string | null;
  updatedAt: number;
};

type ProgressUpdateMessage = {
  type: 'progress:update';
  player: PlayerProgress;
};

type ProgressSnapshotMessage = {
  type: 'progress:snapshot';
  players: PlayerProgress[];
};

const PROGRESS_PLAYER_PREFIX = 'player:';
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_AVATAR_URL_LENGTH = 512;

type Bindings = {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  KV: KVNamespace;
  PROGRESS_ROOMS: DurableObjectNamespace;
};

function clampProgressNumber(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

function normaliseProgressUpdate(message: unknown): PlayerProgress | null {
  if (
    !message ||
    typeof message !== 'object' ||
    (message as { type?: unknown }).type !== 'progress:update'
  ) {
    return null;
  }

  const player = (message as Partial<ProgressUpdateMessage>).player;
  if (!player || typeof player !== 'object') {
    return null;
  }

  if (typeof player.userId !== 'string' || player.userId.length === 0) {
    return null;
  }

  const username = typeof player.username === 'string' && player.username.trim().length > 0
    ? player.username.trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
    : 'Player';
  const avatarUrl = typeof player.avatarUrl === 'string'
    ? player.avatarUrl.slice(0, MAX_AVATAR_URL_LENGTH)
    : null;

  return {
    userId: player.userId,
    username,
    avatarUrl,
    solvedCount: clampProgressNumber(player.solvedCount, 0, 4),
    mistakesMade: clampProgressNumber(player.mistakesMade, 0, 4),
    completed: Boolean(player.completed),
    resultLabel: typeof player.resultLabel === 'string' ? player.resultLabel.slice(0, 24) : null,
    updatedAt: Date.now(),
  };
}

export class ProgressRoom {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket upgrade', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server);
    await this.sendSnapshot(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(_: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') {
      return;
    }

    let parsedMessage: unknown;
    try {
      parsedMessage = JSON.parse(message);
    } catch {
      return;
    }

    const playerProgress = normaliseProgressUpdate(parsedMessage);
    if (!playerProgress) {
      return;
    }

    await this.state.storage.put(`${PROGRESS_PLAYER_PREFIX}${playerProgress.userId}`, playerProgress);
    await this.broadcastSnapshot();
  }

  private async getPlayers() {
    const storedPlayers = await this.state.storage.list<PlayerProgress>({
      prefix: PROGRESS_PLAYER_PREFIX,
    });

    return [...storedPlayers.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async sendSnapshot(socket: WebSocket) {
    const message: ProgressSnapshotMessage = {
      type: 'progress:snapshot',
      players: await this.getPlayers(),
    };

    socket.send(JSON.stringify(message));
  }

  private async broadcastSnapshot() {
    const message: ProgressSnapshotMessage = {
      type: 'progress:snapshot',
      players: await this.getPlayers(),
    };
    const serializedMessage = JSON.stringify(message);

    for (const socket of this.state.getWebSockets()) {
      socket.send(serializedMessage);
    }
  }
}

// NOTE: endpoints should never include /api since all requests starting with
// /api/* will be routed to this server and the prefix gets removed
// i.e. the client should prepend /api before making requests to the server *if in prod*,
// but *in dev* it should make requests directly to the server without the /api prefix
const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

app.get('/', (c) => c.text('Connections Discord Bot Server'))

app.get('/progress/:guildId/:date', async (c) => {
  const guildId = c.req.param('guildId');
  const date = c.req.param('date');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{8,32}$/.test(guildId)) {
    return c.json({ error: 'Invalid progress room' }, 400);
  }

  const id = c.env.PROGRESS_ROOMS.idFromName(`${guildId}:${date}`);
  const room = c.env.PROGRESS_ROOMS.get(id);

  return room.fetch(c.req.raw);
});

app.get('/connections/:date', async (c) => {
  const date = c.req.param('date');
  // Check date validity
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Invalid puzzle date' }, 400);
  }

  // Check if puzzle data is cached in KV
  let data = await c.env.KV.get(`puzzle:${date}`, { type: 'json', cacheTtl: 86400 });

  if (!data) {
    const response = await fetch(`https://www.nytimes.com/svc/connections/v2/${date}.json`, {
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: 'Unable to load puzzle' }), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    data = await response.json();
    // Cache the puzzle data in KV
    await c.env.KV.put(`puzzle:${date}`, JSON.stringify(data));
  }

  return c.json(data, 200, {
    'Cache-Control': 'public, max-age=86400' // Cache for 1 day
  });
});

app.post('/token', async (c) => {
  const { code } = await c.req.json().catch(() => undefined);
  if (!code || typeof code !== 'string') {
    return c.json({ error: 'Invalid code' }, 400);
  }
  // Exchange the code for an access_token
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: c.env.CLIENT_ID,
      client_secret: c.env.CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    })
  });

  const data = await response.json();
  return c.json(data);
});

export default app
