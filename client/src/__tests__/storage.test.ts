import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCachedAccessToken,
  loadCachedAccessToken,
  loadCachedPuzzle,
  saveCachedAccessToken,
  saveCachedPuzzle,
} from '../storage'
import { categories } from './fixtures'

const puzzle = { status: 'OK', id: 1, print_date: '2026-08-28', editor: 'Ed', categories }

function createMemoryStorage() {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    removeItem: (key: string) => { entries.delete(key) },
    get length() { return entries.size },
    key: (index: number) => [...entries.keys()][index] ?? null,
    clear: () => { entries.clear() },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('puzzle cache', () => {
  it('round-trips a puzzle', () => {
    saveCachedPuzzle('2026-08-28', puzzle)

    expect(loadCachedPuzzle('2026-08-28')).toEqual(puzzle)
  })

  it('is a miss for a date that was never cached', () => {
    expect(loadCachedPuzzle('2026-08-27')).toBeNull()
  })

  it('rejects corrupted entries rather than returning a broken board', () => {
    localStorage.setItem('connections:puzzle:2026-08-28', '{not json')
    expect(loadCachedPuzzle('2026-08-28')).toBeNull()

    localStorage.setItem('connections:puzzle:2026-08-28', JSON.stringify({ categories: [] }))
    expect(loadCachedPuzzle('2026-08-28')).toBeNull()

    localStorage.setItem('connections:puzzle:2026-08-28', JSON.stringify({ nope: true }))
    expect(loadCachedPuzzle('2026-08-28')).toBeNull()
  })

  it('prunes old puzzles but keeps the one just written', () => {
    for (let day = 1; day <= 10; day += 1) {
      saveCachedPuzzle(`2026-08-${String(day).padStart(2, '0')}`, puzzle)
    }

    expect(loadCachedPuzzle('2026-08-10')).toEqual(puzzle)
    expect(loadCachedPuzzle('2026-08-01')).toBeNull()
    // Bounded, so a long-running client cannot fill the origin's quota.
    expect(localStorage.length).toBeLessThanOrEqual(7)
  })
})

describe('access token cache', () => {
  it('round-trips a token that is still valid', () => {
    saveCachedAccessToken('token-1', 3600)

    expect(loadCachedAccessToken()).toBe('token-1')
  })

  it('does not return a token once it has expired', () => {
    vi.useFakeTimers()
    saveCachedAccessToken('token-1', 3600)

    vi.advanceTimersByTime(3600 * 1000 + 1)

    expect(loadCachedAccessToken()).toBeNull()
  })

  it('retires a token before it expires, not as it expires', () => {
    vi.useFakeTimers()
    saveCachedAccessToken('token-1', 600)

    // Still nominally valid, but too close to expiry to start a session with.
    vi.advanceTimersByTime(596 * 1000)

    expect(loadCachedAccessToken()).toBeNull()
  })

  it('honours a week-long Discord token lifetime', () => {
    vi.useFakeTimers()
    saveCachedAccessToken('token-1', 7 * 24 * 3600)

    vi.advanceTimersByTime(6 * 24 * 60 * 60 * 1000)

    expect(loadCachedAccessToken()).toBe('token-1')
  })

  it('never trusts a lifetime longer than Discord actually issues', () => {
    vi.useFakeTimers()
    // Guards against a malformed or hostile expires_in pinning a token indefinitely.
    saveCachedAccessToken('token-1', 365 * 24 * 3600)

    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000)

    expect(loadCachedAccessToken()).toBeNull()
  })

  it('ignores a token that would already be unusable', () => {
    saveCachedAccessToken('token-1', 10)

    expect(loadCachedAccessToken()).toBeNull()
  })

  it('can be cleared', () => {
    saveCachedAccessToken('token-1', 3600)
    clearCachedAccessToken()

    expect(loadCachedAccessToken()).toBeNull()
  })

  it('rejects a corrupted entry', () => {
    localStorage.setItem('connections:access-token', JSON.stringify({ accessToken: 7 }))

    expect(loadCachedAccessToken()).toBeNull()
  })
})

describe('when storage is unavailable', () => {
  beforeEach(() => {
    // Safari and other partitioned third-party contexts throw outright rather than
    // returning null. Every path must degrade to "nothing cached".
    const throwing = () => { throw new DOMException('denied', 'SecurityError') }
    vi.stubGlobal('localStorage', {
      getItem: throwing,
      setItem: throwing,
      removeItem: throwing,
      key: throwing,
      get length(): number { return throwing() },
      clear: throwing,
    })
  })

  it('reports a miss instead of propagating the error', () => {
    expect(() => loadCachedPuzzle('2026-08-28')).not.toThrow()
    expect(loadCachedPuzzle('2026-08-28')).toBeNull()
    expect(loadCachedAccessToken()).toBeNull()
  })

  it('swallows write failures so the caller proceeds unchanged', () => {
    expect(() => saveCachedPuzzle('2026-08-28', puzzle)).not.toThrow()
    expect(() => saveCachedAccessToken('token-1', 3600)).not.toThrow()
    expect(() => clearCachedAccessToken()).not.toThrow()
  })
})
