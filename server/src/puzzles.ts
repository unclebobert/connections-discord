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

export async function getPuzzleData(env: Pick<Bindings, 'KV'>, date: string) {
  let data = await env.KV.get<GameData>(getPuzzleKey(date), { type: 'json', cacheTtl: 86400 });

  if (!data) {
    const response = await fetch(`https://www.nytimes.com/svc/connections/v2/${date}.json`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    data = await response.json<GameData>();
    await env.KV.put(getPuzzleKey(date), JSON.stringify(data));
  }

  return data;
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

export function getCurrentPuzzleDate() {
  return new Date().toISOString().slice(0, 10);
}

function getPuzzleKey(date: string) {
  return `puzzle:${date}`;
}
