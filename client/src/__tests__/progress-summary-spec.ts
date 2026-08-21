/**
 * Golden vectors for the progress-summary rules.
 *
 * These rules are implemented twice — `summarizeProgress` in client/src/game.ts for
 * the in-Activity board, and `summarizeProgressForMessage` in server/src/puzzles.ts
 * for the Discord launch message — in separate code that can silently drift. A
 * shared import is not possible: each package's TypeScript program lacks the other's
 * ambient types (Workers runtime one way, `vite/client` the other). So this table is
 * mirrored in server/test/progress-summary-spec.ts instead, and both suites assert
 * their own implementation against it.
 *
 * KEEP THE TWO COPIES IDENTICAL.
 */
export const CATEGORY_POSITIONS: number[][] = [
  [0, 5, 10, 15],
  [1, 6, 11, 12],
  [2, 7, 8, 13],
  [3, 4, 9, 14],
]

export type SummaryVector = {
  name: string
  guesses: number[][]
  solvedInOrder: number[]
  mistakes: number
}

const c = (categoryIndex: number) => CATEGORY_POSITIONS[categoryIndex]
// One position from each category, so it can never resolve to a single category.
const w = (seed: number) => [0, 1, 2, [3, 4, 6, 7, 9][seed]]

export const SUMMARY_VECTORS: SummaryVector[] = [
  { name: 'an untouched board', guesses: [], solvedInOrder: [], mistakes: 0 },
  { name: 'a single correct guess', guesses: [c(0)], solvedInOrder: [0], mistakes: 0 },
  { name: 'a single mistake', guesses: [w(0)], solvedInOrder: [], mistakes: 1 },
  {
    name: 'a mixed run',
    guesses: [w(0), c(2), w(1), c(0)],
    solvedInOrder: [2, 0],
    mistakes: 2,
  },
  {
    name: 'a perfect win',
    guesses: [c(0), c(1), c(2), c(3)],
    solvedInOrder: [0, 1, 2, 3],
    mistakes: 0,
  },
  {
    name: 'a loss on four mistakes',
    guesses: [w(0), w(1), w(2), w(3)],
    solvedInOrder: [],
    mistakes: 4,
  },
  {
    name: 'guesses submitted after the game ended are ignored',
    guesses: [w(0), w(1), w(2), w(3), c(0)],
    solvedInOrder: [],
    mistakes: 4,
  },
  {
    name: 'a win on the final allowed mistake',
    guesses: [w(0), c(0), w(1), c(1), w(2), c(2), c(3)],
    solvedInOrder: [0, 1, 2, 3],
    mistakes: 3,
  },
  {
    // Regression: the server previously folded the already-solved check into its
    // correctness test, so a repeat fell through to the mistake branch and rendered
    // a phantom incorrect cell that the player's own board never showed.
    name: 'the same category solved twice is a no-op, not a mistake',
    guesses: [c(1), c(1)],
    solvedInOrder: [1],
    mistakes: 0,
  },
]
