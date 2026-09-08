import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { routePath } from 'hono/route';
import { registerConnectionsRoutes } from './connections.ts';
import type { AppEnv } from './env.ts';
import { handleDiscordInteraction } from './interactions.ts';

const SLOW_REQUEST_MS = 1000;

/**
 * The Hono app is built separately from the server so tests can drive it with
 * `app.request()` without opening a port.
 */
export function createApp(env: AppEnv) {
  const app = new Hono<{ Bindings: AppEnv }>();

  // One event per request, carrying the matched route pattern rather than the concrete
  // path, so requests can be counted per endpoint without the cardinality of dates,
  // snowflakes and scope ids.
  app.use('*', async (c, next) => {
    const startedAt = Date.now();

    try {
      await next();
    } finally {
      const durationMs = Date.now() - startedAt;

      console.log({
        msg: 'request',
        route: getRouteLabel(c),
        method: c.req.method,
        status: c.res.status,
        durationMs,
        isSlow: durationMs > SLOW_REQUEST_MS,
      });
    }
  });

  // Bindings came from the runtime on Workers; here they are injected once.
  app.use('*', async (c, next) => {
    c.env = env;
    await next();
  });

  app.use('*', cors());
  app.get('/', (c) => c.text('Connections Discord Bot Server'));
  app.get('/health', (c) => c.json({
    ok: true,
    rooms: env.rooms.size,
    connections: env.rooms.connectionCount,
    uptimeSeconds: Math.round(process.uptime()),
  }));
  app.post('/interactions', handleDiscordInteraction);

  registerConnectionsRoutes(app);

  return app;
}

function getRouteLabel(c: Context<{ Bindings: AppEnv }>) {
  try {
    // A request that matches no route still runs the catch-all middleware, so it
    // reports that middleware's own pattern. Name it, rather than leaving '/*' to be
    // decoded in a dashboard.
    const matchedRoute = routePath(c);
    return !matchedRoute || matchedRoute === '/*' ? 'unmatched' : matchedRoute;
  } catch {
    return 'unmatched';
  }
}
