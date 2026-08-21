import type { GameCategory, PlayerGuess } from '../lib'

// Positions are deliberately interleaved rather than 0-3 / 4-7 / ... so that tests
// cannot pass by accidentally relying on contiguous category blocks, which is not
// how the NYT payload is laid out.
export const CATEGORY_POSITIONS: number[][] = [
  [0, 5, 10, 15],
  [1, 6, 11, 12],
  [2, 7, 8, 13],
  [3, 4, 9, 14],
]

export const categories: GameCategory[] = CATEGORY_POSITIONS.map((positions, categoryIndex) => ({
  title: `Category ${categoryIndex}`,
  cards: positions.map((position) => ({ content: `C${categoryIndex}-${position}`, position })),
}))

export const correctGuess = (categoryIndex: number) =>
  [...CATEGORY_POSITIONS[categoryIndex]] as unknown as PlayerGuess

// One position drawn from each category, so it can never be correct.
export const wrongGuess = (seed: number) =>
  [0, 1, 2, [3, 4, 6, 7, 9][seed]] as unknown as PlayerGuess
