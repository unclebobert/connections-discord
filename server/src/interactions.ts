import type { Context } from 'hono';
import {
  ACTIVITY_BUTTON_CUSTOM_ID,
  COMMAND_TYPE_PRIMARY_ENTRY_POINT,
  createEphemeralInteractionMessage,
  getInteractionLaunchContext,
  INTERACTION_RESPONSE_LAUNCH_ACTIVITY,
  INTERACTION_RESPONSE_PONG,
  INTERACTION_TYPE_APPLICATION_COMMAND,
  INTERACTION_TYPE_MESSAGE_COMPONENT,
  INTERACTION_TYPE_PING,
  updateActivityLaunchMessageForInteraction,
  verifyDiscordInteractionRequest,
  type DiscordInteraction,
} from './discord';
import type { Bindings } from './env';
import { getCurrentPuzzleDate } from './puzzles';

const FOLLOWUP_SEND_DELAY_MS = 250;

export async function handleDiscordInteraction(c: Context<{ Bindings: Bindings }>) {
  const body = await c.req.text();
  const isValidRequest = await verifyDiscordInteractionRequest(c.req.raw, body, c.env.DISCORD_PUBLIC_KEY);

  if (!isValidRequest) {
    console.warn('interaction:invalid_signature');
    return c.text('Invalid request signature', 401);
  }

  const interaction = JSON.parse(body) as DiscordInteraction;
  console.log('interaction:received', {
    type: interaction.type,
    dataType: interaction.data?.type ?? null,
    customId: interaction.data?.custom_id ?? null,
    guildId: interaction.guild_id ?? null,
    channelId: interaction.channel_id ?? null,
    userId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
  });

  if (interaction.type === INTERACTION_TYPE_PING) {
    return c.json({ type: INTERACTION_RESPONSE_PONG });
  }

  if (interaction.type === INTERACTION_TYPE_APPLICATION_COMMAND) {
    if (interaction.data?.type !== COMMAND_TYPE_PRIMARY_ENTRY_POINT) {
      return c.json(createEphemeralInteractionMessage('Unsupported command.'));
    }

    return handleActivityEntryPointInteraction(c, interaction);
  }

  if (
    interaction.type === INTERACTION_TYPE_MESSAGE_COMPONENT &&
    interaction.data?.custom_id === ACTIVITY_BUTTON_CUSTOM_ID
  ) {
    return handleActivityLaunchInteraction(c, interaction);
  }

  return c.json(createEphemeralInteractionMessage('Unsupported interaction.'));
}

function handleActivityLaunchInteraction(c: Context<{ Bindings: Bindings }>, interaction: DiscordInteraction) {
  const launchContext = getInteractionLaunchContext(interaction);
  if (!launchContext) {
    console.warn('interaction:launch_missing_context');
    return c.json(createEphemeralInteractionMessage('Connections can only be launched from a server channel.'));
  }

  const date = getCurrentPuzzleDate();
  c.executionCtx.waitUntil((async () => {
    await new Promise((resolve) => setTimeout(resolve, FOLLOWUP_SEND_DELAY_MS));
    await updateActivityLaunchMessageForInteraction(c.env, interaction.token, launchContext, date);
  })());
  console.log('interaction:launch_activity', {
    guildId: launchContext.guildId,
    channelId: launchContext.channelId,
    date,
  });
  return c.json({ type: INTERACTION_RESPONSE_LAUNCH_ACTIVITY });
}

function handleActivityEntryPointInteraction(c: Context<{ Bindings: Bindings }>, interaction: DiscordInteraction) {
  const launchContext = getInteractionLaunchContext(interaction);
  if (!launchContext) {
    console.warn('interaction:entrypoint_missing_context');
    return c.json(createEphemeralInteractionMessage('Connections can only be launched from a server channel.'));
  }

  const date = getCurrentPuzzleDate();
  c.executionCtx.waitUntil((async () => {
    await new Promise((resolve) => setTimeout(resolve, FOLLOWUP_SEND_DELAY_MS));
    await updateActivityLaunchMessageForInteraction(c.env, interaction.token, launchContext, date);
  })());
  console.log('interaction:entrypoint_launch_activity', {
    guildId: launchContext.guildId,
    channelId: launchContext.channelId,
    date,
  });
  return c.json({ type: INTERACTION_RESPONSE_LAUNCH_ACTIVITY });
}
