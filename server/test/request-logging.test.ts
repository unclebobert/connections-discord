import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Worker requests are counted per endpoint by grouping these events on `route`. The
 * label has to be the matched pattern, not the concrete path — grouping on a path that
 * embeds dates, snowflakes and scope ids fragments /ws into one bucket per user and
 * makes the query useless.
 */

type RequestLog = { msg: string; route: string; method: string; status: number };

function captureRequestLogs() {
  const logs: RequestLog[] = [];
  vi.spyOn(console, 'log').mockImplementation((entry: unknown) => {
    if (typeof entry === 'object' && entry !== null && (entry as RequestLog).msg === 'request') {
      logs.push(entry as RequestLog);
    }
  });
  return logs;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request logging', () => {
  it.each([
    ['https://example.com/', 'GET', '/'],
    // Every real request carries a different date, but they must all count as one route.
    ['https://example.com/connections/not-a-date', 'GET', '/connections/:date'],
    ['https://example.com/token', 'POST', '/token'],
    ['https://example.com/interactions', 'POST', '/interactions'],
    [
      'https://example.com/ws/guild:111111111111/222222222222/2026-08-20/333333333333',
      'GET',
      '/ws/:scopeId/:channelId/:date/:userId',
    ],
  ])('labels %s as %s', async (url, method, route) => {
    const logs = captureRequestLogs();

    await exports.default.fetch(new Request(url, { method }));

    expect(logs).toHaveLength(1);
    expect(logs[0].route).toBe(route);
    expect(logs[0].method).toBe(method);
  });

  it('collapses unmatched paths into one bucket', async () => {
    const logs = captureRequestLogs();

    // Scanner traffic against the workers.dev hostname lands here.
    await exports.default.fetch(new Request('https://example.com/wp-admin/setup.php'));

    expect(logs).toHaveLength(1);
    expect(logs[0].route).toBe('unmatched');
    expect(logs[0].status).toBe(404);
  });

  it('records the response status so failures can be filtered out of the counts', async () => {
    const logs = captureRequestLogs();

    await exports.default.fetch(new Request('https://example.com/connections/not-a-date'));

    expect(logs[0].status).toBe(400);
  });
});
