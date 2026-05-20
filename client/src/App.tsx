import { useEffect, useMemo, useState } from 'react'
import connectionsLogo from './assets/connections.svg'
import './App.css'

import { type GameCategory, type PlayCard, type GameData, API_BASE_URL } from './lib'


const MAX_MISTAKES = 4

const categoryColors = [
  'category-yellow',
  'category-green',
  'category-blue',
  'category-purple',
]

function buildCards(categories: GameCategory[]) {
  return categories
    .flatMap((category, categoryIndex) =>
      category.cards.map((card) => ({
        ...card,
        categoryIndex,
        id: `${categoryIndex}-${card.position}-${card.content}`,
      })),
    )
    .sort((a, b) => a.position - b.position)
}

function shuffleCards(cards: PlayCard[]) {
  const shuffled = [...cards]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    const current = shuffled[index]
    shuffled[index] = shuffled[randomIndex]
    shuffled[randomIndex] = current
  }

  return shuffled
}

function formatPuzzleDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function App() {
  const [data, setData] = useState<GameData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [solvedCategories, setSolvedCategories] = useState<number[]>([])
  const [boardCards, setBoardCards] = useState<PlayCard[]>([])
  const [mistakesRemaining, setMistakesRemaining] = useState(MAX_MISTAKES)
  const [message, setMessage] = useState('Select four words that share a connection.')
  const [isGameOver, setIsGameOver] = useState(false)

  useEffect(() => {
    const today = new Date()
    const dateFormatted = formatPuzzleDate(today)

    fetch(`${API_BASE_URL}/connections/${dateFormatted}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error('Unable to load today\'s puzzle.')
        }

        return response.json()
      })
      .then((gameData: GameData) => {
        setData(gameData)
        setBoardCards(buildCards(gameData.categories))
      })
      .catch((fetchError) => {
        console.error('Error fetching data:', fetchError)
        setError('Could not load today\'s Connections puzzle.')
      })
  }, [])

  const selectedCards = useMemo(
    () => boardCards.filter((card) => selectedIds.includes(card.id)),
    [boardCards, selectedIds],
  )

  const isWon = data !== null && solvedCategories.length === data.categories.length
  const canSubmit = selectedIds.length === 4 && !isGameOver && !isWon

  const visibleSolvedCategories = useMemo(() => {
    if (!data) {
      return []
    }

    if (isGameOver && !isWon) {
      return data.categories.map((_, index) => index)
    }

    return solvedCategories
  }, [data, isGameOver, isWon, solvedCategories])

  const unsolvedCards = boardCards.filter(
    (card) => !visibleSolvedCategories.includes(card.categoryIndex),
  )

  function toggleCard(cardId: string) {
    if (isGameOver || isWon) {
      return
    }

    setSelectedIds((currentSelection) => {
      if (currentSelection.includes(cardId)) {
        return currentSelection.filter((id) => id !== cardId)
      }

      if (currentSelection.length === 4) {
        return currentSelection
      }

      return [...currentSelection, cardId]
    })
  }

  function deselectAll() {
    setSelectedIds([])
    setMessage('Select four words that share a connection.')
  }

  function shuffleBoard() {
    const solvedSet = new Set(solvedCategories)
    const solvedCards = boardCards.filter((card) => solvedSet.has(card.categoryIndex))
    const cardsToShuffle = boardCards.filter((card) => !solvedSet.has(card.categoryIndex))

    setBoardCards([...solvedCards, ...shuffleCards(cardsToShuffle)])
    setSelectedIds([])
  }

  function submitSelection() {
    if (!data || selectedCards.length !== 4 || isGameOver || isWon) {
      return
    }

    const categoryIndex = selectedCards[0].categoryIndex
    const isCorrect = selectedCards.every((card) => card.categoryIndex === categoryIndex)

    if (isCorrect) {
      const nextSolvedCategories = [...solvedCategories, categoryIndex]
      setSolvedCategories(nextSolvedCategories)
      setSelectedIds([])

      if (nextSolvedCategories.length === data.categories.length) {
        setMessage('You found every connection.')
      } else {
        setMessage('Nice.')
      }

      return
    }

    const counts = selectedCards.reduce<Record<number, number>>((accumulator, card) => {
      accumulator[card.categoryIndex] = (accumulator[card.categoryIndex] ?? 0) + 1
      return accumulator
    }, {})
    const wasOneAway = Object.values(counts).some((count) => count === 3)
    const nextMistakesRemaining = mistakesRemaining - 1

    setMistakesRemaining(nextMistakesRemaining)
    setSelectedIds([])

    if (nextMistakesRemaining === 0) {
      setIsGameOver(true)
      setMessage('No mistakes left. Here are the answers.')
    } else {
      setMessage(wasOneAway ? 'One away...' : 'Not quite.')
    }
  }

  function resetPuzzle() {
    if (!data) {
      return
    }

    setSelectedIds([])
    setSolvedCategories([])
    setBoardCards(buildCards(data.categories))
    setMistakesRemaining(MAX_MISTAKES)
    setMessage('Select four words that share a connection.')
    setIsGameOver(false)
  }

  if (error) {
    return (
      <main className="app-shell app-state">
        <img className="app-logo" src={connectionsLogo} alt="" />
        <h1>Connections</h1>
        <p>{error}</p>
      </main>
    )
  }

  if (!data) {
    return (
      <main className="app-shell app-state">
        <img className="app-logo" src={connectionsLogo} alt="" />
        <h1>Connections</h1>
        <p>Loading today&apos;s puzzle...</p>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="game-header">
        <div className="brand">
          <img className="app-logo" src={connectionsLogo} alt="" />
          <h1>Connections</h1>
        </div>
        <div className="puzzle-meta" aria-label="Puzzle details">
          <span>{data.print_date}</span>
          <span>Edited by {data.editor}</span>
        </div>
      </header>

      <section className="game-area" aria-label="Connections puzzle">
        <p className="game-instruction">Create four groups of four.</p>

        <div className="solved-list" aria-live="polite">
          {visibleSolvedCategories.map((categoryIndex) => {
            const category = data.categories[categoryIndex]

            return (
              <article
                className={`solved-group ${categoryColors[categoryIndex]}`}
                key={category.title}
              >
                <h2>{category.title}</h2>
                <p>{category.cards.map((card) => card.content).join(', ')}</p>
              </article>
            )
          })}
        </div>

        {!isGameOver && !isWon ? (
          <div className="word-grid" aria-label="Selectable words">
            {unsolvedCards.map((card) => {
              const isSelected = selectedIds.includes(card.id)

              return (
                <button
                  className={`word-card${isSelected ? ' selected' : ''}`}
                  key={card.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggleCard(card.id)}
                >
                  {card.content}
                </button>
              )
            })}
          </div>
        ) : null}

        <p className="feedback" role="status" aria-live="polite">
          {message}
        </p>

        <div className="mistakes" aria-label={`${mistakesRemaining} mistakes remaining`}>
          <span>Mistakes remaining:</span>
          {Array.from({ length: MAX_MISTAKES }).map((_, index) => (
            <span
              className={`mistake-dot${index < mistakesRemaining ? '' : ' spent'}`}
              key={index}
            />
          ))}
        </div>

        <div className="actions">
          <button type="button" onClick={shuffleBoard} disabled={isGameOver || isWon}>
            Shuffle
          </button>
          <button type="button" onClick={deselectAll} disabled={selectedIds.length === 0}>
            Deselect all
          </button>
          <button className="primary-action" type="button" onClick={submitSelection} disabled={!canSubmit}>
            Submit
          </button>
          {(isGameOver || isWon) ? (
            <button type="button" onClick={resetPuzzle}>
              Try again
            </button>
          ) : null}
        </div>
      </section>
    </main>
  )
}

export default App
