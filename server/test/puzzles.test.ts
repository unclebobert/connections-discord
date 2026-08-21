import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPuzzleData, resetPuzzleCaches } from '../src/puzzles';

/**
 * KV allows 1,000 writes/day on the free plan — the tightest limit in the system.
 * KV also caches negative lookups for the whole cacheTtl, so a colo that asked before
 * NYT published keeps missing afterwards; without a guard every one of those misses
 * would rewrite the same key.
 */

const puzzle = {
  categories: [
    { cards: [{ position: 0 }, { position: 1 }, { position: 2 }, { position: 3 }] },
  ],
};

const okResponse = () => new Response(JSON.stringify(puzzle), { status: 200 });

beforeEach(() => {
  resetPuzzleCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPuzzleData', () => {
  it('memoises, so a repeat read costs no KV read and no upstream fetch', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const kvGet = vi.spyOn(env.KV, 'get');

    const first = await getPuzzleData(env, '2026-03-01');
    const second = await getPuzzleData(env, '2026-03-01');

    expect(first).toEqual(puzzle);
    expect(second).toEqual(puzzle);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(kvGet).toHaveBeenCalledTimes(1);
  });

  it('writes the puzzle to KV exactly once', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const kvPut = vi.spyOn(env.KV, 'put');

    await getPuzzleData(env, '2026-03-02');

    expect(kvPut).toHaveBeenCalledTimes(1);
    expect(await env.KV.get('puzzle:2026-03-02')).not.toBeNull();
  });

  it('does not write to KV when the puzzle has not been published yet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    const kvPut = vi.spyOn(env.KV, 'put');

    expect(await getPuzzleData(env, '2099-12-31')).toBeNull();
    expect(kvPut).not.toHaveBeenCalled();
  });

  it('serves a cached puzzle from KV without going upstream', async () => {
    await env.KV.put('puzzle:2026-03-03', JSON.stringify(puzzle));
    const upstream = vi.spyOn(globalThis, 'fetch');

    expect(await getPuzzleData(env, '2026-03-03')).toEqual(puzzle);
    expect(upstream).not.toHaveBeenCalled();
  });
});
