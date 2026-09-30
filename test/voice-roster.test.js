import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createVoiceRoster } from '../voice-roster.js';

test('Gateway roster loads existing members, tracks moves, excludes bots and becomes unavailable on reconnect', () => {
  const client = new EventEmitter();
  let visible = true;
  const states = new Map([
    ['A', { id: 'A', channelId: 'game', member: { user: { id: 'A', bot: false } }, mute: true, deaf: true }],
    ['B', { id: 'B', channelId: 'lobby', member: { user: { id: 'B', bot: false } } }],
    ['bot', { id: 'bot', channelId: 'game', member: { user: { id: 'bot', bot: true } } }],
  ]);
  const guild = { available: true, voiceStates: { cache: states },
    channels: { cache: new Map([['game', { type: 2, permissionsFor: () => ({ has: () => visible }) }]]) },
  };
  client.guilds = { cache: new Map([['guild', guild]]) };
  client.users = { cache: new Map() };
  client.isReady = () => true;
  client.destroy = () => {};
  const roster = createVoiceRoster({ guildId: 'guild', channelId: 'game', client });
  let changed = 0;
  roster.subscribe(() => changed++);
  assert.equal(roster.snapshot().ready, false);
  client.emit('clientReady');
  assert.deepEqual(roster.snapshot(), { ready: true, ids: ['A'] });
  states.get('B').channelId = 'game';
  client.emit('voiceStateUpdate');
  assert.deepEqual(roster.snapshot().ids, ['A', 'B']);
  states.get('A').channelId = null;
  client.emit('voiceStateUpdate');
  assert.deepEqual(roster.snapshot().ids, ['B']);
  client.emit('shardReconnecting');
  assert.equal(roster.snapshot().ready, false);
  client.emit('shardResume');
  assert.deepEqual(roster.snapshot().ids, ['B']);
  guild.available = false;
  assert.equal(roster.snapshot().ready, false);
  guild.available = true; visible = false;
  assert.equal(roster.snapshot().ready, false);
  assert.ok(changed >= 5);
  roster.stop();
});
