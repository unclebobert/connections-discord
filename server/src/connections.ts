import {
  exchangeDiscordCode,
  validateDiscordAccess,
} from './discord';
import type { App } from './env';
import { getPuzzleData, isValidPuzzleDate } from './puzzles';

export function registerConnectionsRoutes(app: App) {
  app.get('/ws/:guildId/:channelId/:date/:userId', async (c) => {
    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Worker expected Upgrade: websocket', {
        status: 426,
      });
    }

    const guildId = c.req.param('guildId');
    const channelId = c.req.param('channelId');
    const date = c.req.param('date');
    const userId = c.req.param('userId');
    console.log('progress_ws:request', {
      guildId,
      channelId,
      date,
      userId,
    });

    if (!guildId || !channelId || !date || !userId) {
      console.warn('progress_ws:missing_params');
      return new Response('Missing guildId, channelId, date, or userId', {
        status: 400,
      });
    }

    if (!isValidPuzzleDate(date)) {
      console.warn('progress_ws:invalid_date_format', { guildId, channelId, date, userId });
      return new Response('Invalid date format', {
        status: 400,
      });
    }

    if (isPuzzleDateTooFarFromToday(date)) {
      console.warn('progress_ws:invalid_date_range', { guildId, channelId, date, userId });
      return new Response('Invalid date', {
        status: 400,
      });
    }

    if (!isDiscordSnowflake(guildId) || !isDiscordSnowflake(channelId) || !isDiscordSnowflake(userId)) {
      console.warn('progress_ws:invalid_snowflake', { guildId, channelId, date, userId });
      return c.json({ error: 'Invalid guild ID, channel ID, or user ID' }, 400);
    }

    const accessToken = c.req.query('access_token');
    if (!accessToken) {
      console.warn('progress_ws:missing_access_token', { guildId, channelId, date, userId });
      return c.json({ error: 'Missing access token' }, 401);
    }

    const authResult = await validateDiscordAccess(accessToken, userId, guildId);
    if (!authResult.ok) {
      console.warn('progress_ws:auth_failed', {
        guildId,
        channelId,
        date,
        userId,
        status: authResult.status,
        error: authResult.error,
      });
      return c.json({ error: authResult.error }, authResult.status);
    }

    console.log('progress_ws:auth_ok', {
      guildId,
      channelId,
      date,
      userId,
    });

    const room = c.env.PROGRESS_ROOMS.getByName(`${guildId}:${date}`);
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-progress-user-id', userId);
    headers.set('x-progress-guild-id', guildId);
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

function isPuzzleDateTooFarFromToday(date: string) {
  return Math.abs(Date.now() - Date.parse(date)) > 1000 * 60 * 60 * 24 * 3;
}

function isDiscordSnowflake(value: string) {
  return /^\d{12,24}$/.test(value);
}
