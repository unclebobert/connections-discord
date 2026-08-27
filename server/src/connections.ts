import {
  exchangeDiscordCode,
  validateDiscordAccess,
} from './discord';
import type { App } from './env';
import { getPuzzleData, isValidPuzzleDate } from './puzzles';

// Application close codes. Must match the client's handling in App.tsx.
export const WS_CLOSE_UNAUTHENTICATED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;

export function registerConnectionsRoutes(app: App) {
  app.get('/ws/:scopeId/:channelId/:date/:userId', async (c) => {
    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Worker expected Upgrade: websocket', {
        status: 426,
      });
    }

    const scopeId = c.req.param('scopeId');
    const channelId = c.req.param('channelId');
    const date = c.req.param('date');
    const userId = c.req.param('userId');
    console.log('progress_ws:request', {
      scopeId,
      channelId,
      date,
      userId,
    });

    if (!scopeId || !channelId || !date || !userId) {
      console.warn('progress_ws:missing_params');
      return new Response('Missing scopeId, channelId, date, or userId', {
        status: 400,
      });
    }

    if (!isValidPuzzleDate(date)) {
      console.warn('progress_ws:invalid_date_format', { scopeId, channelId, date, userId });
      return new Response('Invalid date format', {
        status: 400,
      });
    }

    if (isPuzzleDateTooFarFromToday(date)) {
      console.warn('progress_ws:invalid_date_range', { scopeId, channelId, date, userId });
      return new Response('Invalid date', {
        status: 400,
      });
    }

    if (!isActivityScopeId(scopeId) || !isDiscordSnowflake(channelId) || !isDiscordSnowflake(userId)) {
      console.warn('progress_ws:invalid_scope_or_snowflake', { scopeId, channelId, date, userId });
      return c.json({ error: 'Invalid scope ID, channel ID, or user ID' }, 400);
    }

    const accessToken = c.req.query('access_token');
    if (!accessToken) {
      console.warn('progress_ws:missing_access_token', { scopeId, channelId, date, userId });
      return c.json({ error: 'Missing access token' }, 401);
    }

    const expectedGuildId = getGuildIdFromActivityScope(scopeId);
    const authResult = await validateDiscordAccess(accessToken, userId, expectedGuildId);
    if (!authResult.ok) {
      console.warn('progress_ws:auth_failed', {
        scopeId,
        channelId,
        date,
        userId,
        status: authResult.status,
        error: authResult.error,
      });
      // 502 means Discord itself was unreachable, which is transient — let the client
      // retry it as a normal failed handshake. 401/403 will never succeed with this
      // token, and a browser cannot read the status of a failed WebSocket handshake,
      // so the rejection has to be delivered over an accepted socket instead.
      if (authResult.status === 502) {
        return c.json({ error: authResult.error }, authResult.status);
      }

      return createAuthFailureSocket(authResult.status);
    }

    console.log('progress_ws:auth_ok', {
      scopeId,
      channelId,
      date,
      userId,
    });

    const room = c.env.PROGRESS_ROOMS.getByName(scopeId);
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-progress-user-id', userId);
    headers.set('x-progress-scope-id', scopeId);
    headers.set('x-progress-channel-id', channelId);
    headers.set('x-progress-date', date);
    headers.set('x-progress-profile', encodeURIComponent(JSON.stringify(authResult.profile)));

    return room.fetch(new Request(c.req.raw, { headers }));
  });

  app.get('/connections/:date', async (c) => {
    const date = c.req.param('date');
    if (!isValidPuzzleDate(date)) {
      return c.json({ error: 'Invalid puzzle date' }, 400);
    }

    const data = await getPuzzleData(c.env, date);
    if (!data) {
      return c.json({ error: 'Unable to load puzzle' }, 502);
    }

    return c.json(data, 200, {
      'Cache-Control': 'public, max-age=86400',
    });
  });

  app.post('/token', async (c) => {
    const { code } = await c.req.json().catch(() => undefined);
    if (!code || typeof code !== 'string') {
      return c.json({ error: 'Invalid code' }, 400);
    }

    const tokenResult = await exchangeDiscordCode(c.env, code);
    if (!tokenResult.ok) {
      return c.json({ error: tokenResult.error }, tokenResult.status);
    }

    return c.json(tokenResult.data);
  });
}

/**
 * Accepts the WebSocket purely to report why it cannot be used, then closes it.
 *
 * Both signals are sent because neither is fully reliable on its own: a custom close
 * code has to survive Discord's activity proxy, and a message frame has to arrive
 * before the close is processed.
 */
function createAuthFailureSocket(status: 401 | 403) {
  const pair = new WebSocketPair();
  const server = pair[1];

  server.accept();
  server.send(JSON.stringify({ type: 'error', code: 'auth' }));
  server.close(status === 401 ? WS_CLOSE_UNAUTHENTICATED : WS_CLOSE_FORBIDDEN, 'Authentication failed');

  return new Response(null, {
    status: 101,
    webSocket: pair[0],
  });
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
