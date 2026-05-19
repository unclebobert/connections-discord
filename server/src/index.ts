import { Hono } from 'hono'

type Bindings = {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// NOTE: endpoints should never include /api since discord routes all requests
// to /api/* to this server and removes the prefix
// i.e. the client should always prepend /api before making requests to the server,
// but the server should not include /api in its routes
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
