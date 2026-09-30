import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortrait } from '../portrait.js';
import { createPortraitStore } from '../portrait-store.js';
import { portraitText, WORDS } from '../portrait-text.js';
import { createInteractions } from '../interactions.js';

const guildId = '1542404404680982550', voiceChannelId = '1542404405301878860', textChannelId = '100000000000000001';
const A = '100000000000000010', B = '100000000000000011', C = '100000000000000012';
let nextId = 100000000000000100n;
function body(action = 'mermer:panel:portrait', user = B, values) {
  return { id: String(nextId++), type: 3, guild_id: guildId, channel_id: textChannelId,
    application_id: '100000000000000020', token: `private-test-token-${nextId}`,
    member: { user: { id: user } }, data: { custom_id: action, ...(values ? { values } : {}) } };
}
function harness({ saved, apiHook, saveHook } = {}) {
  let clock = 100_000, ids = [A, B], ready = true, state = saved ?? { seen: [], active: null };
  const listeners = new Set(), tasks = new Set(), calls = [], reports = [];
  const store = { load: () => structuredClone(state), save: data => { saveHook?.(data); state = structuredClone(data); } };
  const roster = {
    snapshot: () => ({ ready, ids: [...ids] }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const config = { guildId, voiceChannelId, textChannelId, roster, store, now: () => clock, choose: () => 0,
    api: async (path, options) => {
      calls.push({ path, ...structuredClone(options) });
      await apiHook?.(path, options);
      return { id: String(nextId++) };
    },
    schedule: (fn, delay) => { const task = { fn, due: clock + delay }; tasks.add(task); return task; },
    unschedule: task => tasks.delete(task), report: () => reports.push('error'),
  };
  const portrait = createPortrait(config);
  return { portrait, config, calls, reports, store, tasks,
    state: () => state,
    async advance(ms) { clock += ms; for (const task of [...tasks]) if (task.due <= clock) { tasks.delete(task); await task.fn(); } },
    change(next, connected = true) { ids = next; ready = connected; for (const fn of listeners) fn(); },
    async start(user = B) {
      const response = portrait.handle(body(undefined, user));
      if (response.afterReply) await response.afterReply();
      return response;
    },
    open(user = B) {
      const prompt = calls.findLast(call => call.method === 'POST');
      const opened = portrait.handle(body(prompt.body.components[0].components[0].custom_id, user));
      void opened.afterReply?.();
      return opened.response;
    },
  };
}
const buttons = view => view.data.components.flatMap(row => row.components);
const select = (view, word) => buttons(view).find(button => word ? button.custom_id.endsWith(`:${word}`) : button.custom_id.includes(':word:')).custom_id;
const refresh = view => buttons(view).find(button => button.label === 'Other…').custom_id;
const submit = view => buttons(view).find(button => button.label === 'Submit').custom_id;
const resultText = h => JSON.stringify(result(h)?.body);
const result = h => h.calls.findLast(call => call.path.startsWith('channels/') && call.method === 'PATCH');

test('all word pairs and the full vocabulary produce deterministic prose including every valid word', () => {
  for (const words of [[], WORDS, ...WORDS.flatMap(a => WORDS.map(b => [a, b]))]) {
    const output = portraitText(words);
    assert.deepEqual(output, portraitText([...words].reverse().concat(words)));
    assert.doesNotMatch(JSON.stringify(output), /\p{Script=Han}/u);
    assert.ok(output.title && output.sentence && output.sentence.length < 1500);
    for (const word of words) assert.ok(output.sentence.includes(word));
  }
  assert.equal(portraitText(['lucky', 'adventurous']).title, 'The Accidental Expedition Leader');
  assert.deepEqual(portraitText(['untrusted insult']), portraitText([]));
});

test('only bound voice members in the bound text channel may start; disconnects fail closed', () => {
  const h = harness();
  for (const request of [body(undefined, C), { ...body(), guild_id: 'wrong' }, { ...body(), channel_id: 'wrong' }]) {
    const response = h.portrait.handle(request);
    assert.equal(response.response.data.flags, 64);
    assert.equal(response.afterReply, undefined);
  }
  h.change([A, B], false);
  assert.match(h.portrait.handle(body()).response.data.content, /not ready/);
  assert.equal(h.calls.length, 0);
});

test('anonymous start is acknowledged before publishing; simultaneous and replayed triggers do not duplicate rounds', async () => {
  const h = harness();
  const request = body();
  const start = h.portrait.handle(request);
  assert.deepEqual(start.response, { type: 5, data: { flags: 64 } });
  assert.equal(h.calls.length, 0);
  assert.match(h.portrait.handle(body()).response.data.content, /already in progress/);
  await start.afterReply();
  const publicMessage = h.calls[0];
  assert.equal(publicMessage.path, `channels/${textChannelId}/messages`);
  assert.match(publicMessage.body.content, new RegExp(A));
  assert.equal(JSON.stringify(publicMessage.body).includes(B), false);
  assert.equal(publicMessage.body.message_reference, undefined);
  assert.equal(publicMessage.body.interaction_metadata, undefined);
  assert.deepEqual(publicMessage.body.allowed_mentions, { parse: [] });
  assert.equal(publicMessage.body.enforce_nonce, true);
  await h.advance(30_000);
  assert.equal(h.portrait.handle(request).afterReply, undefined);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('one highlighted draft can change; Submit locks it and prevents a second submission', async () => {
  const h = harness();
  await h.start();
  let view = h.open(A);
  assert.equal(view.data.flags, 64);
  assert.equal(buttons(view).find(b => b.label === 'Submit').disabled, true);
  const stale = select(view);
  const invalid = stale.replace(/:[a-z-]+$/, ':injected');
  assert.match(h.portrait.handle(body(invalid, A)).response.data.content, /displayed words/);
  view = h.portrait.handle(body(select(view, 'supportive'), A)).response;
  assert.equal(result(h), undefined);
  assert.match(view.data.content, /not submitted yet/);
  assert.equal(buttons(view).filter(b => b.style === 1).length, 1);
  assert.match(h.portrait.handle(body(stale, A)).response.data.content, /most recently/);
  view = h.portrait.handle(body(select(view, 'creative'), A)).response;
  assert.equal(buttons(view).filter(b => b.style === 1).length, 1);
  assert.equal(buttons(view).find(b => b.style === 1).label, 'Creative');
  const sent = h.portrait.handle(body(submit(view), A));
  assert.deepEqual(sent.response.data.components, []);
  await sent.afterReply();
  assert.equal(result(h), undefined); // B has not submitted.
  assert.match(h.portrait.handle(body(select(view), A)).response.data.content, /Submitted/);
  await h.advance(30_000);
  assert.match(resultText(h), /creative/);
  assert.doesNotMatch(resultText(h), /supportive when/);
  const expired = h.portrait.handle(body(select(view), A)).response;
  assert.equal(expired.type, 7);
  assert.deepEqual(expired.data.components, []);
});

test('timeout automatically submits the latest draft; Other changes options but not the deadline', async () => {
  const h = harness();
  await h.start();
  let view = h.open(A);
  const due = [...h.tasks][0].due;
  await h.advance(20_000);
  view = h.portrait.handle(body(select(view, 'funny'), A)).response;
  view = h.portrait.handle(body(refresh(view), A)).response;
  assert.equal([...h.tasks][0].due, due);
  view = h.portrait.handle(body(select(view, 'reckless'), A)).response;
  assert.equal(result(h), undefined);
  await h.advance(10_000);
  assert.match(resultText(h), /reckless/);
  assert.doesNotMatch(resultText(h), /funny even/);
  assert.ok(h.calls.some(call => call.path.startsWith('webhooks/') && /Submitted:.*reckless/i.test(call.body.content)));
});

test('solo selection does not end the round; manual Submit finishes without waiting and closes every private panel', async () => {
  const h = harness();
  h.change([A]);
  await h.start(A);
  h.open(A);
  let latest = h.open(A);
  latest = h.portrait.handle(body(select(latest, 'patient'), A)).response;
  assert.equal(result(h), undefined);
  await h.portrait.handle(body(submit(latest), A)).afterReply();
  assert.match(resultText(h), /patient/);
  assert.equal(h.tasks.size, 0);
  assert.equal(h.state().active, null);
  const cleaned = h.calls.filter(call => call.path.startsWith('webhooks/') && /Submitted/.test(call.body.content));
  assert.equal(cleaned.length, 2);
  assert.ok(cleaned.every(call => call.body.components.length === 0 && !call.body.content.includes('<t:')));
});

test('players get different button sets; everyone submitting finishes early and blanks stay blank', async () => {
  const h = harness();
  await h.start();
  let a = h.open(A), b = h.open(B);
  assert.notDeepEqual(buttons(a).map(x => x.label), buttons(b).map(x => x.label));
  a = h.portrait.handle(body(select(a, 'supportive'), A)).response;
  b = h.portrait.handle(body(select(b, 'distracted'), B)).response;
  await h.portrait.handle(body(submit(a), A)).afterReply();
  assert.equal(result(h), undefined);
  await h.portrait.handle(body(submit(b), B)).afterReply();
  assert.equal(h.tasks.size, 0);
  assert.match(resultText(h), /supportive/);
  assert.match(resultText(h), /distracted/);
  assert.ok(result(h).body.embeds[0].title);
  assert.deepEqual(result(h).body.allowed_mentions, { parse: [] });
  assert.equal(resultText(h).includes(B), false); // No author-to-word attribution.
  await h.start();
  h.open(A); h.open(B);
  await h.advance(30_000);
  assert.match(resultText(h), /Unwritten Legend/);
  const empty = h.calls.filter(call => /No word was submitted/.test(call.body.content));
  assert.equal(empty.length, 2);
  assert.ok(empty.every(call => call.path.startsWith('webhooks/') && call.body.components.length === 0));
});

test('opening a private selector at the deadline cannot leave a stale selector after its HTTP reply', async () => {
  const h = harness();
  await h.start();
  const prompt = h.calls[0].body.components[0].components[0].custom_id;
  const opening = h.portrait.handle(body(prompt, A));
  await h.advance(30_000);
  await opening.afterReply();
  assert.match(h.calls.at(-1).body.content, /No word was submitted/);
  assert.deepEqual(h.calls.at(-1).body.components, []);
});

test('new members wait until next round; leaving voters lose their word; target leaving cancels and unlocks', async () => {
  const h = harness();
  await h.start();
  const view = h.open(B);
  h.portrait.handle(body(select(view, 'lucky'), B));
  h.change([A, B, C]);
  assert.match(h.open(C).data.content, /next round/);
  h.change([A, C]);
  h.change([A, B, C]);
  await h.advance(30_000);
  assert.match(resultText(h), /Unwritten Legend/);
  await h.start(); // B is selected in the same fair rotation.
  h.change([A, C]);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(result(h).body.content, /selected player left/);
  assert.equal(h.state().active, null);
  assert.equal(h.tasks.size, 0);
  assert.ok((await h.start(A)).afterReply);
  h.portrait.dispose();
});

test('fair rotation survives restart and interrupted messages are closed without storing private selections', async () => {
  const h = harness();
  await h.start();
  h.portrait.handle(body(select(h.open(B), 'lucky'), B));
  assert.equal(JSON.stringify(h.state()).includes('lucky'), false);
  assert.equal(JSON.stringify(h.state()).includes('private-test-token'), false);
  h.portrait.dispose();
  const restored = createPortrait(h.config);
  assert.match(restored.handle(body()).response.data.content, /recovering/);
  await restored.recover();
  assert.match(result(h).body.content, /restarted/);
  await restored.handle(body()).afterReply();
  assert.match(h.calls.findLast(call => call.method === 'POST').body.content, new RegExp(B));
  restored.dispose();
});

test('publication failure, final edit failure, and lost Gateway connection cannot leave an active lock', async () => {
  let failPost = true, failPatch = false;
  const h = harness({ apiHook: (_path, options) => {
    if ((failPost && options.method === 'POST') || (failPatch && options.method === 'PATCH')) throw Object.assign(new Error('denied'), { status: 403 });
  } });
  await h.start();
  assert.equal(h.state().active, null);
  assert.deepEqual(h.state().seen, []);
  failPost = false;
  await h.start();
  failPatch = true;
  await h.advance(30_000);
  assert.equal(h.state().active, null);
  failPatch = false;
  await h.start();
  h.change([A, B], false);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(result(h).body.content, /interrupted/);
  assert.equal(h.state().active, null);
  h.change([A, B]);
  assert.ok((await h.start()).afterReply);
  h.portrait.dispose();
});

test('storage failure prevents a public round and disables unsafe further starts', () => {
  const h = harness({ saveHook: () => { throw new Error('disk full'); } });
  assert.equal(h.portrait.handle(body()).response.data.flags, 64);
  assert.equal(h.calls.length, 0);
  assert.match(h.portrait.handle(body()).response.data.content, /recovering/);
});

test('state file is persistent, scoped and refuses corrupt data rather than silently resetting fairness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mermer-portrait-'));
  try {
    const store = createPortraitStore(dir, `${guildId}:${voiceChannelId}`);
    store.save({ seen: [A], active: { channel: textChannelId, message: '100000000000000999' } });
    assert.deepEqual(createPortraitStore(dir, `${guildId}:${voiceChannelId}`).load().seen, [A]);
    assert.throws(() => createPortraitStore(dir, 'wrong-scope').load(), /different channel/);
    assert.equal(readFileSync(join(dir, 'portrait-state.json'), 'utf8').includes('token'), false);
  } finally { rmSync(dir, { recursive: true }); }
});

test('main interaction router dispatches portrait buttons and handles missing picker configuration', async () => {
  const h = harness();
  const handle = createInteractions({ api: h.config.api, guildId, portrait: h.portrait });
  const started = handle(body());
  assert.equal(started.response.type, 5);
  await started.afterReply();
  assert.match(handle(body('mermer:panel:picker', C)).response.data.content, /not configured/);
  assert.match(handle(body('mermer:panel:picker', B)).response.data.content, /not configured/);
  h.portrait.dispose();
});
