import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import connectionsLogo from './assets/connections.svg'
import './App.css'

import { discordSessionPromise, type DiscordSession } from './discord'
import {
  buildCards,
  buildCardsForSolvedCategories,
  categoryColors,
  formatPuzzleDate,
  getVictoryMessage,
  hasGuessed,
  isOneAway,
  MAX_MISTAKES,
  shuffleCards,
  summarizeProgress,
  swapCategoryCardsToTopRow,
  toPlayerGuess,
  type PlayCard,
  type ProgressSummary,
} from './game'
import {
  API_BASE_URL,
  createProgressGuessMessage,
  getProgressWebSocketUrl,
  parseProgressMessage,
  type GameCategory,
  type GameData,
  type PlayerGuess,
  type PlayerProfile,
  type PlayerProgress,
} from './lib'

const INCORRECT_SHAKE_ANIMATION_MS = 420
const CORRECT_SWAP_ANIMATION_MS = 700
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
const MIN_PROGRESS_ROWS = 4
const MAX_PROGRESS_ROWS = 7
const PROGRESS_RESTORE_TIMEOUT_MS = 8000

type GuessAnimation = 'correct' | 'incorrect'
type GuessPhase = 'idle' | 'jump' | 'shake' | 'swap'
type LayoutPhase = 'idle' | 'swap' | 'instant'
type ProgressRestoreStatus = 'idle' | 'ready' | 'unavailable'

interface ObservedProgress {
  userId: string
  progress: PlayerProgress
  profile: PlayerProfile | null
  updatedAt: number
}

interface ProgressState {
  connectionKey: string | null
  players: ObservedProgress[]
}

type ProgressPlayer = ObservedProgress & ProgressSummary

function flushProgressQueue(
  socket: WebSocket,
  userId: string,
  pendingGuesses: { current: PlayerGuess[] },
) {
  while (socket.readyState === WebSocket.OPEN && pendingGuesses.current.length > 0) {
    const guess = pendingGuesses.current.shift()

    if (!guess) {
      return
    }

    try {
      socket.send(JSON.stringify(createProgressGuessMessage(userId, guess)))
    } catch (error) {
      pendingGuesses.current.unshift(guess)
      console.error('Unable to send progress update:', error)
      return
    }
  }
}

function upsertObservedProgress(
  currentPlayers: ObservedProgress[],
  userId: string,
  progress: PlayerProgress,
  profile: PlayerProfile | null = null,
) {
  const previousPlayer = currentPlayers.find((player) => player.userId === userId)
  const updatedPlayer = {
    userId,
    progress,
    profile: profile ?? previousPlayer?.profile ?? null,
    updatedAt: Date.now(),
  }

  return [
    updatedPlayer,
    ...currentPlayers.filter((player) => player.userId !== userId),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function upsertObservedProgressBatch(
  currentPlayers: ObservedProgress[],
  updates: Array<{ userId: string; progress: PlayerProgress; profile?: PlayerProfile | null }>,
) {
  return updates.reduce(
    (players, update) => upsertObservedProgress(players, update.userId, update.progress, update.profile ?? null),
    currentPlayers,
  )
}

function getDiscordAvatarUrl(user: DiscordSession['user']) {
  if (!user.avatar) {
    return null
  }

  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=80`
}

function getDiscordProfile(user: DiscordSession['user']): PlayerProfile {
  return {
    displayName: user.global_name || user.username,
    avatarUrl: getDiscordAvatarUrl(user),
  }
}

function getShortUserId(userId: string) {
  return userId.length > 4 ? userId.slice(-4) : userId
}

function getProgressInitial(player: ProgressPlayer) {
  const name = player.profile?.displayName
  if (name) {
    return name.trim().charAt(0).toUpperCase() || '?'
  }

  return getShortUserId(player.userId).slice(0, 2).toUpperCase() || '?'
}

function getCategoryIndexByPosition(categories: GameCategory[], position: number) {
  for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
    if (categories[categoryIndex].cards.some((card) => card.position === position)) {
      return categoryIndex
    }
  }

  return null
}

function getProgressRows(player: ProgressPlayer, categories: GameCategory[]) {
  const rowCount = MIN_PROGRESS_ROWS + player.progress.length
  const hasFinished = player.isWon || player.isGameOver

  return Array.from({ length: rowCount }).map((_, rowIndex) => {
    const guess = player.progress[rowIndex]

    if (!guess) {
      return Array.from({ length: 4 }).map((__, cellIndex) => ({
        key: `${rowIndex}-${cellIndex}`,
        className: 'progress-grid-cell blank',
      }))
    }

    const guessedCategories = guess.map((position) => getCategoryIndexByPosition(categories, position))
    const firstCategory = guessedCategories[0]
    const isCorrect = firstCategory !== null && guessedCategories.every((categoryIndex) => categoryIndex === firstCategory)

    return guessedCategories.map((categoryIndex, cellIndex) => {
      const shouldRevealCategory = isCorrect || hasFinished
      const colorClass = categoryIndex !== null && shouldRevealCategory ? ` ${categoryColors[categoryIndex]}` : ''
      const stateClass = isCorrect
        ? ' correct'
        : hasFinished
          ? ' revealed'
          : ' hidden'

      return {
        key: `${rowIndex}-${cellIndex}`,
        className: `progress-grid-cell${stateClass}${colorClass}`,
      }
    })
  })
}

function App() {
  const [data, setData] = useState<GameData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasStarted, setHasStarted] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [solvedCategories, setSolvedCategories] = useState<number[]>([])
  const [boardCards, setBoardCards] = useState<PlayCard[]>([])
  const [submittedGuesses, setSubmittedGuesses] = useState<PlayerProgress>([])
  const [mistakesRemaining, setMistakesRemaining] = useState(MAX_MISTAKES)
  const [isGameOver, setIsGameOver] = useState(false)
  const [guessAnimation, setGuessAnimation] = useState<GuessAnimation | null>(null)
  const [guessPhase, setGuessPhase] = useState<GuessPhase>('idle')
  const [layoutPhase, setLayoutPhase] = useState<LayoutPhase>('idle')
  const [activeGuessIds, setActiveGuessIds] = useState<string[]>([])
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [discordSession, setDiscordSession] = useState<DiscordSession | null>(null)
  const [isDiscordReady, setIsDiscordReady] = useState(false)
  const [progressState, setProgressState] = useState<ProgressState>({
    connectionKey: null,
    players: [],
  })
  const [progressRestore, setProgressRestore] = useState<{
    connectionKey: string | null
    status: ProgressRestoreStatus
  }>({
    connectionKey: null,
    status: 'idle',
  })
  const [ownSnapshotProgress, setOwnSnapshotProgress] = useState<{
    connectionKey: string
    progress: PlayerProgress
  } | null>(null)
  const animationTimers = useRef<number[]>([])
  const toastTimer = useRef<number | null>(null)
  const progressSocket = useRef<WebSocket | null>(null)
  const pendingProgressGuesses = useRef<PlayerGuess[]>([])
  const hasReportedFinalGuess = useRef(false)
  const hydratedProgressKey = useRef<string | null>(null)
  const puzzleDate = useMemo(() => formatPuzzleDate(new Date()), [])
  const progressConnectionKey = discordSession?.guildId && discordSession.user.id
    ? `${discordSession.guildId}:${discordSession.user.id}:${puzzleDate}`
    : null
  const isProgressRestoreReady = isDiscordReady && (
    !progressConnectionKey ||
    (
      progressRestore.connectionKey === progressConnectionKey &&
      progressRestore.status !== 'idle'
    )
  )

  const layoutTransition = useMemo(() => ({
    duration: layoutPhase === 'instant'
      ? 0
      : layoutPhase === 'swap'
        ? CORRECT_SWAP_ANIMATION_MS / 1000
        : DEFAULT_LAYOUT_SECONDS,
    ease: layoutPhase === 'swap' ? CORRECT_SWAP_LAYOUT_EASE : DEFAULT_LAYOUT_EASE,
  }), [layoutPhase])

  useEffect(() => {
    const controller = new AbortController()

    async function loadPuzzle() {
      try {
        const response = await fetch(`${API_BASE_URL}/connections/${puzzleDate}`, {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error('Unable to load today\'s puzzle.')
        }

        const gameData = await response.json() as GameData
        setData(gameData)
        setBoardCards(buildCards(gameData.categories))
      } catch (fetchError) {
        if (controller.signal.aborted) {
          return
        }

        console.error('Error fetching data:', fetchError)
        setError('Could not load today\'s Connections puzzle.')
      }
    }

    loadPuzzle()

    return () => {
      controller.abort()
    }
  }, [puzzleDate])

  useEffect(() => {
    let isCancelled = false

    discordSessionPromise
      .then((session) => {
        if (!isCancelled) {
          setDiscordSession(session)
          setIsDiscordReady(true)
        }
      })
      .catch((sessionError) => {
        console.error('Unable to initialise Discord progress sharing:', sessionError)
        if (!isCancelled) {
          setIsDiscordReady(true)
        }
      })

    return () => {
      isCancelled = true
    }
  }, [])

  useEffect(() => () => {
    animationTimers.current.forEach((timer) => window.clearTimeout(timer))

    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current)
    }

    progressSocket.current?.close()
  }, [])

  useEffect(() => {
    const guildId = discordSession?.guildId
    const userId = discordSession?.user.id
    const accessToken = discordSession?.accessToken
    const connectionKey = guildId && userId
      ? `${guildId}:${userId}:${puzzleDate}`
      : null

    pendingProgressGuesses.current = []
    hasReportedFinalGuess.current = false

    if (!guildId || !userId || !accessToken || !connectionKey) {
      return
    }

    const socket = new WebSocket(getProgressWebSocketUrl(guildId, puzzleDate, userId, accessToken))
    let hasReceivedSnapshot = false
    const restoreTimeout = window.setTimeout(() => {
      if (!hasReceivedSnapshot) {
        setProgressRestore({
          connectionKey,
          status: 'unavailable',
        })
      }
    }, PROGRESS_RESTORE_TIMEOUT_MS)

    progressSocket.current = socket

    socket.addEventListener('open', () => {
      flushProgressQueue(socket, userId, pendingProgressGuesses)
    })
    socket.addEventListener('close', () => {
      if (!hasReceivedSnapshot) {
        window.clearTimeout(restoreTimeout)
        setProgressRestore({
          connectionKey,
          status: 'unavailable',
        })
      }
    })
    socket.addEventListener('error', () => {
      if (!hasReceivedSnapshot) {
        window.clearTimeout(restoreTimeout)
        setProgressRestore({
          connectionKey,
          status: 'unavailable',
        })
      }
    })
    socket.addEventListener('message', (event) => {
      const message = parseProgressMessage(String(event.data))

      if (!message) {
        return
      }

      if (message.type === 'snapshot') {
        hasReceivedSnapshot = true
        window.clearTimeout(restoreTimeout)
        setOwnSnapshotProgress({
          connectionKey,
          progress: message.players.find((player) => player.userId === userId)?.progress ?? [],
        })
        setProgressRestore({
          connectionKey,
          status: 'ready',
        })
      }

      setProgressState((currentState) => ({
        connectionKey,
        players: message.type === 'snapshot'
          ? upsertObservedProgressBatch([], message.players)
          : message.player.userId === userId
            ? currentState.connectionKey === connectionKey
              ? currentState.players
              : []
            : upsertObservedProgress(
                currentState.connectionKey === connectionKey ? currentState.players : [],
                message.player.userId,
                message.player.progress,
                message.player.profile ?? null,
              ),
      }))
    })

    return () => {
      if (progressSocket.current === socket) {
        progressSocket.current = null
      }

      window.clearTimeout(restoreTimeout)
      socket.close()
    }
  }, [discordSession?.accessToken, discordSession?.guildId, discordSession?.user.id, puzzleDate])

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

  const unsolvedCards = useMemo(
    () => boardCards.filter((card) => !visibleSolvedCategories.includes(card.categoryIndex)),
    [boardCards, visibleSolvedCategories],
  )

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

  const displayedProgressPlayers = useMemo<ProgressPlayer[]>(() => {
    if (!data) {
      return []
    }

    if (progressState.connectionKey !== progressConnectionKey) {
      return []
    }

    return progressState.players.map((player) => ({
      ...player,
      profile: player.profile ?? (
        player.userId === discordSession?.user.id ? getDiscordProfile(discordSession.user) : null
      ),
      ...summarizeProgress(player.progress, data.categories),
    }))
  }, [data, discordSession, progressConnectionKey, progressState])
  const hasProgressPanel = displayedProgressPlayers.length > 0

  useEffect(() => {
    if (!data || !ownSnapshotProgress || ownSnapshotProgress.connectionKey !== progressConnectionKey) {
      return
    }

    if (ownSnapshotProgress.progress.length === 0 || hydratedProgressKey.current === progressConnectionKey) {
      return
    }

    const summary = summarizeProgress(ownSnapshotProgress.progress, data.categories)

    hydratedProgressKey.current = progressConnectionKey
    hasReportedFinalGuess.current = summary.isWon || summary.isGameOver
    setSelectedIds([])
    setSubmittedGuesses(ownSnapshotProgress.progress)
    setSolvedCategories(summary.solvedCategories)
    setBoardCards(buildCardsForSolvedCategories(data.categories, summary.solvedCategories))
    setMistakesRemaining(MAX_MISTAKES - summary.mistakesMade)
    setIsGameOver(summary.isGameOver)
    setGuessAnimation(null)
    setGuessPhase('idle')
    setLayoutPhase('idle')
    setActiveGuessIds([])
    setToast(null)
  }, [data, ownSnapshotProgress, progressConnectionKey])

  function queueAnimation(callback: () => void, delay: number) {
    const timer = window.setTimeout(() => {
      animationTimers.current = animationTimers.current.filter((queuedTimer) => queuedTimer !== timer)
      callback()
    }, delay)

    animationTimers.current.push(timer)
  }

  function showToast(text: string) {
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current)
    }

    setToast({ id: Date.now(), text })
    toastTimer.current = window.setTimeout(() => {
      setToast(null)
    }, TOAST_MS)
  }

  function recordOwnProgressGuess(guess: PlayerGuess) {
    if (!discordSession || !progressConnectionKey) {
      return
    }

    setProgressState((currentState) => {
      const currentPlayers = currentState.connectionKey === progressConnectionKey ? currentState.players : []
      const currentProgress = currentPlayers.find((player) => player.userId === discordSession.user.id)?.progress ?? []

      return {
        connectionKey: progressConnectionKey,
        players: upsertObservedProgress(
          currentPlayers,
          discordSession.user.id,
          [...currentProgress, guess],
          getDiscordProfile(discordSession.user),
        ),
      }
    })
  }

  function queueProgressGuess(guess: PlayerGuess, isFinalGuess: boolean) {
    if (!discordSession?.guildId || hasReportedFinalGuess.current) {
      return
    }

    recordOwnProgressGuess(guess)
    pendingProgressGuesses.current.push(guess)

    if (progressSocket.current?.readyState === WebSocket.OPEN) {
      flushProgressQueue(progressSocket.current, discordSession.user.id, pendingProgressGuesses)
    }

    if (isFinalGuess) {
      hasReportedFinalGuess.current = true
    }
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

    const guess = toPlayerGuess(selectedCards)

    if (!guess) {
      return
    }

    if (hasGuessed(submittedGuesses, guess)) {
      showToast('Already guessed!')
      return
    }

    const submittedIds = selectedCards.map((card) => card.id)
    const categoryIndex = selectedCards[0].categoryIndex
    const isCorrect = selectedCards.every((card) => card.categoryIndex === categoryIndex)

    if (isCorrect) {
      const nextSolvedCategories = [...solvedCategories, categoryIndex]
      const hasWon = nextSolvedCategories.length === data.categories.length

      setSubmittedGuesses((currentGuesses) => [...currentGuesses, guess])
      queueProgressGuess(guess, hasWon)
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

    const nextMistakesRemaining = mistakesRemaining - 1

    setSubmittedGuesses((currentGuesses) => [...currentGuesses, guess])
    queueProgressGuess(guess, nextMistakesRemaining === 0)
    setMistakesRemaining(nextMistakesRemaining)
    setActiveGuessIds(submittedIds)
    setGuessAnimation('incorrect')
    setGuessPhase('jump')

    if (isOneAway(selectedCards)) {
      showToast('One away...')
    }

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
        showToast('Next time')
      }
    }, GUESS_JUMP_ANIMATION_MS + INCORRECT_SHAKE_ANIMATION_MS + INCORRECT_CLEAR_BUFFER_MS)
  }

  if (error) {
    return <StatusScreen message={error} />
  }

  if (!data) {
    return <StatusScreen message="Loading today's puzzle..." />
  }

  if (!hasStarted) {
    return <TitleScreen data={data} onPlay={() => setHasStarted(true)} />
  }

  if (!isProgressRestoreReady) {
    return <StatusScreen message="Restoring your progress..." />
  }

  return (
    <main className={`app-shell game-shell${hasProgressPanel ? ' has-progress' : ' no-progress'}`}>
      {hasProgressPanel ? (
        <ProgressPanel
          categories={data.categories}
          players={displayedProgressPlayers}
        />
      ) : null}

      <div className="game-column">
        <header className="game-header">
          <div className="brand">
            <img className="app-logo" src={connectionsLogo} alt="" />
            <h1>Connections</h1>
          </div>
        </header>

        <section className="game-area" aria-label="Connections puzzle">
          <p className="game-instruction">Create four groups of four!</p>
          <div className="board-frame">
            <div className="board-surface">
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
                      exit={{ opacity: 0, transition: { duration: 0 } }}
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
          </div>

          <MistakeMeter mistakesRemaining={mistakesRemaining} />

          <GameActions
            canDeselect={selectedIds.length > 0 && !guessAnimation}
            canShuffle={!isGameOver && !isWon && !guessAnimation}
            canSubmit={canSubmit}
            onDeselectAll={deselectAll}
            onShuffle={shuffleBoard}
            onSubmit={submitSelection}
          />
        </section>
      </div>
    </main>
  )
}

function StatusScreen({ message }: { message: string }) {
  return (
    <main className="app-shell app-state">
      <img className="app-logo" src={connectionsLogo} alt="" />
      <h1>Connections</h1>
      <p>{message}</p>
    </main>
  )
}

function TitleScreen({ data, onPlay }: { data: GameData; onPlay: () => void }) {
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
      <button className="title-start" type="button" onClick={onPlay}>
        Play
      </button>
    </motion.main>
  )
}

function ProgressPanel({
  categories,
  players,
}: {
  categories: GameCategory[]
  players: ProgressPlayer[]
}) {
  return (
    <aside className="progress-panel" aria-label="Guild progress">
      {players.length > 0 ? (
        <div className="progress-player-list">
          {players.map((player) => {
            const rows = getProgressRows(player, categories)

            return (
              <div className="progress-player" key={player.userId}>
                <div className="progress-avatar" aria-hidden="true">
                  {player.profile?.avatarUrl ? (
                    <img src={player.profile.avatarUrl} alt="" />
                  ) : (
                    <span>{getProgressInitial(player)}</span>
                  )}
                </div>
                <div
                  className="progress-grid"
                  aria-label={`${player.progress.length} guesses, ${player.solvedCategories.length} groups solved`}
                >
                  {rows.flat().map((cell) => (
                    <span className={cell.className} key={cell.key} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </aside>
  )
}

function MistakeMeter({ mistakesRemaining }: { mistakesRemaining: number }) {
  return (
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
  )
}

function GameActions({
  canDeselect,
  canShuffle,
  canSubmit,
  onDeselectAll,
  onShuffle,
  onSubmit,
}: {
  canDeselect: boolean
  canShuffle: boolean
  canSubmit: boolean
  onDeselectAll: () => void
  onShuffle: () => void
  onSubmit: () => void
}) {
  return (
    <div className="actions">
      <button type="button" onClick={onShuffle} disabled={!canShuffle}>
        Shuffle
      </button>
      <button type="button" onClick={onDeselectAll} disabled={!canDeselect}>
        Deselect all
      </button>
      <button className="primary-action" type="button" onClick={onSubmit} disabled={!canSubmit}>
        Submit
      </button>
    </div>
  )
}

export default App
