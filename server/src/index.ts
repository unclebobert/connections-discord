import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerConnectionsRoutes } from './connections';
import type { Bindings } from './env';
import { handleDiscordInteraction } from './interactions';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
  const startedAt = Date.now();
  const url = new URL(c.req.url);
  const rayId = c.req.header('cf-ray') ?? null;

  console.log('request:start', {
    method: c.req.method,
    path: url.pathname,
    rayId,
  });

  try {
    await next();
  } finally {
    console.log('request:end', {
      method: c.req.method,
      path: url.pathname,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
      rayId,
    });
  }
});

app.use('*', cors());
app.get('/', (c) => c.text('Connections Discord Bot Server'));
app.post('/interactions', handleDiscordInteraction);

registerConnectionsRoutes(app);

export default app;

export { ProgressRoom } from './session';
