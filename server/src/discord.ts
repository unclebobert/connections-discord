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
  guildId: string;
  channelId: string;
  userId: string;
  displayName: string;
};

export type ActivityMessagePlayer = {
  userId: string;
  displayName: string;
  correctGuesses: number;
  progressCells: Array<number | null>;
};

type ActivityMessageState = {
  guildId: string;
  channelId: string;
  date: string;
  messageId: string | null;
  interactionToken: string | null;
  tokenExpiresAt: number;
  lastUpdatedAt: number;
  players: ActivityMessagePlayer[];
};

type ActivityLaunchTokenState = {
  interactionToken: string;
  tokenExpiresAt: number;
};

type ActivityMessageEnv = Pick<Bindings, 'KV' | 'VITE_DISCORD_CLIENT_ID'>;

type DiscordTokenResponse = {
  access_token?: string;
  [key: string]: unknown;
};

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const INTERACTION_TOKEN_TTL_MS = 14 * 60 * 1000;
const MESSAGE_STALE_AFTER_MS = 60 * 60 * 1000;
const MESSAGE_STATE_TTL_SECONDS = 60 * 60 * 24 * 4;
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
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  const user = interaction.member?.user ?? interaction.user;

  if (!guildId || !channelId || !user) {
    return null;
  }

  return {
    guildId,
    channelId,
    userId: user.id,
    displayName: getDiscordDisplayName(user),
  };
}

export function getDiscordDisplayName(user: DiscordUser | undefined) {
  return user?.global_name || user?.username || 'Someone';
}

export async function updateActivityLaunchMessageForInteraction(
  env: ActivityMessageEnv,
  interactionToken: string,
  context: InteractionLaunchContext,
  date: string,
) {
  await putLatestActivityLaunchToken(env, context.guildId, context.channelId, interactionToken);
  await updateActivityLaunchMessage(env, {
    guildId: context.guildId,
    channelId: context.channelId,
    date,
    interactionToken,
    player: {
      userId: context.userId,
      displayName: context.displayName,
      correctGuesses: 0,
      progressCells: [],
    },
    canCreateMessage: true,
  });
}

export async function updateActivityLaunchMessageForProgress(
  env: ActivityMessageEnv,
  guildId: string,
  channelId: string,
  date: string,
  player: ActivityMessagePlayer,
) {
  const result = await updateActivityLaunchMessage(env, {
    guildId,
    channelId,
    date,
    player,
    canCreateMessage: false,
  });

  if (result !== 'needs_interaction') {
    return;
  }

  const launchToken = await getLatestActivityLaunchToken(env, guildId, channelId);
  if (!launchToken || launchToken.tokenExpiresAt <= Date.now()) {
    console.warn('activity_message:skip_no_current_launch_token', {
      guildId,
      channelId,
      date,
      hasLaunchToken: Boolean(launchToken),
    });
    return;
  }

  console.log('activity_message:reuse_current_launch_token', {
    guildId,
    channelId,
    date,
  });
  await updateActivityLaunchMessage(env, {
    guildId,
    channelId,
    date,
    player,
    interactionToken: launchToken.interactionToken,
    canCreateMessage: true,
  });
}

async function updateActivityLaunchMessage(
  env: ActivityMessageEnv,
  options: {
    guildId: string;
    channelId: string;
    date: string;
    interactionToken?: string;
    player: ActivityMessagePlayer;
    canCreateMessage: boolean;
  },
): Promise<'updated' | 'needs_interaction' | 'failed'> {
  const stateKey = getActivityMessageStateKey(options.guildId, options.channelId, options.date);
  const now = Date.now();
  const previousState = await env.KV.get<ActivityMessageState>(stateKey, { type: 'json' });
  const state = upsertActivityMessagePlayer(previousState, options, now);
  const canEditExistingMessage = Boolean(
    state.messageId &&
    state.interactionToken &&
    state.tokenExpiresAt > now &&
    now - (previousState?.lastUpdatedAt ?? 0) <= MESSAGE_STALE_AFTER_MS,
  );

  if (canEditExistingMessage) {
    console.log('activity_message:edit_attempt', {
      guildId: options.guildId,
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
      await putActivityMessageState(env, stateKey, {
        ...state,
        lastUpdatedAt: now,
      });
      console.log('activity_message:edit_sent', {
        guildId: options.guildId,
        channelId: options.channelId,
        date: options.date,
      });
      return 'updated';
    }
  }

  if (!options.canCreateMessage || !options.interactionToken) {
    console.log('activity_message:needs_fresh_interaction', {
      guildId: options.guildId,
      channelId: options.channelId,
      date: options.date,
      reason: previousState?.lastUpdatedAt && now - previousState.lastUpdatedAt > MESSAGE_STALE_AFTER_MS
        ? 'last_update_over_one_hour'
        : 'missing_or_expired_edit_token',
    });
    await putActivityMessageState(env, stateKey, state);
    return 'needs_interaction';
  }

  console.log('activity_message:followup_attempt', {
    guildId: options.guildId,
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
    await putActivityMessageState(env, stateKey, {
      ...state,
      messageId: message.id,
      interactionToken: options.interactionToken,
      tokenExpiresAt: now + INTERACTION_TOKEN_TTL_MS,
      lastUpdatedAt: now,
    });
    console.log('activity_message:followup_sent', {
      guildId: options.guildId,
      channelId: options.channelId,
      date: options.date,
      messageId: message.id,
    });
    return 'updated';
  }

  return 'failed';
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

function createActivityMessagePayload(state: ActivityMessageState) {
  const playerNames = state.players.map((player) => player.displayName);
  const subject = formatPlayerList(playerNames);
  const progressLines = state.players.map(formatProgressRow).join('\n');

  return {
    content: `${subject} ${state.players.length === 1 ? 'was' : 'were'} playing Connections (${state.date})\n\`\`\`text\n${progressLines}\n\`\`\``,
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
  env: ActivityMessageEnv,
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
  env: ActivityMessageEnv,
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

function upsertActivityMessagePlayer(
  previousState: ActivityMessageState | null,
  options: {
    guildId: string;
    channelId: string;
    date: string;
    player: ActivityMessagePlayer;
  },
  now: number,
): ActivityMessageState {
  const previousPlayer = previousState?.players.find((player) => player.userId === options.player.userId);
  const hasNewProgress = options.player.progressCells.length > 0 || options.player.correctGuesses > 0;
  const updatedPlayer = {
    ...options.player,
    correctGuesses: Math.max(options.player.correctGuesses, previousPlayer?.correctGuesses ?? 0),
    progressCells: hasNewProgress
      ? options.player.progressCells
      : previousPlayer?.progressCells ?? [],
  };
  const players = [
    updatedPlayer,
    ...(previousState?.players ?? [])
      .filter((player) => player.userId !== options.player.userId)
      .map(normalizeActivityMessagePlayer),
  ].sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    guildId: options.guildId,
    channelId: options.channelId,
    date: options.date,
    messageId: previousState?.messageId ?? null,
    interactionToken: previousState?.interactionToken ?? null,
    tokenExpiresAt: previousState?.tokenExpiresAt ?? 0,
    lastUpdatedAt: previousState?.lastUpdatedAt ?? now,
    players,
  };
}

function normalizeActivityMessagePlayer(player: ActivityMessagePlayer): ActivityMessagePlayer {
  return {
    ...player,
    correctGuesses: player.correctGuesses ?? 0,
    progressCells: player.progressCells ?? [],
  };
}

async function putActivityMessageState(
  env: ActivityMessageEnv,
  stateKey: string,
  state: ActivityMessageState,
) {
  await env.KV.put(stateKey, JSON.stringify(state), {
    expirationTtl: MESSAGE_STATE_TTL_SECONDS,
  });
}

async function putLatestActivityLaunchToken(
  env: ActivityMessageEnv,
  guildId: string,
  channelId: string,
  interactionToken: string,
) {
  await env.KV.put(getLatestActivityLaunchTokenKey(guildId, channelId), JSON.stringify({
    interactionToken,
    tokenExpiresAt: Date.now() + INTERACTION_TOKEN_TTL_MS,
  } satisfies ActivityLaunchTokenState), {
    expirationTtl: Math.ceil(INTERACTION_TOKEN_TTL_MS / 1000),
  });
}

async function getLatestActivityLaunchToken(
  env: ActivityMessageEnv,
  guildId: string,
  channelId: string,
) {
  return env.KV.get<ActivityLaunchTokenState>(getLatestActivityLaunchTokenKey(guildId, channelId), {
    type: 'json',
  });
}

function getActivityMessageStateKey(guildId: string, channelId: string, date: string) {
  return `activity-message:${guildId}:${channelId}:${date}`;
}

function getLatestActivityLaunchTokenKey(guildId: string, channelId: string) {
  return `activity-launch-token:${guildId}:${channelId}`;
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
