import type { Database } from './db.ts';

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

// A published puzzle never changes, so memoising it keeps the activity-message update
// path off the database entirely.
const puzzleCache = new Map<string, GameData>();

export async function getPuzzleData(db: Database, date: string) {
  const cachedPuzzle = puzzleCache.get(date);
  if (cachedPuzzle) {
    return cachedPuzzle;
  }

  let data = readStoredPuzzle(db, date);

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

    data = await response.json() as GameData;

    db.run(`
      INSERT INTO puzzles (date, data, fetched_at)
      VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at;
    `, date, JSON.stringify(data), Date.now());
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
      guess.every((position) => positionToCategory.get(position) === categoryIndex)
    ) {
      // Re-solving a category is a no-op, not a mistake. Folding the already-solved
      // check into the correctness test above would drop such a guess into the
      // mistake branch and render a phantom incorrect cell in the Discord grid,
      // disagreeing with the player's own board.
      if (!solvedCategories.has(categoryIndex)) {
        solvedCategories.add(categoryIndex);
        progressCells.push(categoryIndex);
      }
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

/**
 * Clears the per-isolate caches. Tests share a module instance with the Worker, so
 * without this the caches leak between cases and make them order-dependent.
 */
export function resetPuzzleCaches() {
  puzzleCache.clear();
}

function readStoredPuzzle(db: Database, date: string): GameData | null {
  const row = db.all<{ data: string }>('SELECT data FROM puzzles WHERE date = ?;', date)[0];
  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.data) as GameData;
  } catch {
    return null;
  }
}
