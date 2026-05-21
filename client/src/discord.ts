import { DiscordSDK } from '@discord/embedded-app-sdk'

type DiscordAuth = Awaited<ReturnType<DiscordSDK['commands']['authenticate']>>

export interface DiscordSession {
  accessToken: string
  guildId: string | null
  user: DiscordAuth['user']
}

const discordSDK = import.meta.env.DEV ?
  null :
  new DiscordSDK(import.meta.env.VITE_CLIENT_ID)

async function setupDiscordSDK(): Promise<DiscordSession | null> {
  if (!discordSDK) {
    throw new Error('Discord SDK is not being used in this environment')
  }

  await discordSDK.ready()
  console.log('Discord SDK is ready!')

  const { code } = await discordSDK.commands.authorize({
    client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: [
      'identify',
      'guilds',
      'applications.commands',
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
  const { access_token } = await response.json()

  const auth = await discordSDK.commands.authenticate({ access_token })
  if (!auth) {
    throw new Error('Failed to authenticate with Discord SDK')
  }

  console.log('Authenticated with Discord SDK', auth)

  return {
    accessToken: auth.access_token,
    guildId: discordSDK.guildId,
    user: auth.user,
  }
}

export const discordSessionPromise = setupDiscordSDK()
  .catch((error) => {
    if (error instanceof Error && error.message === 'Discord SDK is not being used in this environment') {
      console.log('Dev environment: Discord SDK not initialized')
      return null
    }

    throw error
  })
