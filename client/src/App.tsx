import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import connectionsLogo from './assets/connections.svg'
import './App.css'

import { type GameCategory, type PlayCard, type GameData, API_BASE_URL } from './lib'

const MAX_MISTAKES = 4
const INCORRECT_SHAKE_ANIMATION_MS = 420
const CORRECT_SWAP_ANIMATION_MS = 500
const SOLVED_GROUP_REVEAL_DELAY_MS = 100
const TOAST_MS = 1150
const GUESS_JUMP_ANIMATION_MS = 1000
const GUESS_JUMP_STAGGER_MS = 120
const GUESS_JUMP_DURATION_MS = 300
const INSTANT_LAYOUT_RESET_MS = 40
const INCORRECT_CLEAR_BUFFER_MS = 80

const DEFAULT_LAYOUT_SECONDS = 0.28
const DEFAULT_LAYOUT_EASE = [0, 0, 0.2, 1] as const
const CORRECT_SWAP_LAYOUT_EASE = [0.2, 0.9, 0.5, 1] as const
const TITLE_ENTER_SECONDS = 0.24
const CARD_JUMP_Y = -16
const CARD_SHAKE_X = [-7, 7, -6, 5]
const TOAST_ANIMATION_SECONDS = 0.18
const SOLVED_GROUP_ENTER_Y = 10
const TITLE_ENTER_Y = 10

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

function getVictoryMessage(mistakesMade: number) {
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

function getCardId(categoryIndex: number, card: GameCategory['cards'][number]) {
  return `${categoryIndex}-${card.position}-${card.content}`
}

// Connections reveals a solved group only after its cards gather into the next
// open row. We create that effect by swapping selected cards into the first four
// unsolved slots while preserving the category's answer order.
function swapCategoryCardsToTopRow(
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

function App() {
  const [data, setData] = useState<GameData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasStarted, setHasStarted] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [solvedCategories, setSolvedCategories] = useState<number[]>([])
  const [boardCards, setBoardCards] = useState<PlayCard[]>([])
  const [mistakesRemaining, setMistakesRemaining] = useState(MAX_MISTAKES)
  const [isGameOver, setIsGameOver] = useState(false)
  const [guessAnimation, setGuessAnimation] = useState<'correct' | 'incorrect' | null>(null)
  const [guessPhase, setGuessPhase] = useState<'idle' | 'jump' | 'shake' | 'swap'>('idle')
  const [layoutPhase, setLayoutPhase] = useState<'idle' | 'swap' | 'instant'>('idle')
  const [activeGuessIds, setActiveGuessIds] = useState<string[]>([])
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const animationTimers = useRef<number[]>([])
  const toastTimer = useRef<number | null>(null)

  // Motion layout transitions are normally gentle, but we temporarily speed or
  // disable them during the correct-guess swap/reveal sequence.
  const layoutDuration = layoutPhase === 'instant'
    ? 0
    : layoutPhase === 'swap'
      ? CORRECT_SWAP_ANIMATION_MS / 1000
      : DEFAULT_LAYOUT_SECONDS
  const layoutTransition = {
    duration: layoutDuration,
    ease: layoutPhase === 'swap' ? CORRECT_SWAP_LAYOUT_EASE : DEFAULT_LAYOUT_EASE,
  }

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

  useEffect(() => {
    return () => {
      animationTimers.current.forEach((timer) => window.clearTimeout(timer))

      if (toastTimer.current) {
        window.clearTimeout(toastTimer.current)
      }
    }
  }, [])

  const selectedCards = useMemo(
    () => boardCards.filter((card) => selectedIds.includes(card.id)),
    [boardCards, selectedIds],
  )

  const isWon = data !== null && solvedCategories.length === data.categories.length
  const canSubmit = selectedIds.length === 4 && !isGameOver && !isWon && !guessAnimation

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

  // The selected cards jump in their current board order, not in click order.
  const selectedJumpOrder = useMemo(() => {
    const selectedSet = new Set(selectedIds)
    const jumpOrder = new Map<string, number>()

    unsolvedCards.forEach((card) => {
      if (selectedSet.has(card.id)) {
        jumpOrder.set(card.id, jumpOrder.size)
      }
    })

    return jumpOrder
  }, [selectedIds, unsolvedCards])

  function queueAnimation(callback: () => void, delay: number) {
    const timer = window.setTimeout(callback, delay)
    animationTimers.current.push(timer)
  }

  function showToast(text: string) {
    if (toastTimer.current) {
      window.clearTimeout(toastTimer.current)
    }

    setToast({ id: Date.now(), text })
    toastTimer.current = window.setTimeout(() => {
      setToast(null)
    }, TOAST_MS)
  }

  function toggleCard(cardId: string) {
    if (isGameOver || isWon || guessAnimation) {
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
  }

  function shuffleBoard() {
    const solvedSet = new Set(solvedCategories)
    const solvedCards = boardCards.filter((card) => solvedSet.has(card.categoryIndex))
    const cardsToShuffle = boardCards.filter((card) => !solvedSet.has(card.categoryIndex))

    setBoardCards([...solvedCards, ...shuffleCards(cardsToShuffle)])
    setSelectedIds([])
  }

  function submitSelection() {
    if (!data || selectedCards.length !== 4 || isGameOver || isWon || guessAnimation) {
      return
    }

    const submittedIds = selectedCards.map((card) => card.id)
    const categoryIndex = selectedCards[0].categoryIndex
    const isCorrect = selectedCards.every((card) => card.categoryIndex === categoryIndex)

    if (isCorrect) {
      const nextSolvedCategories = [...solvedCategories, categoryIndex]
      const hasWon = nextSolvedCategories.length === data.categories.length
      setActiveGuessIds(submittedIds)
      setGuessAnimation('correct')
      setGuessPhase('jump')

      if (hasWon) {
        showToast(getVictoryMessage(MAX_MISTAKES - mistakesRemaining))
      }

      queueAnimation(() => {
        setGuessPhase('swap')
        setLayoutPhase('swap')
        setBoardCards((currentCards) =>
          swapCategoryCardsToTopRow(
            currentCards,
            data.categories[categoryIndex],
            categoryIndex,
            solvedCategories,
          ),
        )

        // Once the selected cards have swapped into the top row, hold briefly
        // before revealing the solved category without a second reflow slide.
        queueAnimation(() => {
          queueAnimation(() => {
            setLayoutPhase('instant')
            setSolvedCategories(nextSolvedCategories)
            setSelectedIds([])
            setActiveGuessIds([])
            setGuessAnimation(null)
            setGuessPhase('idle')

            queueAnimation(() => {
              setLayoutPhase('idle')
            }, INSTANT_LAYOUT_RESET_MS)
          }, SOLVED_GROUP_REVEAL_DELAY_MS)
        }, CORRECT_SWAP_ANIMATION_MS)
      }, GUESS_JUMP_ANIMATION_MS)

      return
    }

    const counts = selectedCards.reduce<Record<number, number>>((accumulator, card) => {
      accumulator[card.categoryIndex] = (accumulator[card.categoryIndex] ?? 0) + 1
      return accumulator
    }, {})
    const wasOneAway = Object.values(counts).some((count) => count === 3)
    const nextMistakesRemaining = mistakesRemaining - 1

    setMistakesRemaining(nextMistakesRemaining)
    setActiveGuessIds(submittedIds)
    setGuessAnimation('incorrect')
    setGuessPhase('jump')

    if (wasOneAway) {
      showToast('One away...')
    }

    // Incorrect guesses jump first, then only the picked cards shake. Keeping
    // these as separate phases prevents interrupted x/y animations from leaving
    // cards visually offset.
    queueAnimation(() => {
      setGuessPhase('shake')
    }, GUESS_JUMP_ANIMATION_MS)

    queueAnimation(() => {
      setSelectedIds([])
      setActiveGuessIds([])
      setGuessAnimation(null)
      setGuessPhase('idle')

      if (nextMistakesRemaining === 0) {
        setIsGameOver(true)
      }
    }, GUESS_JUMP_ANIMATION_MS + INCORRECT_SHAKE_ANIMATION_MS + INCORRECT_CLEAR_BUFFER_MS)
  }

  function resetPuzzle() {
    if (!data) {
      return
    }

    setSelectedIds([])
    setSolvedCategories([])
    setBoardCards(buildCards(data.categories))
    setMistakesRemaining(MAX_MISTAKES)
    setIsGameOver(false)
    setGuessAnimation(null)
    setGuessPhase('idle')
    setLayoutPhase('idle')
    setActiveGuessIds([])
    setToast(null)
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

  if (!hasStarted) {
    return (
      <motion.main
        className="app-shell title-screen"
        initial={{ opacity: 0, y: TITLE_ENTER_Y }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: TITLE_ENTER_SECONDS }}
      >
        <img className="title-logo" src={connectionsLogo} alt="" />
        <h1>Connections</h1>
        <div className="title-meta" aria-label="Puzzle details">
          <span>{data.print_date}</span>
          <span>By {data.editor}</span>
        </div>
        <button className="title-start" type="button" onClick={() => setHasStarted(true)}>
          Play
        </button>
      </motion.main>
    )
  }

  return (
    <main className="app-shell">
      <header className="game-header">
        <div className="brand">
          <img className="app-logo" src={connectionsLogo} alt="" />
          <h1>Connections</h1>
        </div>
      </header>

      <section className="game-area" aria-label="Connections puzzle">
        <p className="game-instruction">Create four groups of four.</p>

        <div className="board-frame">
          <AnimatePresence initial={false}>
            {!isGameOver && !isWon ? (
              <motion.div
                layout
                className="board-grid"
                aria-label="Selectable words"
                transition={layoutTransition}
              >
                {visibleSolvedCategories.map((categoryIndex) => {
                  const category = data.categories[categoryIndex]

                  return (
                    <motion.div
                      layout
                      className="solved-group-shell"
                      key={category.title}
                      initial={{ opacity: 1, y: SOLVED_GROUP_ENTER_Y }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 1, y: 0 }}
                      transition={layoutTransition}
                    >
                      {/* Keep layout movement and bounce transforms separate so Motion does not swallow the CSS scale animation. */}
                      <div className={`solved-group ${categoryColors[categoryIndex]}`}>
                        <h2>{category.title}</h2>
                        <p>{category.cards.map((card) => card.content).join(', ')}</p>
                      </div>
                    </motion.div>
                  )
                })}
                <AnimatePresence initial={false} mode="popLayout">
                  {unsolvedCards.map((card) => {
                    const isSubmittedCard = activeGuessIds.includes(card.id)
                    const isSelected = selectedIds.includes(card.id) || isSubmittedCard
                    const isJumpingSelection = guessPhase === 'jump' && isSelected
                    const isShakingSelection = guessPhase === 'shake' && guessAnimation === 'incorrect' && isSelected
                    const jumpOrder = selectedJumpOrder.get(card.id) ?? 0
                    const jumpDelay = (jumpOrder * GUESS_JUMP_STAGGER_MS) / 1000
                    const exitAnimation = { opacity: 0, transition: { duration: 0 } }

                    return (
                      <motion.button
                        layout="position"
                        className={`word-card${isSelected ? ' selected' : ''}${isSubmittedCard ? ' submitted' : ''}`}
                        key={card.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => toggleCard(card.id)}
                        initial={{ opacity: 0 }}
                        animate={{
                          opacity: 1,
                          y: isJumpingSelection ? [0, CARD_JUMP_Y, 0] : 0,
                          x: isShakingSelection ? [0, ...CARD_SHAKE_X, 0] : 0,
                        }}
                        exit={exitAnimation}
                        transition={{
                          layout: layoutTransition,
                          y: {
                            duration: GUESS_JUMP_DURATION_MS / 1000,
                            delay: jumpDelay,
                            ease: 'easeOut',
                          },
                          x: {
                            duration: INCORRECT_SHAKE_ANIMATION_MS / 1000,
                            ease: 'easeInOut',
                          },
                        }}
                      >
                        {card.content}
                      </motion.button>
                    )
                  })}
                </AnimatePresence>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <AnimatePresence>
            {toast ? (
              <motion.div
                className="board-popup"
                key={toast.id}
                role="status"
                aria-live="polite"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: TOAST_ANIMATION_SECONDS, ease: 'easeOut' }}
              >
                {toast.text}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="mistakes" aria-label={`${mistakesRemaining} mistakes remaining`}>
          <span>Mistakes remaining:</span>
          {Array.from({ length: MAX_MISTAKES }).map((_, index) => (
            <motion.span
              className={`mistake-dot${index < mistakesRemaining ? '' : ' spent'}`}
              key={index}
              animate={{ opacity: index < mistakesRemaining ? 1 : 0.45 }}
              transition={{ duration: TOAST_ANIMATION_SECONDS }}
            />
          ))}
        </div>

        <div className="actions">
          <button type="button" onClick={shuffleBoard} disabled={isGameOver || isWon || !!guessAnimation}>
            Shuffle
          </button>
          <button type="button" onClick={deselectAll} disabled={selectedIds.length === 0 || !!guessAnimation}>
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
