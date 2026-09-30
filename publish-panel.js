import 'dotenv/config';
import { discordApi } from './discord-api.js';
import { publishPanel } from './panel.js';

try {
  if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is required.');
  const result = await publishPanel({
    api: discordApi,
    channelId: process.env.PANEL_CHANNEL_ID,
    guildId: process.env.GUILD_ID,
    messageId: process.env.PANEL_MESSAGE_ID,
  });
  console.log(`${result.updated ? 'Updated' : 'Created'} and pinned control panel: ${result.url}`);
  console.log(`PANEL_MESSAGE_ID=${result.id}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
