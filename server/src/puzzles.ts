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

export function countCorrectGuesses(progress: PlayerProgress, data: GameData) {
  const positionToCategory = new Map<number, number>();
  data.categories.forEach((category, categoryIndex) => {
    category.cards.forEach((card) => {
      positionToCategory.set(card.position, categoryIndex);
    });
  });

  const solvedCategories = new Set<number>();
  for (const guess of progress) {
    const categoryIndex = positionToCategory.get(guess[0]);
    if (
      categoryIndex !== undefined &&
      !solvedCategories.has(categoryIndex) &&
      guess.every((position) => positionToCategory.get(position) === categoryIndex)
    ) {
      solvedCategories.add(categoryIndex);
    }
  }

  return solvedCategories.size;
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
