import { EventEmitter } from 'node:events';
import { Client, Events, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';

// The Gateway receives voice events only; slash commands/buttons still use HTTP.
export function createVoiceRoster({ guildId, channelId, client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
}) }) {
  const events = new EventEmitter();
  let connected = false;
  const changed = () => events.emit('change');
  const online = () => { connected = true; changed(); };
  const offline = () => { connected = false; changed(); };
  client.on(Events.ClientReady, online);
  client.on(Events.ShardResume, online);
  client.on(Events.ShardDisconnect, offline);
  client.on(Events.ShardReconnecting, offline);
  client.on(Events.Invalidated, offline);
  client.on(Events.VoiceStateUpdate, changed);
  client.on(Events.GuildAvailable, changed);
  client.on(Events.GuildUnavailable, changed);
  client.on(Events.ChannelUpdate, changed);
  client.on(Events.ChannelDelete, changed);
  client.on(Events.Error, () => console.error('Discord voice connection error.'));
  client.on(Events.ShardError, () => console.error('Discord voice shard error.'));
  return {
    snapshot() {
      const guild = client.guilds.cache.get(guildId);
      const channel = guild?.channels.cache.get(channelId);
      if (!connected || !client.isReady() || !guild?.available || channel?.type !== ChannelType.GuildVoice
        || !channel.permissionsFor(client.user)?.has(PermissionFlagsBits.ViewChannel)) return { ready: false, ids: [] };
      const ids = [];
      for (const state of guild.voiceStates.cache.values()) {
        const user = state.member?.user ?? client.users.cache.get(state.id);
        if (state.channelId === channelId && user && !user.bot) ids.push(state.id);
      }
      return { ready: true, ids };
    },
    subscribe(listener) { events.on('change', listener); return () => events.off('change', listener); },
    start: token => client.login(token),
    stop() { offline(); client.destroy(); },
  };
}
