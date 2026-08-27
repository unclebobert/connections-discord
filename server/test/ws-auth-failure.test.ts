import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WS_CLOSE_FORBIDDEN, WS_CLOSE_UNAUTHENTICATED } from '../src/connections';

/**
 * A rejected token has to be reported over an accepted socket. Returning a 401/403 to
 * a WebSocket upgrade is invisible to a browser — it surfaces as a generic failed
 * handshake, indistinguishable from a network drop — so the client would retry a token
 * that can never work. That matters now that tokens are cached for a week.
 */

const WS_URL =
  'https://example.com/ws/guild:111111111111/222222222222/2026-08-28/333333333333?access_token=stale';

function upgradeRequest() {
  return new Request(WS_URL, { headers: { Upgrade: 'websocket' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('websocket auth rejection', () => {
  it('reports an invalid token over the socket instead of failing the handshake', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    const response = await exports.default.fetch(upgradeRequest());

    expect(response.status).toBe(101);

    const client = response.webSocket!;
    const frames: string[] = [];
    let closeCode: number | undefined;
    client.addEventListener('message', (event) => {
      frames.push(String(event.data));
    });
    client.addEventListener('close', (event) => {
      closeCode = event.code;
    });
    client.accept();

    await vi.waitFor(() => expect(closeCode).toBeDefined(), { timeout: 3000 });

    // Both signals, because a custom close code may not survive Discord's proxy.
    expect(frames).toContain(JSON.stringify({ type: 'error', code: 'auth' }));
    expect(closeCode).toBe(WS_CLOSE_UNAUTHENTICATED);
  });

  it('distinguishes a token that is valid but not permitted here', async () => {
    // Discord accepts the token, but it belongs to someone outside this guild — the
    // shape an account switch on a shared machine takes.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/users/@me')) {
        return new Response(JSON.stringify({ id: '333333333333', username: 'ada' }), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: '999999999999' }]), { status: 200 });
    });

    const response = await exports.default.fetch(upgradeRequest());
    const client = response.webSocket!;
    let closeCode: number | undefined;
    client.addEventListener('close', (event) => {
      closeCode = event.code;
    });
    client.accept();

    await vi.waitFor(() => expect(closeCode).toBeDefined(), { timeout: 3000 });

    expect(closeCode).toBe(WS_CLOSE_FORBIDDEN);
  });

  it('leaves a transient Discord outage as a retryable failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    const response = await exports.default.fetch(upgradeRequest());

    // Not an accepted socket: the client should back off and retry, not give up.
    expect(response.status).toBe(502);
    expect(response.webSocket).toBeNull();
  });
});
