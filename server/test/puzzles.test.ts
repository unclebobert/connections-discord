import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db.ts';
import { getPuzzleData, resetPuzzleCaches } from '../src/puzzles.ts';

const puzzle = {
  categories: [
    { cards: [{ position: 0 }, { position: 1 }, { position: 2 }, { position: 3 }] },
  ],
};

const okResponse = () => new Response(JSON.stringify(puzzle), { status: 200 });

let db: Database;

beforeEach(() => {
  resetPuzzleCaches();
  db = new Database(':memory:');
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('getPuzzleData', () => {
  it('memoises, so a repeat read touches neither storage nor the network', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());

    expect(await getPuzzleData(db, '2026-03-01')).toEqual(puzzle);
    expect(await getPuzzleData(db, '2026-03-01')).toEqual(puzzle);

    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('persists a fetched puzzle so a restart does not refetch it', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    await getPuzzleData(db, '2026-03-02');
    expect(upstream).toHaveBeenCalledTimes(1);

    // Dropping the in-process cache is what a restart looks like. A published puzzle
    // never changes, so the stored copy is always current.
    resetPuzzleCaches();
    upstream.mockClear();

    expect(await getPuzzleData(db, '2026-03-02')).toEqual(puzzle);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('stores nothing when the puzzle has not been published yet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));

    expect(await getPuzzleData(db, '2099-12-31')).toBeNull();
    expect(db.all('SELECT date FROM puzzles;')).toEqual([]);
  });

  it('survives a corrupted stored row by refetching', async () => {
    db.run('INSERT INTO puzzles (date, data, fetched_at) VALUES (?, ?, ?);', '2026-03-03', '{not json', Date.now());
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());

    expect(await getPuzzleData(db, '2026-03-03')).toEqual(puzzle);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
