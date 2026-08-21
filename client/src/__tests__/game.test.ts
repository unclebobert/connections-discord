import { describe, expect, it } from 'vitest'
import {
  buildCards,
  buildCardsForSolvedCategories,
  getVictoryMessage,
  hasGuessed,
  isOneAway,
  MAX_MISTAKES,
  shuffleCards,
  summarizeProgress,
  toPlayerGuess,
} from '../game'
import { categories, correctGuess, wrongGuess } from './fixtures'

describe('buildCards', () => {
  it('orders every card by board position and tags its category', () => {
    const cards = buildCards(categories)

    expect(cards).toHaveLength(16)
    expect(cards.map((card) => card.position)).toEqual([...Array(16).keys()])
    // Position 5 belongs to category 0 in the fixture's interleaved layout.
    expect(cards[5].categoryIndex).toBe(0)
    expect(cards[5].id).toBe('0-5-C0-5')
  })
})

describe('shuffleCards', () => {
  it('preserves every card and leaves the input untouched', () => {
    const cards = buildCards(categories)
    const shuffled = shuffleCards(cards)

    expect(shuffled).toHaveLength(cards.length)
    expect([...shuffled].sort((a, b) => a.position - b.position)).toEqual(
      [...cards].sort((a, b) => a.position - b.position),
    )
    expect(cards.map((card) => card.id)).toEqual(buildCards(categories).map((card) => card.id))
  })
})

describe('buildCardsForSolvedCategories', () => {
  it('lifts a solved category into the top row', () => {
    const cards = buildCardsForSolvedCategories(categories, [2])

    expect(cards.slice(0, 4).every((card) => card.categoryIndex === 2)).toBe(true)
  })

  it('stacks each additional solved category below the previous one', () => {
    const cards = buildCardsForSolvedCategories(categories, [2, 0])

    expect(cards.slice(0, 4).every((card) => card.categoryIndex === 2)).toBe(true)
    expect(cards.slice(4, 8).every((card) => card.categoryIndex === 0)).toBe(true)
    expect(cards).toHaveLength(16)
  })
})

describe('isOneAway', () => {
  it('is true when exactly three cards share a category', () => {
    const cards = buildCards(categories)
    const byPosition = (position: number) => cards.find((card) => card.position === position)!

    expect(isOneAway([byPosition(0), byPosition(5), byPosition(10), byPosition(1)])).toBe(true)
    expect(isOneAway([byPosition(0), byPosition(5), byPosition(10), byPosition(15)])).toBe(false)
    expect(isOneAway([byPosition(0), byPosition(5), byPosition(1), byPosition(6)])).toBe(false)
  })
})

describe('toPlayerGuess', () => {
  it('rejects selections that are not exactly four cards', () => {
    const cards = buildCards(categories)

    expect(toPlayerGuess(cards.slice(0, 3))).toBeNull()
    expect(toPlayerGuess(cards.slice(0, 5))).toBeNull()
    expect(toPlayerGuess(cards.slice(0, 4))).toEqual([0, 1, 2, 3])
  })
})

describe('hasGuessed', () => {
  it('matches regardless of the order the cards were selected in', () => {
    expect(hasGuessed([[0, 1, 2, 3]], [3, 2, 1, 0])).toBe(true)
    expect(hasGuessed([[0, 1, 2, 3]], [0, 1, 2, 4])).toBe(false)
    expect(hasGuessed([], [0, 1, 2, 3])).toBe(false)
  })
})

describe('getVictoryMessage', () => {
  it('maps mistake counts to their message', () => {
    expect(getVictoryMessage(0)).toBe('Perfect')
    expect(getVictoryMessage(1)).toBe('Great')
    expect(getVictoryMessage(2)).toBe('Solid')
    expect(getVictoryMessage(3)).toBe('Phew')
  })
})

describe('summarizeProgress', () => {
  it('reports an untouched board', () => {
    expect(summarizeProgress([], categories)).toEqual({
      solvedCategories: [],
      mistakesMade: 0,
      isWon: false,
      isGameOver: false,
    })
  })

  it('records solved categories in the order they were found', () => {
    const summary = summarizeProgress([correctGuess(2), correctGuess(0)], categories)

    expect(summary.solvedCategories).toEqual([2, 0])
    expect(summary.mistakesMade).toBe(0)
    expect(summary.isWon).toBe(false)
  })

  it('wins once all four categories are solved', () => {
    const summary = summarizeProgress([0, 1, 2, 3].map(correctGuess), categories)

    expect(summary.isWon).toBe(true)
    expect(summary.isGameOver).toBe(false)
    expect(summary.mistakesMade).toBe(0)
  })

  it('ends the game on the fourth mistake', () => {
    const summary = summarizeProgress([0, 1, 2, 3].map(wrongGuess), categories)

    expect(summary.mistakesMade).toBe(MAX_MISTAKES)
    expect(summary.isGameOver).toBe(true)
    expect(summary.isWon).toBe(false)
  })

  it('ignores anything guessed after the game has already ended', () => {
    const summary = summarizeProgress(
      [...[0, 1, 2, 3].map(wrongGuess), correctGuess(0)],
      categories,
    )

    expect(summary.solvedCategories).toEqual([])
    expect(summary.mistakesMade).toBe(MAX_MISTAKES)
  })

  it('does not count a category twice if it is somehow submitted again', () => {
    const summary = summarizeProgress([correctGuess(1), correctGuess(1)], categories)

    expect(summary.solvedCategories).toEqual([1])
    expect(summary.mistakesMade).toBe(0)
  })
})
