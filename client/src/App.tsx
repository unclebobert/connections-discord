import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import connectionsLogo from './assets/connections.svg'
import './App.css'

import { getDiscordSession, type DiscordSession } from './discord'
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
const TOTAL_CATEGORIES = 4
const PROGRESS_RESTORE_TIMEOUT_MS = 8000
const PROGRESS_SAVE_WARNING_TIMEOUT_MS = 6000
const PROGRESS_SAVE_WARNING_TOAST_MS = 3000
const PROGRESS_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000]
const PENDING_PROGRESS_QUEUE_KEY_PREFIX = 'connections:pending-progress:'
const MAX_PENDING_PROGRESS_GUESSES = 12

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
type PendingProgressGuess = {
  id: string
  guess: PlayerGuess
  isFinal: boolean
}

function flushProgressQueue(
  socket: WebSocket,
  userId: string,
  pendingGuesses: { current: PendingProgressGuess[] },
  sentGuessIds: { current: Set<string> },
) {
  for (const pendingGuess of pendingGuesses.current) {
    if (socket.readyState !== WebSocket.OPEN) {
      return
    }

    if (sentGuessIds.current.has(pendingGuess.id)) {
      continue
    }

    try {
      socket.send(JSON.stringify(createProgressGuessMessage(userId, pendingGuess.id, pendingGuess.guess)))
      sentGuessIds.current.add(pendingGuess.id)
    } catch (error) {
      sentGuessIds.current.delete(pendingGuess.id)
      console.error('Unable to send progress update:', error)
      return
    }
  }
}

function createProgressGuessId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function getPendingProgressQueueKey(connectionKey: string) {
  return `${PENDING_PROGRESS_QUEUE_KEY_PREFIX}${connectionKey}`
}

function loadPendingProgressGuesses(connectionKey: string): PendingProgressGuess[] {
  try {
    const rawValue = localStorage.getItem(getPendingProgressQueueKey(connectionKey))
    if (!rawValue) {
      return []
    }

    const parsed: unknown = JSON.parse(rawValue)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(isPendingProgressGuess).slice(0, MAX_PENDING_PROGRESS_GUESSES)
  } catch (error) {
    console.warn('Unable to load pending progress updates:', error)
    return []
  }
}

function savePendingProgressGuesses(connectionKey: string, pendingGuesses: PendingProgressGuess[]) {
  try {
    const storageKey = getPendingProgressQueueKey(connectionKey)
    if (pendingGuesses.length === 0) {
      localStorage.removeItem(storageKey)
      return
    }

    localStorage.setItem(
      storageKey,
      JSON.stringify(pendingGuesses.slice(-MAX_PENDING_PROGRESS_GUESSES)),
    )
  } catch (error) {
    console.warn('Unable to save pending progress updates:', error)
  }
}

function isPendingProgressGuess(value: unknown): value is PendingProgressGuess {
  return typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'guess' in value &&
    'isFinal' in value &&
    typeof value.id === 'string' &&
    Array.isArray(value.guess) &&
    value.guess.length === 4 &&
    value.guess.every((position) => Number.isInteger(position)) &&
    typeof value.isFinal === 'boolean'
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

function getActivityScopeId(guildId: string | null, channelId: string) {
  return guildId ? `guild:${guildId}` : `dm:${channelId}`
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
  type CellInfo = { key: string; className: string }
  const rows: Array<CellInfo[]> = []
  const hasFinished = player.isWon || player.isGameOver

  let remainingUnsolved = TOTAL_CATEGORIES;
  // Fill out rows from guesses
  for (const [rowIndex, guess] of player.progress.entries()) {
    const guessedCategories = guess.map((position) => getCategoryIndexByPosition(categories, position))
    const firstCategory = guessedCategories[0]
    const isCorrect = firstCategory !== null && guessedCategories.every((categoryIndex) => categoryIndex === firstCategory)

    let rowCells: CellInfo[]
    if (isCorrect) {
      remainingUnsolved--;
      rowCells = guessedCategories.map((categoryIndex, cellIndex) => ({
        key: `${rowIndex}-${cellIndex}`,
        className: `progress-grid-cell correct ${categoryIndex !== null ? categoryColors[categoryIndex] : ''}`,
      }))
    } else {
      // Only reveal guesses for solved categories if the player has finished the game
      rowCells = guessedCategories.map((categoryIndex, cellIndex) => ({
        key: `${rowIndex}-${cellIndex}`,
        className: `progress-grid-cell ${hasFinished ? 'revealed' : 'hidden'} ${categoryIndex !== null ? categoryColors[categoryIndex] : ''}`,
      }))
    }

    rows.push(rowCells);
  }

  if (!hasFinished) {
    // Add blank rows for any remaining unsolved categories
    rows.push(...Array.from({ length: remainingUnsolved }, (_, rowIndex) => {
      return Array.from({ length: 4 }, (__, cellIndex) => ({
        key: `${rowIndex + remainingUnsolved}-${cellIndex}`,
        className: 'progress-grid-cell blank',
      }))
    }))
  }

  return rows;
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
  const progressSaveWarningTimer = useRef<number | null>(null)
  const progressSocket = useRef<WebSocket | null>(null)
  const ensureProgressSocket = useRef<(() => void) | null>(null)
  const pendingProgressGuesses = useRef<PendingProgressGuess[]>([])
  const sentProgressGuessIds = useRef<Set<string>>(new Set())
  const hasReportedFinalGuess = useRef(false)
  const hydratedProgressKey = useRef<string | null>(null)
  const puzzleDate = useMemo(() => formatPuzzleDate(new Date()), [])
  const progressScopeId = discordSession?.channelId
    ? getActivityScopeId(discordSession.guildId, discordSession.channelId)
    : null
  const progressConnectionKey = progressScopeId && discordSession?.channelId && discordSession.user.id
    ? `${progressScopeId}:${discordSession.channelId}:${discordSession.user.id}:${puzzleDate}`
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
    if (!hasStarted) {
      return
    }

    let isCancelled = false

    getDiscordSession()
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
  }, [hasStarted])

  useEffect(() => () => {
    animationTimers.current.forEach((timer) => window.clearTimeout(timer))

    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current)
    }

    if (progressSaveWarningTimer.current !== null) {
      window.clearTimeout(progressSaveWarningTimer.current)
    }

    progressSocket.current?.close()
  }, [])

  useEffect(() => {
    const scopeId = discordSession?.channelId
      ? getActivityScopeId(discordSession.guildId, discordSession.channelId)
      : null
    const channelId = discordSession?.channelId
    const userId = discordSession?.user.id
    const accessToken = discordSession?.accessToken
    const connectionKey = scopeId && channelId && userId
      ? `${scopeId}:${channelId}:${userId}:${puzzleDate}`
      : null

    if (!scopeId || !channelId || !userId || !accessToken || !connectionKey) {
      pendingProgressGuesses.current = []
      sentProgressGuessIds.current.clear()
      ensureProgressSocket.current = null
      hasReportedFinalGuess.current = false
      return
    }

    const activeScopeId = scopeId
    const activeChannelId = channelId
    const activeUserId = userId
    const activeAccessToken = accessToken
    const activeConnectionKey = connectionKey

    pendingProgressGuesses.current = loadPendingProgressGuesses(activeConnectionKey)
    sentProgressGuessIds.current.clear()
    hasReportedFinalGuess.current = pendingProgressGuesses.current.some((pendingGuess) => pendingGuess.isFinal)

    let socket: WebSocket | null = null
    let hasReceivedSnapshot = false
    let reconnectAttempt = 0
    let reconnectTimer: number | null = null
    let isCancelled = false
    const restoreTimeout = window.setTimeout(() => {
      if (!hasReceivedSnapshot) {
        setProgressRestore({
          connectionKey: activeConnectionKey,
          status: 'unavailable',
        })
      }
    }, PROGRESS_RESTORE_TIMEOUT_MS)

    function acknowledgeProgressGuess(messageId: string) {
      const previousLength = pendingProgressGuesses.current.length
      pendingProgressGuesses.current = pendingProgressGuesses.current.filter((pendingGuess) => pendingGuess.id !== messageId)
      sentProgressGuessIds.current.delete(messageId)

      if (pendingProgressGuesses.current.length !== previousLength) {
        savePendingProgressGuesses(activeConnectionKey, pendingProgressGuesses.current)
      }

      if (pendingProgressGuesses.current.length === 0 && progressSaveWarningTimer.current !== null) {
        window.clearTimeout(progressSaveWarningTimer.current)
        progressSaveWarningTimer.current = null
      }
    }

    function scheduleReconnect() {
      if (isCancelled || reconnectTimer !== null) {
        return
      }

      const delay = PROGRESS_RECONNECT_DELAYS_MS[Math.min(
        reconnectAttempt,
        PROGRESS_RECONNECT_DELAYS_MS.length - 1,
      )]
      reconnectAttempt += 1
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connectProgressSocket()
      }, delay)
    }

    function markRestoreUnavailable() {
      if (hasReceivedSnapshot) {
        return
      }

      window.clearTimeout(restoreTimeout)
      setProgressRestore({
        connectionKey: activeConnectionKey,
        status: 'unavailable',
      })
    }

    function connectProgressSocket() {
      if (isCancelled) {
        return
      }

      const nextSocket = new WebSocket(getProgressWebSocketUrl(
        activeScopeId,
        activeChannelId,
        puzzleDate,
        activeUserId,
        activeAccessToken,
      ))
      socket = nextSocket
      sentProgressGuessIds.current.clear()
      progressSocket.current = nextSocket

      nextSocket.addEventListener('open', () => {
        reconnectAttempt = 0
        flushProgressQueue(nextSocket, activeUserId, pendingProgressGuesses, sentProgressGuessIds)
      })
      nextSocket.addEventListener('close', (event) => {
        const isCurrentSocket = progressSocket.current === nextSocket
        if (isCurrentSocket) {
          progressSocket.current = null
        }

        console.warn('Progress socket closed:', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        })
        if (!isCurrentSocket) {
          return
        }

        markRestoreUnavailable()
        scheduleReconnect()
      })
      nextSocket.addEventListener('error', () => {
        console.warn('Progress socket error')
        if (progressSocket.current !== nextSocket) {
          return
        }

        markRestoreUnavailable()
      })
      nextSocket.addEventListener('message', (event) => {
        const message = parseProgressMessage(String(event.data))

        if (!message) {
          return
        }

        if (message.type === 'snapshot') {
          hasReceivedSnapshot = true
          window.clearTimeout(restoreTimeout)
          setOwnSnapshotProgress({
            connectionKey: activeConnectionKey,
            progress: message.players.find((player) => player.userId === activeUserId)?.progress ?? [],
          })
          setProgressRestore({
            connectionKey: activeConnectionKey,
            status: 'ready',
          })
        }

        if (message.type === 'ack') {
          acknowledgeProgressGuess(message.messageId)
        }

        setProgressState((currentState) => ({
          connectionKey: activeConnectionKey,
          players: message.type === 'snapshot'
            ? upsertObservedProgressBatch([], message.players)
            : upsertObservedProgress(
                currentState.connectionKey === activeConnectionKey ? currentState.players : [],
                message.player.userId,
                message.player.progress,
                message.player.profile ?? null,
              ),
        }))
      })
    }

    function ensureProgressSocketIsOpen() {
      const currentSocket = progressSocket.current
      if (currentSocket?.readyState === WebSocket.OPEN) {
        flushProgressQueue(currentSocket, activeUserId, pendingProgressGuesses, sentProgressGuessIds)
        return
      }

      if (currentSocket?.readyState === WebSocket.CONNECTING) {
        return
      }

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }

      connectProgressSocket()
    }

    ensureProgressSocket.current = ensureProgressSocketIsOpen
    connectProgressSocket()

    return () => {
      isCancelled = true
      if (ensureProgressSocket.current === ensureProgressSocketIsOpen) {
        ensureProgressSocket.current = null
      }

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
      }

      if (progressSaveWarningTimer.current !== null) {
        window.clearTimeout(progressSaveWarningTimer.current)
        progressSaveWarningTimer.current = null
      }

      if (progressSocket.current === socket) {
        progressSocket.current = null
      }

      window.clearTimeout(restoreTimeout)
      socket?.close()
    }
  }, [discordSession?.accessToken, discordSession?.channelId, discordSession?.guildId, discordSession?.user.id, puzzleDate])

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
    hasReportedFinalGuess.current = summary.isWon ||
      summary.isGameOver ||
      pendingProgressGuesses.current.some((pendingGuess) => pendingGuess.isFinal)
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

  function showToast(text: string, duration = TOAST_MS) {
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current)
    }

    setToast({ id: Date.now(), text })
    toastTimer.current = window.setTimeout(() => {
      setToast(null)
    }, duration)
  }

  function scheduleProgressSaveWarning() {
    if (pendingProgressGuesses.current.length === 0 || progressSaveWarningTimer.current !== null) {
      return
    }

    progressSaveWarningTimer.current = window.setTimeout(() => {
      progressSaveWarningTimer.current = null
      if (pendingProgressGuesses.current.length === 0) {
        return
      }

      showToast('Progress connection lost. Retrying...', PROGRESS_SAVE_WARNING_TOAST_MS)
      ensureProgressSocket.current?.()
    }, PROGRESS_SAVE_WARNING_TIMEOUT_MS)
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
    if (!discordSession || !progressConnectionKey || hasReportedFinalGuess.current) {
      return
    }

    const pendingGuess = {
      id: createProgressGuessId(),
      guess,
      isFinal: isFinalGuess,
    } satisfies PendingProgressGuess

    recordOwnProgressGuess(guess)
    pendingProgressGuesses.current = [
      ...pendingProgressGuesses.current,
      pendingGuess,
    ].slice(-MAX_PENDING_PROGRESS_GUESSES)
    savePendingProgressGuesses(progressConnectionKey, pendingProgressGuesses.current)

    if (progressSocket.current?.readyState === WebSocket.OPEN) {
      flushProgressQueue(progressSocket.current, discordSession.user.id, pendingProgressGuesses, sentProgressGuessIds)
    } else {
      ensureProgressSocket.current?.()
    }
    scheduleProgressSaveWarning()

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
                      <span className="word-card-label">{card.content}</span>
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
    <aside className="progress-panel" aria-label="Activity progress">
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
