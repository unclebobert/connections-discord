import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createUpgradeHandler, WS_CLOSE_FORBIDDEN, WS_CLOSE_UNAUTHENTICATED } from '../src/connections.ts';
import type { Database } from '../src/db.ts';
import { SocketHeartbeat } from '../src/heartbeat.ts';
import { RoomRegistry } from '../src/rooms.ts';
import { createTestDatabase, TEST_CREDENTIALS } from './helpers.ts';

/**
 * A rejected token has to be reported over an accepted socket. Failing the handshake
 * with a 401/403 is invisible to a browser — it surfaces as a generic error,
 * indistinguishable from a network drop — so the client would retry a token that can
 * never work. Tokens are cached for a week, so that would strand a user for a week.
 */

let db: Database;
let server: Server;
let heartbeat: SocketHeartbeat;
let port: number;

const today = () => new Date().toISOString().slice(0, 10);
const wsPath = () => `/ws/guild:111111111111/222222222222/${today()}/333333333333`;

function connect(path: string) {
  return new Promise<{ closeCode?: number; frames: string[]; error?: string }>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const frames: string[] = [];
    const timer = setTimeout(() => {
      socket.terminate();
      resolve({ frames, error: 'timeout' });
    }, 5000);

    socket.on('message', (data) => {
      frames.push(data.toString());
    });
    socket.on('close', (code) => {
      clearTimeout(timer);
      resolve({ closeCode: code, frames });
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      resolve({ frames, error: error.message });
    });
  });
}

beforeEach(async () => {
  db = createTestDatabase();
  const config = { ...TEST_CREDENTIALS, publicKey: '0'.repeat(64) };
  heartbeat = new SocketHeartbeat(60_000);
  const handleUpgrade = createUpgradeHandler({ config, db, rooms: new RoomRegistry(db, config) }, heartbeat);

  server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  vi.restoreAllMocks();
  heartbeat.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('websocket auth rejection', () => {
  it('reports an invalid token over the socket instead of failing the handshake', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    const result = await connect(`${wsPath()}?access_token=stale`);

    // Both signals: a custom close code may not survive Discord's activity proxy.
    expect(result.frames).toContain(JSON.stringify({ type: 'error', code: 'auth' }));
    expect(result.closeCode).toBe(WS_CLOSE_UNAUTHENTICATED);
  });

  it('distinguishes a token that is valid but not permitted here', async () => {
    // Discord accepts the token, but it belongs to someone outside this guild.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/users/@me')) {
        return new Response(JSON.stringify({ id: '333333333333', username: 'ada' }), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: '999999999999' }]), { status: 200 });
    });

    const result = await connect(`${wsPath()}?access_token=other-user`);

    expect(result.closeCode).toBe(WS_CLOSE_FORBIDDEN);
  });

  it('treats a missing token as unauthenticated rather than malformed', async () => {
    const result = await connect(wsPath());

    expect(result.closeCode).toBe(WS_CLOSE_UNAUTHENTICATED);
  });

  it('leaves a transient Discord outage as a retryable failed handshake', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    const result = await connect(`${wsPath()}?access_token=whatever`);

    // Not an accepted socket: the client should back off and retry, not give up.
    expect(result.closeCode).toBeUndefined();
    expect(result.error).toContain('502');
  });

  it.each([
    ['a malformed date', `/ws/guild:111111111111/222222222222/not-a-date/333333333333?access_token=x`],
    ['a date outside the allowed window', `/ws/guild:111111111111/222222222222/2020-01-01/333333333333?access_token=x`],
    ['a malformed scope', `/ws/nonsense/222222222222/${today()}/333333333333?access_token=x`],
    ['a malformed user id', `/ws/guild:111111111111/222222222222/${today()}/abc?access_token=x`],
    ['an unknown path', '/nope'],
  ])('fails the handshake for %s', async (_label, path) => {
    const result = await connect(path);

    // Validation failures never reach Discord, so they are cheap to reject outright.
    expect(result.closeCode).toBeUndefined();
    expect(result.error).toBeDefined();
  });
});
