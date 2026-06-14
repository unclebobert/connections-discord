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

export interface PlayerProfile {
  displayName: string
  avatarUrl: string | null
}

export interface ProgressGuessMessage {
  userId: string
  guess: PlayerGuess
}

export interface ProgressUpdateMessage {
  userId: string
  progress: PlayerProgress
  profile?: PlayerProfile | null
}

export type ProgressMessage =
  | {
      type: 'snapshot'
      players: ProgressUpdateMessage[]
    }
  | {
      type: 'update'
      player: ProgressUpdateMessage
    }

export function getProgressWebSocketUrl(
  guildId: string,
  channelId: string,
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
    encodeURIComponent(channelId),
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

export function parseProgressMessage(data: string): ProgressMessage | null {
  try {
    const parsed: unknown = JSON.parse(data)

    if (Array.isArray(parsed) && parsed.every(isProgressUpdateMessage)) {
      return {
        type: 'snapshot',
        players: parsed,
      }
    }

    if (!isProgressUpdateMessage(parsed)) {
      return null
    }

    return {
      type: 'update',
      player: parsed,
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

function isProgressUpdateMessage(value: unknown): value is ProgressUpdateMessage {
  return isRecord(value) &&
    typeof value.userId === 'string' &&
    isPlayerProgress(value.progress) &&
    (value.profile === undefined || value.profile === null || isPlayerProfile(value.profile))
}

function isPlayerProfile(value: unknown): value is PlayerProfile {
  return isRecord(value) &&
    typeof value.displayName === 'string' &&
    (typeof value.avatarUrl === 'string' || value.avatarUrl === null)
}

function isPlayerGuess(value: unknown): value is PlayerGuess {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((position) => Number.isInteger(position))
}
