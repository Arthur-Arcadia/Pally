import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../app.js';
import { PANEL_ACTIONS } from '../panel.js';
import { createPortrait } from '../portrait.js';
import { createPicker } from '../picker.js';

test('signed HTTP routes exercise Exit, Social, editable Portrait and Picker; unsigned requests fail', async () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const writes = [];
  let finishDelivery;
  const delivered = new Promise(resolve => { finishDelivery = resolve; });
  const api = async (path, options) => {
      writes.push({ path, ...options });
      if (options.method === 'PATCH') finishDelivery();
      return { id: '444444444444444444' };
  };
  let clock = 100_000, endRound, pickerStep;
  const portrait = createPortrait({ api, guildId: '111111111111111111', textChannelId: '222222222222222222',
    voiceChannelId: '333333333333333333', now: () => clock,
    roster: { snapshot: () => ({ ready: true, ids: ['777777777777777777'] }), subscribe: () => () => {} },
    store: { load: () => ({ seen: [], active: null }), save: () => {} },
    schedule: fn => { endRound = fn; return 1; }, unschedule: () => {},
  });
  const picker = createPicker({ api, guildId: '111111111111111111', textChannelId: '222222222222222222',
    voiceChannelId: '333333333333333333', now: () => clock,
    roster: { snapshot: () => ({ ready: true, ids: ['777777777777777777'] }), subscribe: () => () => {} },
    store: { load: () => ({ seen: [], active: null }), save: () => {} },
    schedule: fn => { pickerStep = fn; return 1; }, unschedule: () => {},
  });
  const app = createApp({ publicKey, guildId: '111111111111111111', resultChannelId: '333333333333333333', api, portrait, picker,
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    async function post(body) {
      const json = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = sign(null, Buffer.from(timestamp + json), keys.privateKey).toString('hex');
      const response = await fetch(`${url}/interactions`, { method: 'POST', body: json,
        headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    assert.equal(await (await fetch(url)).text(), 'ok');
    assert.equal((await fetch(`${url}/interactions`, { method: 'POST', body: '{}' })).status, 401);
    assert.deepEqual(await post({ type: 1 }), { type: 1 });
    const base = { type: 3, id: '555555555555555555', guild_id: '111111111111111111',
      channel_id: '222222222222222222', application_id: '666666666666666666', token: 'fake-test-token',
      member: { user: { id: '777777777777777777' } },
    };
    const menu = await post({ ...base, data: { custom_id: PANEL_ACTIONS.exit } });
    assert.equal(menu.data.flags, 64);
    const preview = await post({ ...base, data: { custom_id: menu.data.components[0].components[0].custom_id } });
    assert.equal(writes.length, 0);
    const sendId = preview.data.components[0].components[0].custom_id;
    assert.deepEqual(await post({ ...base, id: '888888888888888888', data: { custom_id: sendId } }), { type: 6 });
    await delivered;
    assert.equal(writes.length, 2);
    assert.equal(writes[0].path, 'channels/333333333333333333/messages');
    assert.deepEqual(writes[1].body.components, []);
    const socialDone = new Promise(resolve => { finishDelivery = resolve; });
    assert.deepEqual(await post({ ...base, type: 2, id: '999999999999999999', data: { name: 'social' } }),
      { type: 5, data: { flags: 64 } });
    await socialDone;
    assert.equal(writes.length, 4);
    assert.equal(writes[2].path, 'channels/222222222222222222/messages');
    assert.equal(writes[2].body.components[0].components.length, 3);
    assert.equal(JSON.stringify(writes[2].body).includes(base.member.user.id), false);
    const portraitDone = new Promise(resolve => { finishDelivery = resolve; });
    assert.deepEqual(await post({ ...base, id: '999999999999999998', data: { custom_id: PANEL_ACTIONS.portrait } }),
      { type: 5, data: { flags: 64 } });
    await portraitDone;
    assert.equal(writes[4].path, 'channels/222222222222222222/messages');
    assert.equal(writes[4].body.interaction_metadata, undefined);
    const open = writes[4].body.components[0].components[0].custom_id;
    const chooser = await post({ ...base, data: { custom_id: open } });
    assert.equal(chooser.data.flags, 64);
    const choice = chooser.data.components[0].components[0];
    const draft = await post({ ...base, data: { custom_id: choice.custom_id } });
    assert.equal(draft.data.components.length, 3);
    const submit = draft.data.components.flatMap(row => row.components).find(b => b.label === 'Submit');
    const submitted = await post({ ...base, data: { custom_id: submit.custom_id } });
    assert.equal(submitted.type, 7);
    assert.deepEqual(submitted.data.components, []);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clock, 100_000); // No waiting for the deadline in a one-player round.
    assert.ok(JSON.stringify(writes.findLast(call => call.path.startsWith('channels/')).body).toLowerCase().includes(choice.label.toLowerCase()));
    assert.match(writes.at(-1).body.content, /Submitted/);
    assert.deepEqual(writes.at(-1).body.components, []);
    const pickerDone = new Promise(resolve => { finishDelivery = resolve; });
    assert.deepEqual(await post({ ...base, id: '999999999999999997', data: { custom_id: PANEL_ACTIONS.picker } }),
      { type: 5, data: { flags: 64 } });
    await pickerDone;
    const pickerMessage = writes.findLast(call => call.path.startsWith('channels/')).body;
    assert.match(pickerMessage.content, /Finding players/);
    assert.equal(pickerMessage.interaction_metadata, undefined);
    await pickerStep();
    assert.match(JSON.stringify(writes.findLast(call => call.path.startsWith('channels/')).body), /Rolling/);
    await pickerStep();
    const ended = writes.findLast(call => call.path.startsWith('channels/')).body;
    assert.match(JSON.stringify(ended), /make the decision/);
    assert.deepEqual(ended.components, []);
  } finally {
    portrait.dispose();
    picker.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
