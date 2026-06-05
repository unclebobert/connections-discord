import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerConnectionsRoutes } from './connections';
import type { Bindings } from './env';
import { handleDiscordInteraction } from './interactions';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());
app.get('/', (c) => c.text('Connections Discord Bot Server'));
app.post('/interactions', handleDiscordInteraction);

registerConnectionsRoutes(app);

export default app;

export { ProgressRoom } from './session';
