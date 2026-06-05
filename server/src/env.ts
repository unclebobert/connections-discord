import type { Hono } from 'hono';
import type { ProgressRoom } from './session';

export type Bindings = {
  VITE_DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_PUBLIC_KEY: string;
  KV: KVNamespace;
  PROGRESS_ROOMS: DurableObjectNamespace<ProgressRoom>;
};

export type App = Hono<{ Bindings: Bindings }>;
