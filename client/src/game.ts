import type { GameCategory, PlayerGuess, PlayerProgress } from './lib'

export const MAX_MISTAKES = 4

export const categoryColors = [
  'category-yellow',
  'category-green',
  'category-blue',
  'category-purple',
]

export interface PlayCard {
  id: string
  content: string
  position: number
  categoryIndex: number
}

export interface ProgressSummary {
  solvedCategories: number[]
  mistakesMade: number
  isWon: boolean
  isGameOver: boolean
}

export function buildCards(categories: GameCategory[]) {
  return categories
    .flatMap((category, categoryIndex) =>
      category.cards.map((card) => ({
        ...card,
        categoryIndex,
        id: getCardId(categoryIndex, card),
      })),
    )
    .sort((a, b) => a.position - b.position)
}

export function shuffleCards(cards: PlayCard[]) {
  const shuffled = [...cards]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    const current = shuffled[index]
    shuffled[index] = shuffled[randomIndex]
    shuffled[randomIndex] = current
  }

  return shuffled
}

export function formatPuzzleDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

export function getVictoryMessage(mistakesMade: number) {
  if (mistakesMade === 0) {
    return 'Perfect'
  }

  if (mistakesMade === 1) {
    return 'Great'
  }

  if (mistakesMade === 2) {
    return 'Solid'
  }

  return 'Phew'
}

export function getCardId(categoryIndex: number, card: GameCategory['cards'][number]) {
  return `${categoryIndex}-${card.position}-${card.content}`
}

export function swapCategoryCardsToTopRow(
  cards: PlayCard[],
  category: GameCategory,
  categoryIndex: number,
  solvedCategories: number[],
) {
  const reorderedCards = [...cards]
  const solvedSet = new Set(solvedCategories)
  const unsolvedIndexes = reorderedCards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => !solvedSet.has(card.categoryIndex))
    .map(({ index }) => index)

  category.cards.forEach((card, targetOffset) => {
    const targetIndex = unsolvedIndexes[targetOffset]
    const cardId = getCardId(categoryIndex, card)
    const currentIndex = reorderedCards.findIndex((boardCard) => boardCard.id === cardId)

    if (targetIndex === undefined || currentIndex === -1 || currentIndex === targetIndex) {
      return
    }

    const targetCard = reorderedCards[targetIndex]
    reorderedCards[targetIndex] = reorderedCards[currentIndex]
    reorderedCards[currentIndex] = targetCard
  })

  return reorderedCards
}

export function buildCardsForSolvedCategories(categories: GameCategory[], solvedCategories: number[]) {
  return solvedCategories.reduce(
    (cards, categoryIndex, solvedIndex) =>
      swapCategoryCardsToTopRow(
        cards,
        categories[categoryIndex],
        categoryIndex,
        solvedCategories.slice(0, solvedIndex),
      ),
    buildCards(categories),
  )
}

export function isOneAway(cards: PlayCard[]) {
  const counts = cards.reduce<Record<number, number>>((accumulator, card) => {
    accumulator[card.categoryIndex] = (accumulator[card.categoryIndex] ?? 0) + 1
    return accumulator
  }, {})

  return Object.values(counts).some((count) => count === 3)
}

export function toPlayerGuess(cards: PlayCard[]): PlayerGuess | null {
  if (cards.length !== 4) {
    return null
  }

  return cards.map((card) => card.position) as PlayerGuess
}

export function summarizeProgress(progress: PlayerProgress, categories: GameCategory[]): ProgressSummary {
  const positionToCategory = getPositionCategoryMap(categories)
  const solvedSet = new Set<number>()
  const solvedCategories: number[] = []
  let mistakesMade = 0

  for (const guess of progress) {
    if (solvedCategories.length === categories.length || mistakesMade >= MAX_MISTAKES) {
      break
    }

    const categoryIndex = getGuessCategory(guess, positionToCategory)

    if (categoryIndex === null) {
      mistakesMade += 1
      continue
    }

    if (!solvedSet.has(categoryIndex)) {
      solvedSet.add(categoryIndex)
      solvedCategories.push(categoryIndex)
    }
  }

  return {
    solvedCategories,
    mistakesMade,
    isWon: solvedCategories.length === categories.length,
    isGameOver: mistakesMade >= MAX_MISTAKES,
  }
}

function getPositionCategoryMap(categories: GameCategory[]) {
  const positions = new Map<number, number>()

  categories.forEach((category, categoryIndex) => {
    category.cards.forEach((card) => {
      positions.set(card.position, categoryIndex)
    })
  })

  return positions
}

function getGuessCategory(guess: PlayerGuess, positionToCategory: Map<number, number>) {
  const categoryIndex = positionToCategory.get(guess[0])

  if (categoryIndex === undefined) {
    return null
  }

  return guess.every((position) => positionToCategory.get(position) === categoryIndex)
    ? categoryIndex
    : null
}
