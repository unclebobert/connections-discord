import type { Bindings } from './env';

export type PlayerGuess = [number, number, number, number];
export type PlayerProgress = PlayerGuess[];

type GameCategory = {
  cards: Array<{
    position: number;
  }>;
};

export type GameData = {
  categories: GameCategory[];
};

export type ProgressMessageSummary = {
  correctGuesses: number;
  progressCells: Array<number | null>;
};

const MAX_MISTAKES = 4;
const MAX_CACHED_PUZZLES = 8;

// Per-isolate caches. A published puzzle never changes, so memoising it removes a
// billed KV read from every activity message update, and the written-key set stops
// a colo from re-writing the same key on every miss.
const puzzleCache = new Map<string, GameData>();
const writtenPuzzleKeys = new Set<string>();

export async function getPuzzleData(env: Pick<Bindings, 'KV'>, date: string) {
  const cachedPuzzle = puzzleCache.get(date);
  if (cachedPuzzle) {
    return cachedPuzzle;
  }

  const puzzleKey = getPuzzleKey(date);
  let data = await env.KV.get<GameData>(puzzleKey, { type: 'json', cacheTtl: 86400 });

  if (!data) {
    const response = await fetch(`https://www.nytimes.com/svc/connections/v2/${date}.json`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      // Expected whenever a client's local date is ahead of NYT's publication.
      console.warn('puzzle:fetch_failed', { date, status: response.status });
      return null;
    }

    data = await response.json<GameData>();

    // KV caches negative lookups for the whole cacheTtl, so a colo that asked before
    // publication keeps missing afterwards. Writing on each of those misses burns the
    // 1,000 writes/day free allowance, which is the tightest limit in the system.
    if (writtenPuzzleKeys.has(puzzleKey)) {
      console.log('puzzle:kv_put_skipped', { date });
    } else {
      writtenPuzzleKeys.add(puzzleKey);
      console.log('puzzle:kv_put', { date });
      await env.KV.put(puzzleKey, JSON.stringify(data));
    }
  }

  cachePuzzle(date, data);

  return data;
}

function cachePuzzle(date: string, data: GameData) {
  if (puzzleCache.size >= MAX_CACHED_PUZZLES) {
    const oldestDate = puzzleCache.keys().next().value;
    if (oldestDate !== undefined) {
      puzzleCache.delete(oldestDate);
    }
  }

  puzzleCache.set(date, data);
}

export function summarizeProgressForMessage(progress: PlayerProgress, data: GameData): ProgressMessageSummary {
  const positionToCategory = new Map<number, number>();
  data.categories.forEach((category, categoryIndex) => {
    category.cards.forEach((card) => {
      positionToCategory.set(card.position, categoryIndex);
    });
  });

  const solvedCategories = new Set<number>();
  const progressCells: Array<number | null> = [];
  let mistakesMade = 0;

  for (const guess of progress) {
    if (solvedCategories.size >= data.categories.length || mistakesMade >= MAX_MISTAKES) {
      break;
    }

    const categoryIndex = positionToCategory.get(guess[0]);
    if (
      categoryIndex !== undefined &&
      !solvedCategories.has(categoryIndex) &&
      guess.every((position) => positionToCategory.get(position) === categoryIndex)
    ) {
      solvedCategories.add(categoryIndex);
      progressCells.push(categoryIndex);
      continue;
    }

    mistakesMade += 1;
    progressCells.push(null);
  }

  return {
    correctGuesses: solvedCategories.size,
    progressCells,
  };
}

export function isValidPuzzleDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function getPuzzleKey(date: string) {
  return `puzzle:${date}`;
}
