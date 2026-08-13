import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerConnectionsRoutes } from './connections';
import type { Bindings } from './env';
import { handleDiscordInteraction } from './interactions';

const SLOW_REQUEST_MS = 1000;

const app = new Hono<{ Bindings: Bindings }>();

// Only failures and slow requests are logged. A start/end pair on every request
// was the single largest contributor to the Workers Logs daily event budget, and
// the healthy-request case is already covered by the Workers request metrics.
app.use('*', async (c, next) => {
  const startedAt = Date.now();

  try {
    await next();
  } finally {
    const durationMs = Date.now() - startedAt;
    const status = c.res.status;

    if (status >= 400 || durationMs > SLOW_REQUEST_MS) {
      console.log('request:end', {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status,
        durationMs,
        rayId: c.req.header('cf-ray') ?? null,
      });
    }
  }
});

app.use('*', cors());
app.get('/', (c) => c.text('Connections Discord Bot Server'));
app.post('/interactions', handleDiscordInteraction);

registerConnectionsRoutes(app);

export default app;

export { ProgressRoom } from './session';
