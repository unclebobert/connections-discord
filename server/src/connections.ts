import {
  exchangeDiscordCode,
  validateDiscordAccess,
} from './discord';
import type { App } from './env';

export function registerConnectionsRoutes(app: App) {
  app.get('/ws/:guildId/:date/:userId', async (c) => {
    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Worker expected Upgrade: websocket', {
        status: 426,
      });
    }

    const guildId = c.req.param('guildId');
    const date = c.req.param('date');
    const userId = c.req.param('userId');
    if (!guildId || !date || !userId) {
      return new Response('Missing guildId, date, or userId', {
        status: 400,
      });
    }

    if (!isValidPuzzleDate(date)) {
      return new Response('Invalid date format', {
        status: 400,
      });
    }

    if (isPuzzleDateTooFarFromToday(date)) {
      return new Response('Invalid date', {
        status: 400,
      });
    }

    if (!isDiscordSnowflake(guildId) || !isDiscordSnowflake(userId)) {
      return c.json({ error: 'Invalid guild ID or user ID' }, 400);
    }

    const accessToken = c.req.query('access_token');
    if (!accessToken) {
      return c.json({ error: 'Missing access token' }, 401);
    }

    const authResult = await validateDiscordAccess(accessToken, userId, guildId);
    if (!authResult.ok) {
      return c.json({ error: authResult.error }, authResult.status);
    }

    const room = c.env.PROGRESS_ROOMS.getByName(`${guildId}:${date}`);
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-progress-user-id', userId);
    headers.set('x-progress-guild-id', guildId);
    headers.set('x-progress-date', date);
    headers.set('x-progress-profile', encodeURIComponent(JSON.stringify(authResult.profile)));

    return room.fetch(new Request(c.req.raw, { headers }));
  });

  app.get('/connections/:date', async (c) => {
    const date = c.req.param('date');
    if (!isValidPuzzleDate(date)) {
      return c.json({ error: 'Invalid puzzle date' }, 400);
    }

    let data = await c.env.KV.get(`puzzle:${date}`, { type: 'json', cacheTtl: 86400 });

    if (!data) {
      const response = await fetch(`https://www.nytimes.com/svc/connections/v2/${date}.json`, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return new Response(JSON.stringify({ error: 'Unable to load puzzle' }), {
          status: response.status,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }

      data = await response.json();
      await c.env.KV.put(`puzzle:${date}`, JSON.stringify(data));
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

function isValidPuzzleDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function isPuzzleDateTooFarFromToday(date: string) {
  return Math.abs(Date.now() - Date.parse(date)) > 1000 * 60 * 60 * 24 * 3;
}

function isDiscordSnowflake(value: string) {
  return /^\d{12,24}$/.test(value);
}
