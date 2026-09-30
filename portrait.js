import { randomBytes, randomInt } from 'node:crypto';
import { WORD_GROUPS, portraitText, wordLabel } from './portrait-text.js';

const mentions = { parse: [] };
const reply = content => ({ response: { type: 4, data: { content, flags: 64, allowed_mentions: mentions } } });
const closed = content => ({ content, components: [], embeds: [], allowed_mentions: mentions });

export function createPortrait({ api, roster, store, guildId, voiceChannelId, textChannelId,
  now = Date.now, choose = length => randomInt(length), schedule = setTimeout, unschedule = clearTimeout,
  report = () => console.error('Portrait operation failed; check permissions, connection and state volume.'),
}) {
  let { seen, active: interrupted } = store.load();
  let active = null, healthy = true, recovering = Boolean(interrupted);
  const requests = new Map();
  const duration = 30_000;
  function save(round = active) {
    try {
      store.save({ seen, active: round ? { channel: round.channel, message: round.message ?? null } : null });
    } catch (error) { healthy = false; throw error; }
  }
  function eligibility(body) {
    if (body.guild_id !== guildId) return 'Please use this panel in the configured server.';
    if (body.channel_id !== textChannelId) return `Please use the panel in <#${textChannelId}>.`;
    if (!healthy || recovering) return 'Trait Picker is recovering. Please try again shortly.';
    const snapshot = roster.snapshot();
    if (!snapshot.ready) return 'The game voice channel is not ready. Please wait for the bot to reconnect, or check its channel access.';
    if (!snapshot.ids.includes(body.member?.user?.id)) return `Join <#${voiceChannelId}> to participate.`;
    return null;
  }
  async function editPrivate(body, content) {
    await api(`webhooks/${body.application_id}/${body.token}/messages/@original`, { method: 'PATCH', body: closed(content) });
  }
  function privateStatus(round, user) {
    if (round.cancelReason) return 'This round has ended. Start a new Trait Picker from /social.';
    if (round.submitted.has(user)) return `✅ Submitted: **${wordLabel(round.submitted.get(user))}**. ${round.status === 'open' ? 'Collecting the other players’ responses…' : 'This round has ended.'}`;
    return 'This round has ended. No word was submitted.';
  }
  async function cleanPanels(round, user) {
    await Promise.all([...round.panels.values()].filter(panel => panel.ready && (!user || panel.user === user)).map(async panel => {
      try { await editPrivate(panel, privateStatus(round, panel.user)); }
      catch { report(); }
    }));
  }
  function allSubmitted(round) {
    const snapshot = roster.snapshot();
    return snapshot.ready && snapshot.ids.includes(round.target)
      && snapshot.ids.filter(id => round.participants.has(id)).every(id => round.submitted.has(id));
  }
  function privateView(round, user, body, initial) {
    const rendered = view(round, user, initial);
    let panel;
    if (initial) {
      panel = { application_id: body.application_id, token: body.token, user, ready: false };
      round.panels.set(body.token, panel);
    }
    rendered.afterReply = async () => {
      if (panel) panel.ready = true;
      // The deadline can pass while the HTTP response is being delivered.
      if (round.status !== 'open' || round.submitted.has(user)) {
        if (panel) { try { await editPrivate(panel, privateStatus(round, user)); } catch { report(); } }
        else await editPrivate(body, privateStatus(round, user));
      }
    };
    return rendered;
  }
  async function finish(round, reason) {
    if (active !== round || round.status !== 'open') return;
    round.status = 'closing';
    unschedule(round.timer);
    const snapshot = roster.snapshot();
    let content = reason;
    if (!content && !snapshot.ready) content = 'Trait Picker ended because the voice connection was interrupted. Please try again.';
    if (!content && !snapshot.ids.includes(round.target)) content = 'Trait Picker ended because the selected player left the game voice channel.';
    round.cancelReason = content;
    let resultCard;
    if (!content) {
      // Finalize each remaining draft at the deadline; an untouched selector is a blank response.
      for (const [user, word] of round.choices) if (snapshot.ids.includes(user)) round.submitted.set(user, word);
      const words = [...round.choices].filter(([user]) => snapshot.ids.includes(user)).map(([, word]) => word);
      const result = portraitText(words);
      resultCard = { title: result.title, description: `**<@${round.target}>**\n\n${result.sentence}`,
        author: { name: '🎨 Group Reflection' }, color: 0x57f287,
        footer: { text: 'Built from anonymous group input · Pally Together!' } };
      content = '';
    }
    try {
      // Editing a normal bot message does not expose who triggered the round.
      await api(`channels/${round.channel}/messages/${round.message}`, { method: 'PATCH', body: { ...closed(content), ...(resultCard ? { embeds: [resultCard] } : {}) } });
    } catch { report(); }
    finally {
      await cleanPanels(round);
      round.choices.clear(); round.views.clear();
      round.panels.clear();
      active = null;
      try { save(); } catch { report(); }
    }
  }
  const unsubscribe = roster.subscribe(() => {
    const round = active;
    if (!round || round.status === 'closing') return;
    const snapshot = roster.snapshot();
    if (!snapshot.ready) round.cancelReason = 'Trait Picker ended because the voice connection was interrupted. Please try again.';
    else if (!snapshot.ids.includes(round.target)) round.cancelReason = 'Trait Picker ended because the selected player left the game voice channel.';
    // Leaving loses this round's selection; rejoining cannot restore a stale vote.
    if (snapshot.ready) for (const user of round.choices.keys()) {
      if (!snapshot.ids.includes(user)) { round.choices.delete(user); round.submitted.delete(user); }
    }
    if (round.status === 'open' && (round.cancelReason || allSubmitted(round))) void finish(round, round.cancelReason).catch(report);
  });

  function start(body) {
    const error = eligibility(body);
    if (error) return reply(error);
    for (const [id, expires] of requests) if (expires <= now()) requests.delete(id);
    if (requests.has(body.id)) return reply('This request has already been handled. Please check the channel.');
    if (active) return reply('A Trait Picker is already in progress.');
    if (requests.size >= 1000) return reply('Please try again shortly.');
    const ids = [...new Set(roster.snapshot().ids)];
    let pool = ids.filter(id => !seen.includes(id));
    const previousSeen = [...seen];
    if (!pool.length) { seen = []; pool = ids; }
    const target = pool[choose(pool.length)];
    const round = { id: randomBytes(10).toString('hex'), channel: body.channel_id,
      target, participants: new Set(ids), choices: new Map(), submitted: new Map(), views: new Map(), panels: new Map(), groupOffset: choose(WORD_GROUPS.length), status: 'preparing' };
    seen.push(target);
    active = round;
    try { save(); } catch { active = null; seen = previousSeen; report(); return reply('Trait Picker could not save its state. Please ask the developer to check the data volume.'); }
    requests.set(body.id, now() + 15 * 60 * 1000);
    return {
      response: { type: 5, data: { flags: 64 } },
      afterReply: async () => {
        try {
          round.deadline = now() + duration;
          const message = await api(`channels/${round.channel}/messages`, { method: 'POST', body: {
            content: `🎨 **Time for a review!**\nThe lucky one is… <@${target}>\nEveryone in the game voice channel, including the selected player, can share **one word** anonymously.\nChoose below, then press **Submit**, or your last choice will be submitted automatically <t:${Math.floor(round.deadline / 1000)}:R>.`,
            allowed_mentions: mentions, nonce: body.id, enforce_nonce: true,
            components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Choose Traits', custom_id: `mermer:portrait:open:${round.id}` }] }],
          } });
          round.message = message.id;
          save(round);
          round.status = 'open';
          const snapshot = roster.snapshot();
          if (!snapshot.ready) round.cancelReason = 'Trait Picker ended because the voice connection was interrupted. Please try again.';
          else if (!snapshot.ids.includes(target)) round.cancelReason = 'Trait Picker ended because the selected player left the game voice channel.';
          if (round.cancelReason) await finish(round, round.cancelReason);
          else {
            round.timer = schedule(() => finish(round).catch(report), Math.max(0, round.deadline - now()));
            round.timer?.unref?.();
          }
        } catch (error) {
          // A timed-out POST may have succeeded; never repeat it automatically.
          if (round.message) {
            round.status = 'open';
            await finish(round, 'Trait Picker could not start safely. Please try again later.');
          } else {
            active = null;
            if (error.status && error.status < 500) seen = previousSeen;
            try { save(); } catch { report(); }
          }
          await editPrivate(body, 'Could not start Trait Picker. Check the channel before trying again.');
          return;
        }
        await editPrivate(body, 'Trait Picker has been posted in this channel.');
      },
    };
  }

  function view(round, user, initial) {
    const current = round.views.get(user);
    const selected = round.choices.get(user);
    const id = operation => `mermer:portrait:${operation}:${round.id}:${current.version}`;
    const buttons = visibleWords(round, user).map(word => ({ type: 2,
      style: selected === word ? 1 : 2, label: wordLabel(word), custom_id: `${id('word')}:${word}`,
    }));
    buttons.push({ type: 2, style: 2, label: 'Other…', custom_id: id('refresh') },
      { type: 2, style: 3, label: 'Submit', disabled: !selected, custom_id: id('submit') });
    return { response: { type: initial ? 4 : 7, data: {
      ...(initial ? { flags: 64 } : {}),
      content: `🎨 **How would you describe <@${round.target}>'s performance?**\nChoose **one word**. You can change it until you press **Submit**.\n${selected ? `Selected: **${wordLabel(selected)}** — not submitted yet.` : 'No word selected yet.'}\nYour last choice is submitted automatically <t:${Math.floor(round.deadline / 1000)}:R>. Other… shows more words without extending the time.`,
      allowed_mentions: mentions,
      components: [0, 3, 6].map(start => ({ type: 1, components: buttons.slice(start, start + 3) })),
    } } };
  }
  function visibleWords(round, user) {
    const words = [...WORD_GROUPS[round.views.get(user).group]];
    const selected = round.choices.get(user);
    // Keep the current draft visible and highlighted when browsing other words.
    if (selected && !words.includes(selected)) words[words.length - 1] = selected;
    return words;
  }
  function handle(body) {
    if (body.data?.custom_id === 'mermer:panel:portrait') return start(body);
    const match = /^mermer:portrait:(open|word|submit|refresh):([a-f0-9]{20})(?::(\d+))?(?::([a-z-]+))?$/.exec(body.data?.custom_id ?? '');
    if (!match) return reply('This portrait button is no longer supported.');
    const terminal = content => match[1] === 'open' ? reply(content) : { response: { type: 7, data: closed(content) } };
    const error = eligibility(body);
    if (error) return terminal(error);
    const round = active;
    if (!round || round.id !== match[2] || round.status !== 'open' || now() >= round.deadline) {
      return terminal('This round has closed. Open a new Trait Picker from /social.');
    }
    const user = body.member.user.id;
    if (!round.participants.has(user)) return reply('You joined after this round started. You can take part in the next round.');
    if (round.submitted.has(user)) return terminal(privateStatus(round, user));
    const previous = round.views.get(user);
    if (match[1] === 'open') {
      round.views.set(user, { group: previous?.group ?? (([...round.participants].indexOf(user) + round.groupOffset) % WORD_GROUPS.length), version: (previous?.version ?? 0) + 1 });
      return privateView(round, user, body, true);
    }
    if (!previous || String(previous.version) !== match[3]) return reply('Please use your most recently opened word selector.');
    if (match[1] === 'refresh') previous.group = (previous.group + 1) % WORD_GROUPS.length;
    else if (match[1] === 'word') {
      const word = match[4];
      if (!visibleWords(round, user).includes(word)) return reply('Please choose one of the displayed words.');
      round.choices.set(user, word);
    } else {
      const word = round.choices.get(user);
      if (!word) return reply('Choose a word before submitting.');
      round.submitted.set(user, word);
      return {
        response: { type: 7, data: closed(`✅ Submitted: **${wordLabel(word)}**. ${allSubmitted(round) ? 'The group reflection is ready to reveal.' : 'Collecting the other players’ responses…'}`) },
        afterReply: async () => {
          if (round.status === 'open' && allSubmitted(round)) await finish(round);
          else await cleanPanels(round, user);
        },
      };
    }
    previous.version++;
    return privateView(round, user, body, false);
  }
  return {
    handle, eligibility,
    async recover() {
      if (!interrupted) return;
      try {
        if (interrupted.message) await api(`channels/${interrupted.channel}/messages/${interrupted.message}`, {
          method: 'PATCH', body: closed('This Trait Picker ended when the bot restarted. Start a new round from /social.'),
        });
      } catch { report(); }
      finally { interrupted = null; recovering = false; save(null); }
    },
    dispose() { unsubscribe(); if (active?.timer) unschedule(active.timer); },
  };
}
