import { describe, expect, it } from 'vitest';
import { summarizeProgressForMessage, type PlayerProgress } from '../src/puzzles.ts';
import { CATEGORY_POSITIONS, SUMMARY_VECTORS } from './progress-summary-spec.ts';

const data = {
  categories: CATEGORY_POSITIONS.map((positions) => ({
    cards: positions.map((position) => ({ position })),
  })),
};

describe('summarizeProgressForMessage matches the shared spec', () => {
  it.each(SUMMARY_VECTORS)('$name', ({ guesses, solvedInOrder, mistakes }) => {
    const summary = summarizeProgressForMessage(guesses as PlayerProgress, data);

    expect(summary.correctGuesses).toBe(solvedInOrder.length);
    expect(summary.progressCells.filter((cell) => cell !== null)).toEqual(solvedInOrder);
    expect(summary.progressCells.filter((cell) => cell === null)).toHaveLength(mistakes);
  });
});
