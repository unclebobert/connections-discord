import type { GameData } from './lib'

const PUZZLE_KEY_PREFIX = 'connections:puzzle:'
const ACCESS_TOKEN_KEY = 'connections:access-token'
const MAX_CACHED_PUZZLES = 7

// Discord access tokens last about a week, and reuse is capped to match rather than
// cut short: reading a cached token requires local machine access, which already
// exposes Discord's own credentials, so the cache adds no meaningful exposure. The
// residual risk is misattribution on a shared machine after an account switch, and
// that is recovered rather than prevented — the server rejects a token belonging to
// someone outside the guild, and the client then discards the cache and re-authorizes.
const MAX_TOKEN_CACHE_MS = 7 * 24 * 60 * 60 * 1000
// Never hand back a token that is about to expire mid-session.
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000

type CachedAccessToken = {
  accessToken: string
  expiresAt: number
}

/**
 * Activities run in a partitioned third-party iframe, where storage can be missing,
 * cleared, or throw outright. Every accessor here fails closed to "nothing cached",
 * so a storage failure costs a network request rather than correctness.
 */
function readItem(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Full, disabled, or partitioned away. The caller carries on unchanged.
  }
}

function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // As above.
  }
}

function getPuzzleKey(date: string) {
  return `${PUZZLE_KEY_PREFIX}${date}`
}

export function loadCachedPuzzle(date: string): GameData | null {
  const rawValue = readItem(getPuzzleKey(date))
  if (!rawValue) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(rawValue)
    return isGameData(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveCachedPuzzle(date: string, data: GameData) {
  // A published puzzle never changes, so this is safe to keep until it is pruned.
  writeItem(getPuzzleKey(date), JSON.stringify(data))
  prunePuzzleCache(date)
}

function prunePuzzleCache(keepDate: string) {
  try {
    // `length`/`key()` is the specified way to enumerate Storage; treating it as a
    // plain object only happens to work on some implementations.
    const puzzleKeys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key !== null && key.startsWith(PUZZLE_KEY_PREFIX)) {
        puzzleKeys.push(key)
      }
    }

    puzzleKeys.sort()

    // Keys embed an ISO date, so lexicographic order is chronological. Drop the
    // oldest, never the one just written.
    for (const key of puzzleKeys.slice(0, Math.max(0, puzzleKeys.length - MAX_CACHED_PUZZLES))) {
      if (key !== getPuzzleKey(keepDate)) {
        removeItem(key)
      }
    }
  } catch {
    // Enumerating storage can throw in the same situations reads can.
  }
}

export function loadCachedAccessToken(): string | null {
  const rawValue = readItem(ACCESS_TOKEN_KEY)
  if (!rawValue) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(rawValue)
    if (!isCachedAccessToken(parsed)) {
      return null
    }

    if (parsed.expiresAt - TOKEN_EXPIRY_MARGIN_MS <= Date.now()) {
      clearCachedAccessToken()
      return null
    }

    return parsed.accessToken
  } catch {
    return null
  }
}

export function saveCachedAccessToken(accessToken: string, expiresInSeconds?: number) {
  const lifetimeMs = typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds)
    ? Math.min(expiresInSeconds * 1000, MAX_TOKEN_CACHE_MS)
    : MAX_TOKEN_CACHE_MS

  if (lifetimeMs <= TOKEN_EXPIRY_MARGIN_MS) {
    return
  }

  writeItem(ACCESS_TOKEN_KEY, JSON.stringify({
    accessToken,
    expiresAt: Date.now() + lifetimeMs,
  } satisfies CachedAccessToken))
}

export function clearCachedAccessToken() {
  removeItem(ACCESS_TOKEN_KEY)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCachedAccessToken(value: unknown): value is CachedAccessToken {
  return isRecord(value) &&
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 0 &&
    typeof value.expiresAt === 'number'
}

function isGameData(value: unknown): value is GameData {
  return isRecord(value) &&
    Array.isArray(value.categories) &&
    value.categories.length > 0 &&
    value.categories.every((category) => isRecord(category) && Array.isArray(category.cards))
}
