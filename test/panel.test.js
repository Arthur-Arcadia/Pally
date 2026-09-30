import test from 'node:test';
import assert from 'node:assert/strict';
import { panelMessage, publishPanel, PANEL_ACTIONS } from '../panel.js';
import { createInteractions } from '../interactions.js';

const guild = '100000000000000001';
const channel = '100000000000000002';
const resultChannel = '100000000000000003';
const bot = '100000000000000004';
const messageId = '100000000000000005';
const interaction = (action, user = '100000000000000006') => ({
  id: '100000000000000007', type: 3, guild_id: guild, channel_id: channel,
  application_id: bot, token: 'test-token', member: { user: { id: user } },
  data: { custom_id: action },
});

function publisherMock(existing = []) {
  const calls = [];
  const messages = [...existing];
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === 'users/@me') return { id: bot };
    if (path === `channels/${channel}`) return { type: 0, guild_id: guild };
    if (path.includes('?limit=100')) return messages;
    if (options.method === 'POST') {
      const message = { ...options.body, id: messageId, author: { id: bot } };
      messages.unshift(message);
      return message;
    }
    if (options.method === 'PATCH') return messages[0];
    if (options.method === 'PUT') return undefined;
    return messages[0];
  };
  return { calls, api };
}

test('publishing twice updates the same panel and pins using current API', async () => {
  const mock = publisherMock();
  const config = { api: mock.api, channelId: channel, guildId: guild };
  assert.equal((await publishPanel(config)).updated, false);
  assert.equal((await publishPanel(config)).updated, true);
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.ok(mock.calls.some(call => call.path === `channels/${channel}/messages/pins/${messageId}`));
  assert.equal(panelMessage().components[0].components.length, 3);
});

test('wrong guild and a foreign message ID are rejected without writes', async () => {
  const mock = publisherMock([{ id: messageId, author: { id: 'other-bot' } }]);
  await assert.rejects(publishPanel({ api: mock.api, channelId: channel, guildId: resultChannel }), /regular text channel/);
  await assert.rejects(publishPanel({ api: mock.api, channelId: channel, guildId: guild, messageId }), /not this bot/);
  assert.equal(mock.calls.filter(call => call.method).length, 0);
});

test('a failed pin reports the saved ID and rerun repairs without creating another panel', async () => {
  const mock = publisherMock();
  let failPin = true;
  const api = async (path, options) => {
    if (options?.method === 'PUT' && failPin) throw new Error('HTTP 403');
    return mock.api(path, options);
  };
  const config = { api, channelId: channel, guildId: guild };
  await assert.rejects(publishPanel(config), new RegExp(`PANEL_MESSAGE_ID=${messageId}`));
  failPin = false;
  await publishPanel(config);
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1);
});

function featureHarness() {
  const calls = [];
  let clock = 0, index = 0;
  const handle = createInteractions({ guildId: guild, resultChannelId: resultChannel,
    now: () => clock, randomExcuse: () => ({ text: `Excuse ${++index}` }),
    api: async (path, options) => { calls.push({ path, ...options }); return { id: messageId }; },
  });
  return { handle, calls, expire: () => { clock = 600_001; } };
}
function openPreview(handle, category = 0) {
  const menu = handle(interaction(PANEL_ACTIONS.exit)).response;
  return handle(interaction(menu.data.components.flatMap(row => row.components)[category].custom_id)).response;
}
const actionFrom = (response, index) => response.data.components[0].components[index].custom_id;

test('/social acknowledges privately and sends a normal panel without user attribution once', async () => {
  const { handle, calls } = featureHarness();
  const command = { ...interaction(), type: 2, data: { name: 'social' } };
  const pending = handle(command);
  assert.deepEqual(pending.response, { type: 5, data: { flags: 64 } });
  assert.equal(calls.length, 0);
  assert.equal(handle(command).afterReply, undefined);
  await pending.afterReply();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, `channels/${channel}/messages`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.components[0].components.length, 3);
  assert.equal(calls[0].body.message_reference, undefined);
  assert.equal(calls[0].body.interaction_metadata, undefined);
  assert.equal(JSON.stringify(calls[0].body).includes(command.member.user.id), false);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(calls[0].body.enforce_nonce, true);
  assert.equal(calls[1].path, `webhooks/${bot}/test-token/messages/@original`);
  assert.equal(calls[1].method, 'PATCH');
});

test('/social rejects DMs and another server privately; publication errors stay private', async () => {
  const { handle } = featureHarness();
  const command = { ...interaction(), type: 2, data: { name: 'social' } };
  for (const guild_id of [undefined, 'other-server']) {
    const rejected = handle({ ...command, guild_id });
    assert.equal(rejected.response.data.flags, 64);
    assert.equal(rejected.afterReply, undefined);
  }
  const calls = [];
  const failing = createInteractions({ guildId: guild, api: async (path, options) => {
    calls.push({ path, ...options });
    if (options.method === 'POST') throw Object.assign(new Error('forbidden'), { status: 403 });
  } });
  await failing(command).afterReply();
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.content, /permissions/);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(failing(command).afterReply, undefined);
});

test('exit preview, refresh and cancel remain private and never publish', () => {
  const { handle, calls } = featureHarness();
  const menu = handle(interaction(PANEL_ACTIONS.exit)).response;
  assert.equal(menu.data.flags, 64);
  assert.equal(menu.data.components.length, 3);
  const first = openPreview(handle);
  const refreshed = handle(interaction(actionFrom(first, 1))).response;
  assert.equal(refreshed.type, 7);
  assert.notEqual(first.data.embeds[0].description, refreshed.data.embeds[0].description);
  assert.equal(handle(interaction(actionFrom(first, 2))).response.data.components.length, 0);
  assert.equal(handle(interaction(actionFrom(first, 0))).afterReply, undefined);
  assert.equal(calls.length, 0);
});

test('confirm acknowledges first and publishes once despite duplicate clicks', async () => {
  const { handle, calls } = featureHarness();
  const preview = openPreview(handle);
  const click = interaction(actionFrom(preview, 0));
  const send = handle(click);
  assert.equal(send.response.type, 6);
  assert.equal(calls.length, 0);
  assert.equal(handle(click).afterReply, undefined);
  await send.afterReply();
  assert.equal(calls[0].path, `channels/${resultChannel}/messages`);
  assert.equal(calls[0].body.enforce_nonce, true);
  assert.match(calls[0].body.content, /Excuse 1/);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [], users: [click.member.user.id] });
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(calls[1].body.components, []);
  assert.equal(handle(click).afterReply, undefined);
});

test('another user cannot send a draft; expiration and restart invalidate old previews', () => {
  const h = featureHarness();
  const preview = openPreview(h.handle);
  const action = actionFrom(preview, 0);
  assert.equal(h.handle(interaction(action, '100000000000000099')).afterReply, undefined);
  h.expire();
  assert.match(h.handle(interaction(action)).response.data.content, /expired/);
  assert.match(featureHarness().handle(interaction(action)).response.data.content, /restarted/);
  assert.equal(h.calls.length, 0);
});

test('unconfigured portrait and future picker return private feedback without creating public activities', () => {
  const { handle, calls } = featureHarness();
  for (const action of [PANEL_ACTIONS.portrait, PANEL_ACTIONS.picker]) {
    const response = handle(interaction(action)).response;
    assert.equal(response.data.flags, 64);
    assert.match(response.data.content, /coming soon|not configured/);
  }
  assert.equal(calls.length, 0);
});

test('uncertain delivery is not automatically retried and clears Send controls', async () => {
  const calls = [];
  const handle = createInteractions({ guildId: guild, api: async (path, options) => {
    calls.push({ path, ...options });
    if (options.method === 'POST') throw new Error('timeout');
  } });
  const preview = openPreview(handle);
  const action = interaction(actionFrom(preview, 0));
  await handle(action).afterReply();
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.match(calls[1].body.content, /Check the result channel/);
  assert.equal(handle(action).afterReply, undefined);
});
