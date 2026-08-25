import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { routePath } from 'hono/route';
import { registerConnectionsRoutes } from './connections';
import type { Bindings } from './env';
import { handleDiscordInteraction } from './interactions';

const SLOW_REQUEST_MS = 1000;

const app = new Hono<{ Bindings: Bindings }>();

// One event per request, carrying the matched route pattern rather than the concrete
// path, so requests can be counted per endpoint without the cardinality of dates,
// snowflakes and scope ids. Unmatched paths collapse into a single bucket, which is
// what scanner traffic against the workers.dev hostname looks like. Worker fetch
// invocations are thinned by observability.logs.head_sampling_rate, so this stays
// cheap; count and scale by the inverse of that rate.
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

app.use('*', cors());
app.get('/', (c) => c.text('Connections Discord Bot Server'));
app.post('/interactions', handleDiscordInteraction);

registerConnectionsRoutes(app);

export default app;

export { ProgressRoom } from './session';

function getRouteLabel(c: Context<{ Bindings: Bindings }>) {
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
