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
  message?: {
    id: string;
  };
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
  guildId: string | null;
  channelId: string;
  scopeId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
};

export type ActivityMessagePlayer = {
  userId: string;
  displayName: string;
  correctGuesses: number;
  progressCells: Array<number | null>;
};

type ActivityMessageState = {
  scopeId: string;
  channelId: string;
  date: string;
  messageId: string | null;
  interactionToken: string | null;
  tokenExpiresAt: number;
  lastUpdatedAt: number;
  players: ActivityMessagePlayer[];
};

export type ActivityMessageMetadata = Omit<ActivityMessageState, 'players'>;

export type ActivityLaunchTokenState = {
  interactionToken: string;
  tokenExpiresAt: number;
};

type ActivityMessageEnv = Pick<Bindings, 'PROGRESS_ROOMS' | 'VITE_DISCORD_CLIENT_ID'>;
type DiscordApiEnv = Pick<Bindings, 'VITE_DISCORD_CLIENT_ID'>;

type DiscordTokenResponse = {
  access_token?: string;
  [key: string]: unknown;
};

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
export const INTERACTION_TOKEN_TTL_MS = 14 * 60 * 1000;
const MESSAGE_STALE_AFTER_MS = 60 * 60 * 1000;
const NAME_COLUMN_WIDTH = 14;
const MAX_DISPLAY_NAME_LENGTH = NAME_COLUMN_WIDTH - 1;
const CATEGORY_EMOJIS = ['🟨', '🟩', '🟦', '🟪'] as const;
const INCORRECT_EMOJI = '⬛';
const BLANK_EMOJI = '⬜';
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
  const guildId = interaction.guild_id ?? null;
  const channelId = interaction.channel_id;
  const user = interaction.member?.user ?? interaction.user;

  if (!channelId || !user) {
    return null;
  }

  return {
    guildId,
    channelId,
    scopeId: getActivityScopeId(guildId, channelId),
    userId: user.id,
    displayName: getDiscordDisplayName(user),
    avatarUrl: getDiscordAvatarUrl(user),
  };
}

export function getActivityScopeId(guildId: string | null | undefined, channelId: string) {
  return guildId ? `guild:${guildId}` : `dm:${channelId}`;
}

export function getDiscordDisplayName(user: DiscordUser | undefined) {
  return user?.global_name || user?.username || 'Someone';
}

function getDiscordAvatarUrl(user: DiscordUser | undefined) {
  if (!user?.id || !user.avatar) {
    return null;
  }

  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=80`;
}

export async function storeActivityLaunchTokenForInteraction(
  env: ActivityMessageEnv,
  interactionToken: string,
  context: InteractionLaunchContext,
) {
  const room = env.PROGRESS_ROOMS.getByName(context.scopeId);
  const response = await room.fetch('https://progress-room/activity/launch-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      interactionToken,
      scopeId: context.scopeId,
      channelId: context.channelId,
    }),
  });

  if (!response.ok) {
    console.error('activity_message:store_launch_token_failed', {
      scopeId: context.scopeId,
      guildId: context.guildId,
      channelId: context.channelId,
      status: response.status,
      body: await response.text(),
    });
  }
}

export async function sendActivityLaunchMessage(
  env: DiscordApiEnv,
  options: {
    scopeId: string;
    channelId: string;
    date: string;
    metadata: ActivityMessageMetadata | null;
    interactionToken?: string;
    players: ActivityMessagePlayer[];
    canCreateMessage: boolean;
  },
): Promise<
  | { result: 'updated'; metadata: ActivityMessageMetadata }
  | { result: 'needs_interaction'; metadata: ActivityMessageMetadata | null }
  | { result: 'failed'; metadata: ActivityMessageMetadata | null }
> {
  const now = Date.now();
  const state = {
    scopeId: options.scopeId,
    channelId: options.channelId,
    date: options.date,
    messageId: options.metadata?.messageId ?? null,
    interactionToken: options.metadata?.interactionToken ?? null,
    tokenExpiresAt: options.metadata?.tokenExpiresAt ?? 0,
    lastUpdatedAt: options.metadata?.lastUpdatedAt ?? now,
    players: options.players.map(normalizeActivityMessagePlayer),
  } satisfies ActivityMessageState;
  const canEditExistingMessage = Boolean(
    state.messageId &&
    state.interactionToken &&
    state.tokenExpiresAt > now &&
    now - (options.metadata?.lastUpdatedAt ?? 0) <= MESSAGE_STALE_AFTER_MS,
  );

  if (canEditExistingMessage) {
    console.log('activity_message:edit_attempt', {
      scopeId: options.scopeId,
      channelId: options.channelId,
      date: options.date,
      playerCount: state.players.length,
    });

    const didEdit = await editInteractionFollowup(
      env,
      state.interactionToken!,
      state.messageId!,
      createActivityMessagePayload(state),
    );

    if (didEdit) {
      const metadata = {
        ...getActivityMessageMetadata(state),
        lastUpdatedAt: now,
      };
      console.log('activity_message:edit_sent', {
        scopeId: options.scopeId,
        channelId: options.channelId,
        date: options.date,
      });
      return { result: 'updated', metadata };
    }
  }

  if (!options.canCreateMessage || !options.interactionToken) {
    console.log('activity_message:needs_fresh_interaction', {
      scopeId: options.scopeId,
      channelId: options.channelId,
      date: options.date,
      reason: options.metadata?.lastUpdatedAt && now - options.metadata.lastUpdatedAt > MESSAGE_STALE_AFTER_MS
        ? 'last_update_over_one_hour'
        : 'missing_or_expired_edit_token',
    });
    return { result: 'needs_interaction', metadata: options.metadata };
  }

  console.log('activity_message:followup_attempt', {
    scopeId: options.scopeId,
    channelId: options.channelId,
    date: options.date,
    playerCount: state.players.length,
  });
  const message = await createInteractionFollowup(
    env,
    options.interactionToken,
    createActivityMessagePayload(state),
  );

  if (message) {
    const metadata = {
      ...getActivityMessageMetadata(state),
      messageId: message.id,
      interactionToken: options.interactionToken,
      tokenExpiresAt: now + INTERACTION_TOKEN_TTL_MS,
      lastUpdatedAt: now,
    };
    console.log('activity_message:followup_sent', {
      scopeId: options.scopeId,
      channelId: options.channelId,
      date: options.date,
      messageId: message.id,
    });
    return { result: 'updated', metadata };
  }

  return { result: 'failed', metadata: options.metadata };
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
  expectedGuildId: string | null,
): Promise<{ ok: true; profile: PlayerProfile } | { ok: false; status: 401 | 403 | 502; error: string }> {
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  };
  const userResponse = await fetch('https://discord.com/api/users/@me', {
    headers: authHeaders,
  });

  if (userResponse.status === 401) {
    return { ok: false, status: 401, error: 'Invalid access token' };
  }

  if (!userResponse.ok) {
    return { ok: false, status: 502, error: 'Unable to verify Discord user' };
  }

  const user = await userResponse.json<DiscordUser>();
  if (user.id !== expectedUserId) {
    return { ok: false, status: 403, error: 'Access token does not match user' };
  }

  if (expectedGuildId) {
    const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: authHeaders,
    });

    if (guildsResponse.status === 401) {
      return { ok: false, status: 401, error: 'Invalid access token' };
    }

    if (!guildsResponse.ok) {
      return { ok: false, status: 502, error: 'Unable to verify Discord guild access' };
    }

    const guilds = await guildsResponse.json<DiscordGuild[]>();
    if (!guilds.some((guild) => guild.id === expectedGuildId)) {
      return { ok: false, status: 403, error: 'User is not a member of this guild' };
    }
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

function createActivityMessagePayload(state: ActivityMessageState) {
  const playerNames = state.players.map((player) => player.displayName);
  const subject = formatPlayerList(playerNames);
  const progressLines = state.players.map(formatProgressRow).join('\n');

  return {
    content: `${subject} ${state.players.length === 1 ? 'was' : 'were'} playing Connections\n\`\`\`text\n${progressLines}\n\`\`\``,
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
  env: DiscordApiEnv,
  interactionToken: string,
  payload: ReturnType<typeof createActivityMessagePayload>,
) {
  const clientId = env.VITE_DISCORD_CLIENT_ID;
  if (!clientId) {
    console.error('Unable to create activity followup message: VITE_DISCORD_CLIENT_ID is not configured');
    return null;
  }

  const response = await fetch(`${DISCORD_API_BASE_URL}/webhooks/${clientId}/${interactionToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error('Unable to create activity followup message:', response.status, await response.text());
    return null;
  }

  const message = await response.json<{ id: string }>();
  console.log('activity_message:followup_response_ok', {
    status: response.status,
  });
  return message;
}

async function editInteractionFollowup(
  env: DiscordApiEnv,
  interactionToken: string,
  messageId: string,
  payload: ReturnType<typeof createActivityMessagePayload>,
) {
  const clientId = env.VITE_DISCORD_CLIENT_ID;
  if (!clientId) {
    console.error('Unable to edit activity followup message: VITE_DISCORD_CLIENT_ID is not configured');
    return false;
  }

  const response = await fetch(
    `${DISCORD_API_BASE_URL}/webhooks/${clientId}/${interactionToken}/messages/${messageId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    console.error('Unable to edit activity followup message:', response.status, await response.text());
    return false;
  }

  return true;
}

function normalizeActivityMessagePlayer(player: ActivityMessagePlayer): ActivityMessagePlayer {
  return {
    ...player,
    correctGuesses: player.correctGuesses ?? 0,
    progressCells: player.progressCells ?? [],
  };
}

function getActivityMessageMetadata(state: ActivityMessageState): ActivityMessageMetadata {
  return {
    scopeId: state.scopeId,
    channelId: state.channelId,
    date: state.date,
    messageId: state.messageId,
    interactionToken: state.interactionToken,
    tokenExpiresAt: state.tokenExpiresAt,
    lastUpdatedAt: state.lastUpdatedAt,
  };
}

function formatProgressRow(player: ActivityMessagePlayer) {
  const name = formatPlayerNameForRow(player.displayName);
  return `${name.padEnd(NAME_COLUMN_WIDTH, ' ')}${formatProgressCells(player)} ${player.correctGuesses}/4`;
}

function formatPlayerNameForRow(displayName: string) {
  const sanitizedName = displayName.replace(/[`\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'Someone';

  if (sanitizedName.length <= MAX_DISPLAY_NAME_LENGTH) {
    return sanitizedName;
  }

  return `${sanitizedName.slice(0, MAX_DISPLAY_NAME_LENGTH - 1)}…`;
}

function formatProgressCells(player: ActivityMessagePlayer) {
  const progressCells = player.progressCells ?? [];
  const mistakesMade = progressCells.filter((cell) => cell === null).length;
  const isFinished = player.correctGuesses >= 4 || mistakesMade >= 4;
  const visibleCellCount = isFinished
    ? progressCells.length
    : Math.min(7, Math.max(4, 4 + mistakesMade, progressCells.length));
  const cells: string[] = progressCells
    .slice(0, visibleCellCount)
    .map(formatProgressCell);

  while (cells.length < visibleCellCount) {
    cells.push(BLANK_EMOJI);
  }

  return cells.join('');
}

function formatProgressCell(cell: number | null) {
  if (cell === null) {
    return INCORRECT_EMOJI;
  }

  return CATEGORY_EMOJIS[cell] ?? INCORRECT_EMOJI;
}

function formatPlayerList(names: string[]) {
  if (names.length === 0) {
    return 'Someone';
  }

  if (names.length === 1) {
    return names[0];
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }

  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
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
