import { Hono } from 'hono'
import { cors } from 'hono/cors';

import { KVNamespace } from '@cloudflare/workers-types';

type Bindings = {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  KV: KVNamespace;
};

// NOTE: endpoints should never include /api since all requests starting with
// /api/* will be routed to this server and the prefix gets removed
// i.e. the client should prepend /api before making requests to the server *if in prod*,
// but *in dev* it should make requests directly to the server without the /api prefix
const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

app.get('/', (c) => c.text('Connections Discord Bot Server'))

app.get('/connections/:date', async (c) => {
  const date = c.req.param('date');
  // Check date validity
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Invalid puzzle date' }, 400);
  }

  // Check if puzzle data is cached in KV
  let data = await c.env.KV.get(`puzzle:${date}`, { type: 'json', cacheTtl: 300 });

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
    'Cache-Control': 'public, max-age=300'
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
