import { createVoiceRoster } from './voice-roster.js';
import { createPortraitStore } from './portrait-store.js';
import { createPortrait } from './portrait.js';
import { createPicker } from './picker.js';

export function createPortraitRuntime({ api, env = process.env }) {
  const { GUILD_ID: guildId, GAME_VOICE_CHANNEL_ID: voiceChannelId, SOCIAL_TEXT_CHANNEL_ID: textChannelId } = env;
  if (![guildId, voiceChannelId, textChannelId].every(id => /^\d{17,20}$/.test(id ?? ''))) {
    console.log('Player Portrait needs GUILD_ID, GAME_VOICE_CHANNEL_ID and SOCIAL_TEXT_CHANNEL_ID.');
    return null;
  }
  const roster = createVoiceRoster({ guildId, channelId: voiceChannelId });
  const store = createPortraitStore(env.STATE_DIR || './data', `${guildId}:${voiceChannelId}:${textChannelId}`);
  let portrait, picker;
  try {
    portrait = createPortrait({ api, roster, store, guildId, voiceChannelId, textChannelId });
    const pickerStore = createPortraitStore(env.STATE_DIR || './data', `${guildId}:${voiceChannelId}:${textChannelId}`, 'picker-state.json');
    picker = createPicker({ api, roster, store: pickerStore, guildId, voiceChannelId, textChannelId });
  } catch (error) { portrait?.dispose(); roster.stop(); throw error; }
  let retry, stopped = false;
  async function connect() {
    try { await roster.start(env.DISCORD_TOKEN); console.log('Game voice member tracking connected.'); }
    catch {
      console.error('Could not connect voice tracking; retrying in 30 seconds.');
      if (!stopped) { retry = setTimeout(connect, 30_000); retry.unref(); }
    }
  }
  return {
    portrait, picker,
    async start() { await Promise.all([portrait.recover(), picker.recover()]); if (!stopped) await connect(); },
    stop() { stopped = true; clearTimeout(retry); portrait.dispose(); picker.dispose(); roster.stop(); },
  };
}
