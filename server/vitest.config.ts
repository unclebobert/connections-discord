import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// wrangler validates the `secrets.required` block in wrangler.jsonc at startup and
// warns once per missing entry. These are placeholders, not credentials — nothing in
// the suite authenticates against Discord.
process.env.VITE_DISCORD_CLIENT_ID ??= '000000000000000000';
process.env.DISCORD_CLIENT_SECRET ??= 'test-client-secret';
process.env.DISCORD_PUBLIC_KEY ??= '0'.repeat(64);

export default defineConfig({
  plugins: [
    // Bindings, the SQLite migration and the ProgressRoom class all come from the real
    // Wrangler config, so tests exercise the deployed topology rather than a
    // hand-maintained copy of it.
    cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
