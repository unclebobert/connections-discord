import { DiscordSDK } from '@discord/embedded-app-sdk'
import {
  clearCachedAccessToken,
  loadCachedAccessToken,
  saveCachedAccessToken,
} from './storage'

type DiscordAuth = Awaited<ReturnType<DiscordSDK['commands']['authenticate']>>

export interface DiscordSession {
  accessToken: string
  guildId: string | null
  channelId: string | null
  user: DiscordAuth['user']
}

const DISCORD_CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID

const discordSDK = import.meta.env.DEV ?
  null :
  new DiscordSDK(DISCORD_CLIENT_ID)

async function setupDiscordSDK(): Promise<DiscordSession | null> {
  if (!discordSDK) {
    throw new Error('Discord SDK is not being used in this environment')
  }

  await discordSDK.ready()
  console.log('Discord SDK is ready!')

  // Reusing a token skips both the authorize round trip and the server-side code
  // exchange. Discord tokens outlive a single Activity session by days, and players
  // reopen the Activity repeatedly, so most opens can avoid /token entirely.
  const cachedAccessToken = loadCachedAccessToken()
  if (cachedAccessToken) {
    const session = await authenticateWithToken(discordSDK, cachedAccessToken)
    if (session) {
      return session
    }

    // Revoked, expired early, or issued to a different Discord account.
    clearCachedAccessToken()
  }

  const { code } = await discordSDK.commands.authorize({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: [
      'identify',
      'guilds',
    ],
  })

  const response = await fetch('/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
    }),
  })
  const { access_token, expires_in } = await response.json()

  const session = await authenticateWithToken(discordSDK, access_token)
  if (!session) {
    throw new Error('Failed to authenticate with Discord SDK')
  }

  saveCachedAccessToken(access_token, expires_in)

  return session
}

async function authenticateWithToken(
  sdk: DiscordSDK,
  accessToken: string,
): Promise<DiscordSession | null> {
  try {
    const auth = await sdk.commands.authenticate({ access_token: accessToken })
    if (!auth) {
      return null
    }

    return {
      accessToken: auth.access_token,
      guildId: sdk.guildId,
      channelId: sdk.channelId,
      user: auth.user,
    }
  } catch (error) {
    console.warn('Discord authentication failed for this access token:', error)
    return null
  }
}

let discordSessionPromise: Promise<DiscordSession | null> | null = null

/**
 * Discards the memoised session and the cached token, so the next getDiscordSession()
 * runs the full authorize/exchange flow. Used when the server rejects a token that
 * Discord itself accepted — for example one belonging to a user who is not in this
 * guild, which no amount of retrying will fix.
 */
export function resetDiscordSession() {
  discordSessionPromise = null
  clearCachedAccessToken()
}

export function getDiscordSession() {
  discordSessionPromise ??= setupDiscordSDK()
    .catch((error) => {
      if (error instanceof Error && error.message === 'Discord SDK is not being used in this environment') {
        console.log('Dev environment: Discord SDK not initialized')
        return null
      }

      throw error
    })

  return discordSessionPromise
}
