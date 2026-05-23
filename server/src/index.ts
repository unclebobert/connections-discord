import { Hono } from 'hono'
import { cors } from 'hono/cors';
import { ProgressRoom } from './session';

type Bindings = {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  KV: KVNamespace;
  PROGRESS_ROOMS: DurableObjectNamespace<ProgressRoom>;
};

// NOTE: endpoints should never include /api since all requests starting with
// /api/* will be routed to this server and the prefix gets removed
// i.e. the client should prepend /api before making requests to the server *if in prod*,
// but *in dev* it should make requests directly to the server without the /api prefix
const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

app.get('/', (c) => c.text('Connections Discord Bot Server'))

app.get('/ws/:guildId/:date', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Worker expected Upgrade: websocket', {
      status: 426,
    });
  }

  const guildId = c.req.param('guildId');
  const date = c.req.param('date');
  const userId = c.req.query('userId');
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
  const room = c.env.PROGRESS_ROOMS.getByName(`${guildId}:${date}`);

  const clientWebSocket = await room.join(userId);
  return c.newResponse(null, {
    status: 101,
    webSocket: clientWebSocket as unknown as WebSocket,
  });
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

export { ProgressRoom } from './session';
