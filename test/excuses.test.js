import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXCUSE_CATEGORIES, getRandomExcuse } from '../excuses.js';
import { createInteractions } from '../interactions.js';
import { PANEL_ACTIONS, panelMessage } from '../panel.js';

const records = JSON.parse(readFileSync(new URL('../excuses.json', import.meta.url), 'utf8'));
const guildId = '100000000000000001', channelId = '100000000000000002', user = '100000000000000003';
let id = 100000000000000010n;
const body = action => ({ type: 3, id: String(id++), guild_id: guildId, channel_id: channelId,
  application_id: '100000000000000004', token: 'fake-token', member: { user: { id: user } }, data: { custom_id: action } });
const buttons = response => response.data.components.flatMap(row => row.components);

test('English excuse library has five populated categories; rerolls stay in category and avoid the current line', () => {
  assert.equal(new Set(records.map(item => item.id)).size, records.length);
  assert.equal(new Set(records.map(item => item.text)).size, records.length);
  for (const category of EXCUSE_CATEGORIES) {
    if (category.id !== 'surprise') assert.ok(records.filter(item => item.category === category.id).length >= 8);
    let previous;
    for (let attempt = 0; attempt < 100; attempt++) {
      const next = getRandomExcuse(category.id, previous);
      assert.ok(next.text.length > 20 && next.text.length < 400);
      assert.notEqual(next.text, previous);
      if (category.id !== 'surprise') assert.equal(next.category, category.id);
      assert.doesNotMatch(next.text, /\p{Script=Han}/u);
      previous = next.text;
    }
  }
  assert.throws(() => getRandomExcuse('unknown'));
});

test('all six category paths stay private until Send; category-specific announcements match the preview exactly', async () => {
  for (const category of EXCUSE_CATEGORIES) {
    const writes = [];
    const handle = createInteractions({ guildId, resultChannelId: channelId,
      api: async (path, options) => { writes.push({ path, ...structuredClone(options) }); return { id: String(id++) }; } });
    const menu = handle(body(PANEL_ACTIONS.exit)).response;
    assert.equal(menu.data.flags, 64);
    assert.deepEqual(menu.data.components.map(row => row.components.length), [2, 2, 2]);
    const categoryButton = buttons(menu).find(button => button.custom_id.endsWith(`:${category.id}`));
    const preview = handle(body(categoryButton.custom_id)).response;
    assert.equal(preview.type, 7);
    assert.equal(writes.length, 0);
    const another = buttons(preview).find(button => button.label === 'Another One');
    const rerolled = handle(body(another.custom_id)).response;
    assert.notEqual(rerolled.data.embeds[0].description, preview.data.embeds[0].description);
    if (category.id !== 'surprise') assert.equal(rerolled.data.embeds[0].title, preview.data.embeds[0].title);
    const send = body(buttons(rerolled).find(button => button.label === 'Send').custom_id);
    const pending = handle(send);
    assert.equal(pending.response.type, 6);
    assert.equal(handle(send).afterReply, undefined);
    await pending.afterReply();
    const publicMessage = writes.find(write => write.method === 'POST').body;
    assert.ok(publicMessage.content.endsWith(rerolled.data.embeds[0].description));
    if (!rerolled.data.embeds[0].title.includes('Leave')) assert.doesNotMatch(publicMessage.content, /signing off/);
    assert.doesNotMatch(JSON.stringify(writes), /undefined|\p{Script=Han}/u);
    assert.deepEqual(writes.at(-1).body.embeds, []);
    assert.deepEqual(writes.at(-1).body.components, []);
  }
});

test('category Cancel generates a cancellation excuse; preview Cancel dismisses without posting', () => {
  const handle = createInteractions({ guildId, api: () => { assert.fail('No API writes before Send'); } });
  const menu = handle(body(PANEL_ACTIONS.exit)).response;
  const category = buttons(menu).find(button => button.label === 'Cancel');
  const preview = handle(body(category.custom_id)).response;
  assert.match(preview.data.embeds[0].title, /Cancel/);
  const cancel = buttons(preview).find(button => button.label === 'Cancel');
  const dismissed = handle(body(cancel.custom_id)).response;
  assert.match(dismissed.data.content, /Nothing was posted/);
  assert.deepEqual(dismissed.data.embeds, []);
});

test('main panel follows prototype order with native buttons and no visible internal marker', () => {
  const panel = panelMessage();
  assert.equal(panel.embeds[0].title, '🎮 Pally Together!');
  assert.deepEqual(panel.components[0].components.map(button => button.label), ['Random Pick', 'Trait Picker', 'Excuse Generator']);
  assert.equal(panel.embeds[0].footer, undefined);
});
