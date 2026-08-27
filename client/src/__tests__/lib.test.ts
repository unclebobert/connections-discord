import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createProgressGuessMessage,
  getProgressWebSocketUrl,
  parseProgressMessage,
} from '../lib'

beforeAll(() => {
  // getProgressWebSocketUrl resolves API_BASE_URL against the page origin. The suite
  // runs without a DOM, so supply just the property it reads.
  vi.stubGlobal('window', { location: { origin: 'https://activity.example.com' } })
})

describe('getProgressWebSocketUrl', () => {
  it('builds a wss URL with every segment encoded and the token in the query', () => {
    const url = new URL(
      getProgressWebSocketUrl('guild:111', '222', '2026-08-20', '333', 'tok en/value'),
    )

    expect(url.protocol).toBe('wss:')
    // The scope separator must survive as %3A rather than splitting the path.
    expect(url.pathname.endsWith('/ws/guild%3A111/222/2026-08-20/333')).toBe(true)
    expect(url.searchParams.get('access_token')).toBe('tok en/value')
  })
})

describe('createProgressGuessMessage', () => {
  it('produces the wire shape the Durable Object parses', () => {
    expect(createProgressGuessMessage('u1', [0, 1, 2, 3])).toEqual({
      type: 'guess',
      userId: 'u1',
      guess: [0, 1, 2, 3],
    })
  })
})

describe('parseProgressMessage', () => {
  const player = { userId: 'u1', progress: [[0, 1, 2, 3]], profile: null }

  it('reads an array as a snapshot', () => {
    expect(parseProgressMessage(JSON.stringify([player]))).toEqual({
      type: 'snapshot',
      players: [player],
    })
  })

  it('treats an empty array as an empty snapshot', () => {
    expect(parseProgressMessage('[]')).toEqual({ type: 'snapshot', players: [] })
  })

  it('reads a bare object as an update', () => {
    expect(parseProgressMessage(JSON.stringify(player))).toEqual({ type: 'update', player })
  })

  it('accepts a profile when one is present', () => {
    const withProfile = {
      userId: 'u1',
      progress: [],
      profile: { displayName: 'Ada', avatarUrl: null },
    }

    expect(parseProgressMessage(JSON.stringify(withProfile))).toEqual({
      type: 'update',
      player: withProfile,
    })
  })

  it('reads the auth error frame the server sends before closing', () => {
    // Browsers cannot read the status of a failed WebSocket handshake, so this frame
    // is how a rejected token is reported. Missing it would mean retrying forever.
    expect(parseProgressMessage(JSON.stringify({ type: 'error', code: 'auth' }))).toEqual({
      type: 'error',
      code: 'auth',
    })
  })

  it('ignores an error frame it does not understand', () => {
    expect(parseProgressMessage(JSON.stringify({ type: 'error', code: 'something-else' }))).toBeNull()
  })

  it('returns null for the heartbeat reply rather than throwing', () => {
    // The client pings with 'ping' and the runtime auto-responds 'pong', which is not
    // JSON. The message handler must simply ignore it.
    expect(parseProgressMessage('pong')).toBeNull()
  })

  it.each([
    ['malformed JSON', '{not json'],
    ['a guess that is too short', JSON.stringify({ userId: 'u1', progress: [[0, 1, 2]] })],
    ['a guess that is too long', JSON.stringify({ userId: 'u1', progress: [[0, 1, 2, 3, 4]] })],
    ['non-integer positions', JSON.stringify({ userId: 'u1', progress: [[0, 1, 2, 3.5]] })],
    ['a missing userId', JSON.stringify({ progress: [] })],
    ['a non-string userId', JSON.stringify({ userId: 7, progress: [] })],
    ['a malformed profile', JSON.stringify({ userId: 'u1', progress: [], profile: { displayName: 1 } })],
    ['a retired ack frame', JSON.stringify({ type: 'ack', messageId: 'm1', player: { userId: 'u1', progress: [] } })],
    ['a JSON primitive', '42'],
    ['null', 'null'],
  ])('rejects %s', (_label, payload) => {
    expect(parseProgressMessage(payload)).toBeNull()
  })
})
