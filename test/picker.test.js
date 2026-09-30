import test from 'node:test';
import assert from 'node:assert/strict';
import { createPicker } from '../picker.js';
import { createInteractions } from '../interactions.js';
import { createPortraitStore } from '../portrait-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const guildId = '1542404404680982550', voiceChannelId = '1542404405301878860', textChannelId = '1542404405301878856';
const A = '100000000000000010', B = '100000000000000011', C = '100000000000000012';
let id = 100000000000000100n;
const request = (action = 'mermer:panel:picker', user = C) => ({
  id: String(id++), type: 3, guild_id: guildId, channel_id: textChannelId,
  application_id: '100000000000000099', token: 'private-token',
  member: { user: { id: user } }, data: { custom_id: action },
});
function harness({ apiHook, saveHook } = {}) {
  let clock = 100_000, ids = [A, B, C], ready = true, state = { seen: [], active: null };
  const listeners = new Set(), tasks = new Set(), calls = [];
  const config = { guildId, voiceChannelId, textChannelId, now: () => clock, choose: () => 0,
    roster: { snapshot: () => ({ ready, ids: [...ids] }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
    store: { load: () => structuredClone(state), save: data => { saveHook?.(); state = structuredClone(data); } },
    api: async (path, options) => { calls.push({ path, ...structuredClone(options) }); await apiHook?.(path, options); return { id: String(id++) }; },
    schedule: (fn, delay) => { const task = { fn, due: clock + delay }; tasks.add(task); return task; },
    unschedule: task => tasks.delete(task), report: () => {},
  };
  const picker = createPicker(config);
  return { picker, config, calls, tasks, state: () => state,
    async start(user = C) { const action = picker.handle(request(undefined, user)); await action.afterReply?.(); return action; },
    current: () => calls.findLast(call => call.path.startsWith('channels/')),
    change(next, connected = true) { ids = next; ready = connected; for (const fn of listeners) fn(); },
    async advance(ms) { clock += ms; for (const task of [...tasks]) if (task.due <= clock) { tasks.delete(task); await task.fn(); } },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

async function finish(h) { await h.advance(600); await h.advance(2400); }
const display = h => JSON.stringify(h.current().body);

test('anonymous draw shows finding, rolling, result in one message and finishes in about three seconds', async () => {
  const h = harness();
  for (const body of [request(undefined, 'outsider'), { ...request(), guild_id: 'wrong' }, { ...request(), channel_id: 'wrong' }]) {
    const action = h.picker.handle(body);
    assert.equal(action.response.data.flags, 64);
    assert.equal(action.afterReply, undefined);
  }
  const trigger = request();
  const start = h.picker.handle(trigger);
  assert.deepEqual(start.response, { type: 5, data: { flags: 64 } });
  assert.equal(h.calls.length, 0);
  assert.match(h.picker.handle(request()).response.data.content, /already in progress/);
  await start.afterReply();
  const initial = h.current();
  assert.match(initial.body.content, /Finding players/);
  assert.equal(initial.body.message_reference, undefined);
  assert.equal(initial.body.interaction_metadata, undefined);
  assert.equal(initial.body.enforce_nonce, true);
  assert.equal(JSON.stringify(initial.body).includes(C), false);
  await h.advance(599);
  assert.equal(h.current(), initial);
  await h.advance(1);
  assert.match(display(h), /Rolling/);
  await h.advance(2399);
  assert.match(display(h), /Rolling/);
  await h.advance(1);
  assert.match(display(h), new RegExp(A));
  assert.match(display(h), /make the decision/);
  assert.equal(display(h).includes(C), false);
  assert.equal(h.state().active, null);
  assert.equal(h.tasks.size, 0);
  assert.deepEqual(h.current().body.components, []);
  assert.deepEqual(h.current().body.allowed_mentions, { parse: [] });
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.picker.handle(trigger).afterReply, undefined);
  assert.match(h.picker.handle(request('mermer:picker:pass:old:1')).response.data.content, /old/);
});

test('fair rotation continues across completed draws and resets only after everyone has a turn', async () => {
  const h = harness();
  for (const selected of [A, B, C, A]) {
    await h.start(); await finish(h);
    assert.match(display(h), new RegExp(selected));
    assert.deepEqual(h.current().body.components, []);
    assert.equal(h.state().active, null);
  }
});

test('leavers and late joiners are excluded; rejoining during the draw does not restore eligibility', async () => {
  const h = harness();
  h.change([A, B]);
  await h.start(B);
  await h.advance(600);
  h.change([B, C]);
  h.change([A, B, C]);
  await h.advance(2400);
  assert.match(display(h), new RegExp(B));
  assert.equal(display(h).includes(A), false);
  assert.equal(display(h).includes(C), false);
});

test('empty roster and lost Gateway close the draw and cancel pending timers', async () => {
  const h = harness();
  await h.start();
  h.change([]); await flush();
  assert.match(display(h), /everyone left/);
  assert.equal(h.state().active, null);
  assert.equal(h.tasks.size, 0);
  h.change([A, B, C]);
  await h.start(); await h.advance(600);
  h.change([A, B, C], false); await flush();
  assert.match(display(h), /interrupted/);
  assert.deepEqual(h.current().body.components, []);
  assert.equal(h.state().active, null);
  assert.equal(h.tasks.size, 0);
});

test('restart closes an interrupted draw without charging an unannounced winner a turn', async () => {
  const h = harness();
  await h.start(); await finish(h); // A completed a turn.
  await h.start(); await h.advance(600); // No winner yet.
  h.picker.dispose();
  assert.equal(JSON.stringify(h.state()).includes('private-token'), false);
  const restored = createPicker(h.config);
  assert.match(restored.handle(request()).response.data.content, /recovering/);
  await restored.recover();
  assert.match(display(h), /restarted/);
  await restored.handle(request()).afterReply();
  await finish(h);
  assert.match(display(h), new RegExp(B));
  restored.dispose();
});

test('API failures release locks and disk failures prevent a draw; no duplicate public POST', async () => {
  let failing = 'POST';
  const h = harness({ apiHook: (path, options) => {
    if (path.startsWith('channels/') && options.method === failing) throw Object.assign(new Error('denied'), { status: 403 });
  } });
  await h.start();
  assert.equal(h.state().active, null);
  assert.deepEqual(h.state().seen, []);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  failing = null;
  await h.start();
  failing = 'PATCH'; await h.advance(600);
  assert.equal(h.state().active, null);
  assert.equal(h.tasks.size, 0);
  const broken = harness({ saveHook: () => { throw new Error('disk full'); } });
  assert.equal(broken.picker.handle(request()).afterReply, undefined);
  assert.equal(broken.calls.length, 0);
});

test('voice changes during an in-flight POST or rolling edit are reconciled without stale updates', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const h = harness({ apiHook: (_path, options) => options.method === 'POST' ? wait : undefined });
  const pending = h.picker.handle(request()).afterReply();
  h.change([B, C]); release(); await pending;
  await finish(h);
  assert.match(display(h), new RegExp(B));
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  let releaseEdit;
  const editing = new Promise(resolve => { releaseEdit = resolve; });
  const other = harness({ apiHook: (path, options) => path.startsWith('channels/') && options.body.embeds?.[0]?.title.includes('Rolling') ? editing : undefined });
  await other.start();
  const rolling = other.advance(600);
  other.change([], false);
  releaseEdit(); await rolling;
  assert.match(display(other), /interrupted/);
  assert.equal(other.state().active, null);
  assert.equal(other.tasks.size, 0);
});

test('existing portrait state and picker state remain separate in the same data volume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mermer-picker-'));
  try {
    const portrait = createPortraitStore(dir, 'scope');
    const picker = createPortraitStore(dir, 'scope', 'picker-state.json');
    portrait.save({ seen: [A], active: null });
    picker.save({ seen: [B], active: null });
    assert.deepEqual(portrait.load().seen, [A]);
    assert.deepEqual(picker.load().seen, [B]);
  } finally { rmSync(dir, { recursive: true }); }
});

test('interaction router starts Random Pick and retires old pass controls', async () => {
  const h = harness();
  const handle = createInteractions({ api: h.config.api, guildId, picker: h.picker });
  await handle(request()).afterReply();
  await finish(h);
  assert.match(display(h), new RegExp(A));
  assert.match(handle(request('mermer:picker:pass:old:1')).response.data.content, /old/);
});
