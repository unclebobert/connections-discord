import type { Hono } from 'hono';
import type { Database } from './db.ts';
import type { DiscordCredentials } from './discord.ts';
import type { RoomRegistry } from './rooms.ts';

/** Credentials plus the interaction-verification key; usable directly as DiscordCredentials. */
export type AppConfig = DiscordCredentials & {
  publicKey: string;
};

/** Replaces the Workers `Bindings`: plain process-local dependencies. */
export type AppEnv = {
  config: AppConfig;
  db: Database;
  rooms: RoomRegistry;
};

export type App = Hono<{ Bindings: AppEnv }>;

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    clientId: process.env.VITE_DISCORD_CLIENT_ID ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET ?? '',
    publicKey: process.env.DISCORD_PUBLIC_KEY ?? '',
  };

  const missingByEnvVar: Record<keyof AppConfig, string> = {
    clientId: 'VITE_DISCORD_CLIENT_ID',
    clientSecret: 'DISCORD_CLIENT_SECRET',
    publicKey: 'DISCORD_PUBLIC_KEY',
  };
  const missing = (Object.keys(config) as Array<keyof AppConfig>)
    .filter((key) => config[key] === '')
    .map((key) => missingByEnvVar[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return config;
}
