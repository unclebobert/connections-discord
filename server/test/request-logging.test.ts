import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import type { Database } from '../src/db.ts';
import { RoomRegistry } from '../src/rooms.ts';
import { createTestDatabase, TEST_CREDENTIALS } from './helpers.ts';

/**
 * Requests are counted per endpoint by grouping these events on `route`. The label has
 * to be the matched pattern, not the concrete path — grouping on a path that embeds
 * dates and snowflakes fragments the counts into one bucket per request.
 */

type RequestLog = { msg: string; route: string; method: string; status: number };

let db: Database;
let app: ReturnType<typeof createApp>;

function captureRequestLogs() {
  const logs: RequestLog[] = [];
  vi.spyOn(console, 'log').mockImplementation((entry: unknown) => {
    if (typeof entry === 'object' && entry !== null && (entry as RequestLog).msg === 'request') {
      logs.push(entry as RequestLog);
    }
  });
  return logs;
}

beforeEach(() => {
  db = createTestDatabase();
  const config = { ...TEST_CREDENTIALS, publicKey: '0'.repeat(64) };
  app = createApp({ config, db, rooms: new RoomRegistry(db, config) });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('request logging', () => {
  it.each([
    ['/', 'GET', '/'],
    // Every real request carries a different date; they must all count as one route.
    ['/connections/not-a-date', 'GET', '/connections/:date'],
    ['/token', 'POST', '/token'],
    ['/interactions', 'POST', '/interactions'],
    ['/health', 'GET', '/health'],
  ])('labels %s as %s', async (path, method, route) => {
    const logs = captureRequestLogs();

    await app.request(path, { method });

    expect(logs).toHaveLength(1);
    expect(logs[0].route).toBe(route);
    expect(logs[0].method).toBe(method);
  });

  it('collapses unmatched paths into one bucket', async () => {
    const logs = captureRequestLogs();

    const response = await app.request('/wp-admin/setup.php');

    expect(logs[0].route).toBe('unmatched');
    expect(response.status).toBe(404);
  });

  it('records the response status so failures can be filtered out of the counts', async () => {
    const logs = captureRequestLogs();

    await app.request('/connections/not-a-date');

    expect(logs[0].status).toBe(400);
  });
});

describe('health', () => {
  it('reports room and connection counts for external monitoring', async () => {
    const response = await app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, rooms: 0, connections: 0 });
  });
});

describe('interactions', () => {
  it('rejects an unsigned interaction', async () => {
    const response = await app.request('/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 1 }),
    });

    expect(response.status).toBe(401);
  });
});
