import { randomInt } from 'node:crypto';

const closed = content => ({ content, components: [], embeds: [], allowed_mentions: { parse: [] } });
const reply = content => ({ response: { type: 4, data: { ...closed(content), flags: 64 } } });

// One public message moves from finding -> rolling -> result. Timers never send a second draw.
export function createPicker({ api, roster, store, guildId, voiceChannelId, textChannelId,
  now = Date.now, choose = length => randomInt(length), schedule = setTimeout, unschedule = clearTimeout,
  report = () => console.error('Random Pick failed; check connection, permissions and data volume.'),
}) {
  let { seen, active: interrupted } = store.load();
  let active = null, healthy = true, recovering = Boolean(interrupted), disposed = false;
  const requests = new Map();
  function save() {
    try { store.save({ seen, active: active ? { channel: textChannelId, message: active.message ?? null } : null }); }
    catch (error) { healthy = false; throw error; }
  }
  function eligibility(body) {
    if (body.guild_id !== guildId) return 'Please use this panel in the configured server.';
    if (body.channel_id !== textChannelId) return `Please use the panel in <#${textChannelId}>.`;
    if (!healthy || recovering) return 'Random Pick is recovering. Please try again shortly.';
    const snapshot = roster.snapshot();
    if (!snapshot.ready) return 'The game voice channel is not ready. Please wait for the bot to reconnect.';
    if (!snapshot.ids.includes(body.member?.user?.id)) return `Join <#${voiceChannelId}> to participate.`;
    return null;
  }
  async function privateResult(body, content) {
    await api(`webhooks/${body.application_id}/${body.token}/messages/@original`, { method: 'PATCH', body: closed(content) });
  }
  function candidates(round) {
    const snapshot = roster.snapshot();
    if (!snapshot.ready || round.disconnected) return [];
    return snapshot.ids.filter(id => round.members.has(id) && !round.departed.has(id));
  }
  function unavailable(round) {
    if (!roster.snapshot().ready || round.disconnected) return 'Random Pick ended because the voice connection was interrupted. Please try again.';
    if (!candidates(round).length) return 'Random Pick ended because everyone left the game voice channel.';
    return null;
  }
  async function end(round, content, embed) {
    if (active !== round || round.status === 'closing') return;
    round.status = 'closing'; unschedule(round.timer);
    try {
      if (round.message) await api(`channels/${textChannelId}/messages/${round.message}`, {
        method: 'PATCH', body: { ...closed(content), ...(embed ? { embeds: [embed] } : {}) },
      });
    } catch { report(); }
    finally { active = null; try { save(); } catch { report(); } }
  }
  function later(round, fn, delay) {
    if (disposed || active !== round) return;
    round.timer = schedule(() => fn(round).catch(report), delay);
    round.timer?.unref?.();
  }
  async function reveal(round) {
    if (disposed || active !== round || round.status !== 'rolling') return;
    const reason = unavailable(round);
    if (reason) return end(round, reason);
    const ids = candidates(round);
    let pool = ids.filter(id => !seen.includes(id));
    if (!pool.length) { seen = []; pool = ids; }
    const target = pool[choose(pool.length)];
    seen.push(target);
    try { save(); }
    catch { report(); return end(round, 'Random Pick could not save the result. Please try again later.'); }
    await end(round, '', {
      title: '🎉 A player has been selected!', color: 0x5865f2,
      description: `**<@${target}>**\nYou get to make the decision!`,
      footer: { text: 'Random Pick · Pally Together!' },
    });
  }
  async function roll(round) {
    if (disposed || active !== round || round.status !== 'finding') return;
    const reason = unavailable(round);
    if (reason) return end(round, reason);
    round.status = 'updating';
    try {
      // A compact roster keeps the embed within Discord's size limit, even in a large voice room.
      const ids = candidates(round);
      const list = ids.slice(0, 12).map(id => `<@${id}>`).join('\n');
      await api(`channels/${textChannelId}/messages/${round.message}`, { method: 'PATCH', body: {
        ...closed(''), embeds: [{ title: '🎲 Rolling…', color: 0x5865f2,
          description: `${list}${ids.length > 12 ? '\n…and more players in the game voice channel.' : ''}\n\nThe result is coming…`,
        }],
      } });
      if (disposed) return;
      const changed = unavailable(round);
      if (changed) return end(round, changed);
      round.status = 'rolling';
      later(round, reveal, 2400);
    } catch { report(); await end(round, 'Random Pick could not continue. Please start a new draw from /social.'); }
  }
  const unsubscribe = roster.subscribe(() => {
    const round = active;
    if (!round || round.status === 'closing') return;
    const snapshot = roster.snapshot();
    if (!snapshot.ready) round.disconnected = true;
    else for (const id of round.members) if (!snapshot.ids.includes(id)) round.departed.add(id);
    // Do not race an in-flight message edit; roll/reveal reconcile the latest roster.
    if (['finding', 'rolling'].includes(round.status)) {
      const reason = unavailable(round);
      if (reason) void end(round, reason).catch(report);
    }
  });
  function start(body) {
    const error = eligibility(body);
    if (error) return reply(error);
    for (const [id, expires] of requests) if (expires <= now()) requests.delete(id);
    if (requests.has(body.id)) return reply('This request has already been handled. Please check the channel.');
    if (active) return reply('A Random Pick is already in progress.');
    if (requests.size >= 1000) return reply('Please try again shortly.');
    const round = { members: new Set(roster.snapshot().ids), departed: new Set(), status: 'preparing' };
    active = round;
    try { save(); }
    catch { active = null; report(); return reply('Random Pick could not save its state. Please check the data volume.'); }
    requests.set(body.id, now() + 15 * 60 * 1000);
    return {
      response: { type: 5, data: { flags: 64 } },
      afterReply: async () => {
        try {
          const sent = await api(`channels/${textChannelId}/messages`, { method: 'POST', body: {
            ...closed('🔎 **Finding players in the game voice channel…**'), nonce: body.id, enforce_nonce: true,
          } });
          round.message = sent.id; save();
          const reason = unavailable(round);
          if (reason) await end(round, reason);
          else { round.status = 'finding'; later(round, roll, 600); }
        } catch {
          await end(round, 'Random Pick could not start. Please try again later.');
          await privateResult(body, 'Could not confirm the draw. Check the channel before trying again.');
          return;
        }
        await privateResult(body, 'Random Pick is running in this channel.');
      },
    };
  }
  return {
    handle(body) {
      if (body.data?.custom_id === 'mermer:panel:picker') return start(body);
      return reply('This is an old Random Pick control. Open the current panel with /social.');
    },
    async recover() {
      if (!interrupted) return;
      try {
        if (interrupted.message) await api(`channels/${interrupted.channel}/messages/${interrupted.message}`, {
          method: 'PATCH', body: closed('This Random Pick ended when the bot restarted. Start a new draw from /social.'),
        });
      } catch { report(); }
      finally { interrupted = null; recovering = false; save(); }
    },
    dispose() { disposed = true; unsubscribe(); if (active?.timer) unschedule(active.timer); },
  };
}
