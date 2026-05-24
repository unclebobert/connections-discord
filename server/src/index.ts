import { Hono } from 'hono'
import { cors } from 'hono/cors';
import { ProgressRoom } from './session';

type Bindings = {
  VITE_DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET?: string;
  KV: KVNamespace;
  PROGRESS_ROOMS: DurableObjectNamespace<ProgressRoom>;
};

type DiscordUser = {
  id: string;
};

type DiscordGuild = {
  id: string;
};

// NOTE: endpoints should never include /api since all requests starting with
// /api/* will be routed to this server and the prefix gets removed
// i.e. the client should prepend /api before making requests to the server *if in prod*,
// but *in dev* it should make requests directly to the server without the /api prefix
const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

app.get('/', (c) => c.text('Connections Discord Bot Server'))

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

  // Test for date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response('Invalid date format', {
      status: 400,
    });
  } else {
    const today = Date.now();
    const dateObj = Date.parse(date);
    // If the date is more than 3 days in the past or future, reject the request to prevent abuse
    if (Math.abs(today - dateObj) > 1000 * 60 * 60 * 24 * 3) {
      return new Response('Invalid date', {
        status: 400,
      });
    }
  }
  // Test for guildId & userId; should be snowflakes, which is a string of digits
  // technically between 17 and 19 characters long, but larger range to be safe
  if (!/^\d{12,24}$/.test(guildId) || !userId || !/^\d{12,24}$/.test(userId)) {
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

  const clientWebSocket = await room.join(userId);
  return c.newResponse(null, {
    status: 101,
    webSocket: clientWebSocket as unknown as WebSocket,
  });
});

async function validateDiscordAccess(
  accessToken: string,
  expectedUserId: string,
  expectedGuildId: string,
): Promise<{ ok: true } | { ok: false; status: 401 | 403 | 502; error: string }> {
  const userResponse = await fetch('https://discord.com/api/users/@me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (userResponse.status === 401) {
    return { ok: false, status: 401, error: 'Invalid access token' };
  }

  if (!userResponse.ok) {
    return { ok: false, status: 502, error: 'Unable to verify Discord user' };
  }

  const user = await userResponse.json<DiscordUser>();
  if (user.id !== expectedUserId) {
    return { ok: false, status: 403, error: 'Access token does not match user' };
  }

  const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (guildsResponse.status === 401) {
    return { ok: false, status: 401, error: 'Invalid access token' };
  }

  if (!guildsResponse.ok) {
    return { ok: false, status: 502, error: 'Unable to verify Discord guild access' };
  }

  const guilds = await guildsResponse.json<DiscordGuild[]>();
  if (!guilds.some((guild) => guild.id === expectedGuildId)) {
    return { ok: false, status: 403, error: 'User is not a member of this guild' };
  }

  return { ok: true };
}

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
  const clientId = c.env.VITE_DISCORD_CLIENT_ID;
  const clientSecret = c.env.DISCORD_CLIENT_SECRET;
  const missingCredentials = [
    !clientId ? 'VITE_DISCORD_CLIENT_ID' : null,
    !clientSecret ? 'DISCORD_CLIENT_SECRET' : null,
  ].filter((name) => name !== null);

  if (missingCredentials.length > 0) {
    console.error('Discord OAuth credentials are not configured:', missingCredentials);
    return c.json({ error: 'Discord OAuth credentials are not configured' }, 500);
  }

  if (!/^\d{12,24}$/.test(clientId)) {
    console.error('Discord client ID is malformed:', {
      length: clientId.length,
      prefix: clientId.slice(0, 4),
      suffix: clientId.slice(-4),
    });
    return c.json({ error: 'Discord OAuth credentials are malformed' }, 500);
  }

  // Exchange the code for an access_token
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('Discord token exchange failed:', data);
    return c.json({ error: 'Discord token exchange failed' }, response.status as 400 | 401 | 500);
  }

  return c.json(data);
});

export default app

export { ProgressRoom } from './session';
