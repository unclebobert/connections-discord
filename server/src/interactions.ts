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
  storePendingActivityLaunchMessage,
  verifyDiscordInteractionRequest,
  type DiscordInteraction,
} from './discord';
import type { Bindings } from './env';

export async function handleDiscordInteraction(c: Context<{ Bindings: Bindings }>) {
  const body = await c.req.text();
  const isValidRequest = await verifyDiscordInteractionRequest(c.req.raw, body, c.env.DISCORD_PUBLIC_KEY);

  if (!isValidRequest) {
    return c.text('Invalid request signature', 401);
  }

  const interaction = JSON.parse(body) as DiscordInteraction;

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
    return c.json(createEphemeralInteractionMessage('Connections can only be launched from a server channel.'));
  }

  return c.json({ type: INTERACTION_RESPONSE_LAUNCH_ACTIVITY });
}

async function handleActivityEntryPointInteraction(c: Context<{ Bindings: Bindings }>, interaction: DiscordInteraction) {
  const launchContext = getInteractionLaunchContext(interaction);
  if (!launchContext) {
    return c.json(createEphemeralInteractionMessage('Connections can only be launched from a server channel.'));
  }

  await storePendingActivityLaunchMessage(c.env, interaction.token, launchContext);
  return c.json({ type: INTERACTION_RESPONSE_LAUNCH_ACTIVITY });
}
