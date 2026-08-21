import { describe, expect, it } from 'vitest'
import { summarizeProgress } from '../game'
import { categories } from './fixtures'
import { SUMMARY_VECTORS } from './progress-summary-spec'
import type { PlayerProgress } from '../lib'

describe('summarizeProgress matches the shared spec', () => {
  it.each(SUMMARY_VECTORS)('$name', ({ guesses, solvedInOrder, mistakes }) => {
    const summary = summarizeProgress(guesses as PlayerProgress, categories)

    expect(summary.solvedCategories).toEqual(solvedInOrder)
    expect(summary.mistakesMade).toBe(mistakes)
    expect(summary.isWon).toBe(solvedInOrder.length === categories.length)
    expect(summary.isGameOver).toBe(mistakes >= 4)
  })
})
