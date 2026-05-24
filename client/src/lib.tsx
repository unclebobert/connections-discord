export interface GameCategory {
  title: string
  cards: Array<{
    content: string
    position: number
  }>
}

export interface GameData {
  status: string
  id: number
  print_date: string
  editor: string
  categories: GameCategory[]
}

export const API_BASE_URL = import.meta.env.DEV ?
  'https://connections-discord-server.unclebobert.workers.dev' :
  '/api'

export type PlayerGuess = [number, number, number, number]
export type PlayerProgress = PlayerGuess[]

export interface ProgressGuessMessage {
  userId: string
  guess: PlayerGuess
}

export interface ProgressUpdateMessage {
  userId: string
  progress: PlayerProgress
}

export function getProgressWebSocketUrl(
  guildId: string,
  date: string,
  userId: string,
  accessToken: string,
) {
  const baseUrl = new URL(API_BASE_URL, window.location.origin)

  baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  baseUrl.pathname = [
    baseUrl.pathname.replace(/\/$/, ''),
    'ws',
    encodeURIComponent(guildId),
    encodeURIComponent(date),
    encodeURIComponent(userId),
  ].join('/')
  baseUrl.search = new URLSearchParams({
    access_token: accessToken,
  }).toString()

  return baseUrl.toString()
}

export function createProgressGuessMessage(userId: string, guess: PlayerGuess): ProgressGuessMessage {
  return { userId, guess }
}

export function parseProgressUpdate(data: string): ProgressUpdateMessage | null {
  try {
    const parsed: unknown = JSON.parse(data)

    if (!isRecord(parsed) || typeof parsed.userId !== 'string' || !isPlayerProgress(parsed.progress)) {
      return null
    }

    return {
      userId: parsed.userId,
      progress: parsed.progress,
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPlayerProgress(value: unknown): value is PlayerProgress {
  return Array.isArray(value) && value.every(isPlayerGuess)
}

function isPlayerGuess(value: unknown): value is PlayerGuess {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((position) => Number.isInteger(position))
}
