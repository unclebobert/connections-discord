import type { Bindings } from './env';

export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

type DiscordGuild = {
  id: string;
};

export type PlayerProfile = {
  displayName: string;
  avatarUrl: string | null;
};

export type DiscordInteraction = {
  type: number;
  guild_id?: string;
  channel_id?: string;
  token: string;
  data?: {
    custom_id?: string;
    type?: number;
  };
  member?: {
    user?: DiscordUser;
  };
  user?: DiscordUser;
};

export type InteractionLaunchContext = {
  guildId: string;
  channelId: string;
  displayName: string;
};

type PendingActivityLaunchMessage = InteractionLaunchContext & {
  interactionToken: string;
  expiresAt: number;
};

type DiscordTokenResponse = {
  access_token?: string;
  [key: string]: unknown;
};

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const INTERACTION_TOKEN_TTL_MS = 14 * 60 * 1000;
export const INTERACTION_TYPE_PING = 1;
export const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
export const INTERACTION_TYPE_MESSAGE_COMPONENT = 3;
export const INTERACTION_RESPONSE_PONG = 1;
export const INTERACTION_RESPONSE_CHANNEL_MESSAGE = 4;
export const INTERACTION_RESPONSE_LAUNCH_ACTIVITY = 12;
export const COMMAND_TYPE_PRIMARY_ENTRY_POINT = 4;
export const ACTIVITY_BUTTON_CUSTOM_ID = 'connections:play';

export function createEphemeralInteractionMessage(content: string) {
  return {
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
    data: {
      content,
      flags: 64,
    },
  };
}

export function getInteractionLaunchContext(interaction: DiscordInteraction) {
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;

  if (!guildId || !channelId) {
    return null;
  }

  return {
    guildId,
    channelId,
    displayName: getDiscordDisplayName(interaction.member?.user ?? interaction.user),
  };
}

export function getDiscordDisplayName(user: DiscordUser | undefined) {
  return user?.global_name || user?.username || 'Someone';
}

export async function storePendingActivityLaunchMessage(
  env: Bindings,
  interactionToken: string,
  context: InteractionLaunchContext,
) {
  await env.KV.put(getPendingActivityLaunchMessageKey(context.guildId), JSON.stringify({
    ...context,
    interactionToken,
    expiresAt: Date.now() + INTERACTION_TOKEN_TTL_MS,
  } satisfies PendingActivityLaunchMessage), {
    expirationTtl: Math.ceil(INTERACTION_TOKEN_TTL_MS / 1000),
  });
}

export async function sendActivityLaunchMessageAfterFirstGuess(
  env: Bindings,
  guildId: string,
  date: string,
  displayName: string,
) {
  const sentKey = getSentActivityLaunchMessageKey(guildId, date);
  const hasSentMessage = await env.KV.get(sentKey);
  if (hasSentMessage) {
    return;
  }

  const pendingKey = getPendingActivityLaunchMessageKey(guildId);
  const pendingMessage = await env.KV.get<PendingActivityLaunchMessage>(pendingKey, { type: 'json' });
  if (!pendingMessage || pendingMessage.expiresAt <= Date.now()) {
    return;
  }

  const didSend = await createInteractionFollowup(
    env,
    pendingMessage.interactionToken,
    createActivityMessagePayload(displayName),
  );

  if (didSend) {
    await Promise.all([
      env.KV.put(sentKey, '1', { expirationTtl: 60 * 60 * 24 * 4 }),
      env.KV.delete(pendingKey),
    ]);
  }
}

export async function verifyDiscordInteractionRequest(request: Request, body: string, publicKey: string) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');

  if (!signature || !timestamp || !publicKey) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

    return crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(`${timestamp}${body}`),
    );
  } catch (error) {
    console.error('Unable to verify Discord interaction signature:', error);
    return false;
  }
}

export async function exchangeDiscordCode(env: Bindings, code: string) {
  const clientId = env.VITE_DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const missingCredentials = [
    !clientId ? 'VITE_DISCORD_CLIENT_ID' : null,
    !clientSecret ? 'DISCORD_CLIENT_SECRET' : null,
  ].filter((name) => name !== null);

  if (missingCredentials.length > 0) {
    console.error('Discord OAuth credentials are not configured:', missingCredentials);
    return {
      ok: false as const,
      status: 500 as const,
      error: 'Discord OAuth credentials are not configured',
    };
  }

  if (!/^\d{12,24}$/.test(clientId)) {
    console.error('Discord client ID is malformed:', {
      length: clientId.length,
      prefix: clientId.slice(0, 4),
      suffix: clientId.slice(-4),
    });
    return {
      ok: false as const,
      status: 500 as const,
      error: 'Discord OAuth credentials are malformed',
    };
  }

  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = await response.json<DiscordTokenResponse>();

  if (!response.ok) {
    console.error('Discord token exchange failed:', data);
    return {
      ok: false as const,
      status: response.status as 400 | 401 | 500,
      error: 'Discord token exchange failed',
    };
  }

  return {
    ok: true as const,
    data,
  };
}

export async function validateDiscordAccess(
  accessToken: string,
  expectedUserId: string,
  expectedGuildId: string,
): Promise<{ ok: true; profile: PlayerProfile } | { ok: false; status: 401 | 403 | 502; error: string }> {
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  };
  const [userResponse, guildsResponse] = await Promise.all([
    fetch('https://discord.com/api/users/@me', {
      headers: authHeaders,
    }),
    fetch('https://discord.com/api/users/@me/guilds', {
      headers: authHeaders,
    }),
  ]);

  if (userResponse.status === 401 || guildsResponse.status === 401) {
    return { ok: false, status: 401, error: 'Invalid access token' };
  }

  if (!userResponse.ok) {
    return { ok: false, status: 502, error: 'Unable to verify Discord user' };
  }

  const user = await userResponse.json<DiscordUser>();
  if (user.id !== expectedUserId) {
    return { ok: false, status: 403, error: 'Access token does not match user' };
  }

  if (!guildsResponse.ok) {
    return { ok: false, status: 502, error: 'Unable to verify Discord guild access' };
  }

  const guilds = await guildsResponse.json<DiscordGuild[]>();
  if (!guilds.some((guild) => guild.id === expectedGuildId)) {
    return { ok: false, status: 403, error: 'User is not a member of this guild' };
  }

  return {
    ok: true,
    profile: {
      displayName: user.global_name || user.username,
      avatarUrl: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=80`
        : null,
    },
  };
}

function createActivityMessagePayload(displayName: string) {
  return {
    content: `${displayName} was playing Connections`,
    allowed_mentions: {
      parse: [],
    },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: 'Play now!',
            custom_id: ACTIVITY_BUTTON_CUSTOM_ID,
          },
        ],
      },
    ],
  };
}

async function createInteractionFollowup(
  env: Bindings,
  interactionToken: string,
  payload: ReturnType<typeof createActivityMessagePayload>,
) {
  const response = await fetch(`${DISCORD_API_BASE_URL}/webhooks/${env.VITE_DISCORD_CLIENT_ID}/${interactionToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error('Unable to create activity followup message:', response.status, await response.text());
    return false;
  }

  return true;
}

function getPendingActivityLaunchMessageKey(guildId: string) {
  return `pending-activity-launch-message:${guildId}`;
}

function getSentActivityLaunchMessageKey(guildId: string, date: string) {
  return `sent-activity-launch-message:${guildId}:${date}`;
}

function hexToBytes(hex: string) {
  if (hex.length % 2 !== 0 || !/^[\da-f]+$/i.test(hex)) {
    throw new Error('Invalid hex string length');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }

  return bytes;
}
