import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { exchangeDiscordCode, validateDiscordAccess } from './discord.ts';
import type { App, AppEnv } from './env.ts';
import type { SocketHeartbeat } from './heartbeat.ts';
import { getPuzzleData, isValidPuzzleDate } from './puzzles.ts';

// Application close codes. Must match the client's handling in App.tsx.
export const WS_CLOSE_UNAUTHENTICATED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;

// A browser cannot read the status of a failed WebSocket handshake, so an auth
// rejection has to be delivered over an accepted socket instead. Both an error frame
// and a close code are sent: the close code has to survive Discord's activity proxy,
// and the frame has to arrive before the close is processed.
const AUTH_ERROR_FRAME = JSON.stringify({ type: 'error', code: 'auth' });

export function registerConnectionsRoutes(app: App) {
  app.get('/connections/:date', async (c) => {
    const date = c.req.param('date');
    if (!isValidPuzzleDate(date)) {
      return c.json({ error: 'Invalid puzzle date' }, 400);
    }

    const data = await getPuzzleData(c.env.db, date);
    if (!data) {
      return c.json({ error: 'Unable to load puzzle' }, 502);
    }

    return c.json(data, 200, {
      // Cloudflare's edge caches on this, so most reads never reach the origin.
      'Cache-Control': 'public, max-age=86400',
    });
  });

  app.post('/token', async (c) => {
    const { code } = await c.req.json().catch(() => undefined);
    if (!code || typeof code !== 'string') {
      return c.json({ error: 'Invalid code' }, 400);
    }

    const tokenResult = await exchangeDiscordCode(c.env.config, code);
    if (!tokenResult.ok) {
      return c.json({ error: tokenResult.error }, tokenResult.status);
    }

    return c.json(tokenResult.data);
  });
}

/**
 * Handles the WebSocket upgrade.
 *
 * On Workers this was an HTTP route that authenticated and then forwarded the request
 * to a Durable Object, smuggling the authenticated identity through `x-progress-*`
 * headers because that was the only way across the boundary. The room is in this
 * process now, so `join` is called directly with typed arguments.
 */
export function createUpgradeHandler(env: AppEnv, heartbeat: SocketHeartbeat) {
  const wss = new WebSocketServer({ noServer: true });

  return async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments[0] !== 'ws' || segments.length !== 5) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const [, rawScopeId, rawChannelId, rawDate, rawUserId] = segments;
    const scopeId = decodeURIComponent(rawScopeId);
    const channelId = decodeURIComponent(rawChannelId);
    const date = decodeURIComponent(rawDate);
    const userId = decodeURIComponent(rawUserId);

    console.log('progress_ws:request', { scopeId, channelId, date, userId });

    if (!isValidPuzzleDate(date) || isPuzzleDateTooFarFromToday(date)) {
      console.warn('progress_ws:invalid_date', { scopeId, channelId, date, userId });
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    if (!isActivityScopeId(scopeId) || !isDiscordSnowflake(channelId) || !isDiscordSnowflake(userId)) {
      console.warn('progress_ws:invalid_scope_or_snowflake', { scopeId, channelId, date, userId });
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    const accessToken = url.searchParams.get('access_token');
    if (!accessToken) {
      console.warn('progress_ws:missing_access_token', { scopeId, channelId, date, userId });
      closeWithAuthFailure(wss, request, socket, head, WS_CLOSE_UNAUTHENTICATED);
      return;
    }

    const authResult = await validateDiscordAccess(accessToken, userId, getGuildIdFromActivityScope(scopeId));
    if (!authResult.ok) {
      console.warn('progress_ws:auth_failed', {
        scopeId,
        channelId,
        date,
        userId,
        status: authResult.status,
        error: authResult.error,
      });

      // 502 means Discord itself was unreachable, which is transient — fail the
      // handshake so the client retries with backoff. 401/403 never will succeed with
      // this token, so the client is told to discard it and re-authorize.
      if (authResult.status === 502) {
        rejectUpgrade(socket, 502, 'Bad Gateway');
        return;
      }

      closeWithAuthFailure(
        wss,
        request,
        socket,
        head,
        authResult.status === 401 ? WS_CLOSE_UNAUTHENTICATED : WS_CLOSE_FORBIDDEN,
      );
      return;
    }

    console.log('progress_ws:auth_ok', { scopeId, channelId, date, userId });

    wss.handleUpgrade(request, socket, head, (client) => {
      heartbeat.track(client);
      env.rooms.get(scopeId).join(client, userId, channelId, date, authResult.profile);
    });
  };
}

function closeWithAuthFailure(
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  closeCode: number,
) {
  wss.handleUpgrade(request, socket, head, (client) => {
    client.send(AUTH_ERROR_FRAME);
    client.close(closeCode, 'Authentication failed');
  });
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string) {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function isPuzzleDateTooFarFromToday(date: string) {
  return Math.abs(Date.now() - Date.parse(date)) > 1000 * 60 * 60 * 24 * 3;
}

export function isDiscordSnowflake(value: string) {
  return /^\d{12,24}$/.test(value);
}

export function isActivityScopeId(value: string) {
  const parts = value.split(':');
  if (parts.length !== 2) {
    return false;
  }

  const [scopeType, id] = parts;
  return (
    (scopeType === 'guild' || scopeType === 'dm') &&
    Boolean(id) &&
    isDiscordSnowflake(id)
  );
}

export function getGuildIdFromActivityScope(scopeId: string) {
  return scopeId.startsWith('guild:') ? scopeId.slice('guild:'.length) : null;
}
