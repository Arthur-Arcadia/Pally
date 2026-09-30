import { randomBytes } from 'node:crypto';
import { getRandomExcuse, EXCUSE_CATEGORIES } from './excuses.js';
import { PANEL_ACTIONS, panelMessage } from './panel.js';

const privateReply = content => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
const update = content => ({ type: 7, data: { content, embeds: [], components: [], allowed_mentions: { parse: [] } } });
const announcements = {
  leave: 'is signing off for now!', decline: 'is sitting this one out!',
  cancel: 'has a change of plans!', blame: 'has an explanation!', delay: 'needs a little more time!',
};

// Only private drafts live in memory. Restarts invalidate drafts, never the panel.
export function createInteractions({ api, resultChannelId, guildId, portrait = null, picker = null, now = Date.now, randomExcuse = getRandomExcuse }) {
  const drafts = new Map();
  const socialRequests = new Map();
  const lifetime = 10 * 60 * 1000;

  function social(body) {
    if (!body.guild_id || (guildId && body.guild_id !== guildId)) {
      return { response: privateReply('Please use /social in the configured server.') };
    }
    for (const [id, expires] of socialRequests) if (expires <= now()) socialRequests.delete(id);
    const response = { type: 5, data: { flags: 64 } };
    if (socialRequests.has(body.id)) return { response };
    if (socialRequests.size >= 1000) return { response: privateReply('The bot is busy. Please try again shortly.') };
    socialRequests.set(body.id, now() + 15 * 60 * 1000);
    return {
      response,
      afterReply: async () => {
        let content;
        try {
          // A normal bot message has no command-response attribution. Never use
          // an interaction follow-up or reply reference for the public panel.
          await api(`channels/${body.channel_id}/messages`, { method: 'POST', body: {
            ...panelMessage(), nonce: body.id, enforce_nonce: true,
          } });
          content = 'The social panel is ready in this channel.';
        } catch (error) {
          content = error.status && error.status < 500
            ? 'Discord rejected the panel. Check the bot’s Send Messages and Embed Links permissions in this channel.'
            : 'Could not confirm delivery. Check this channel before trying /social again.';
        }
        await api(`webhooks/${body.application_id}/${body.token}/messages/@original`, {
          method: 'PATCH', body: { content, allowed_mentions: { parse: [] } },
        });
      },
    };
  }

  function preview(id, draft, initial) {
    if (!draft.text) return {
      type: initial ? 4 : 7,
      data: {
        ...(initial ? { flags: 64 } : {}), content: '', allowed_mentions: { parse: [] },
        embeds: [{ title: '🎭 Need an excuse?', description: 'Choose a category. Only you can see this.\nNothing is posted until you press Send.', color: 0xfee75c,
          fields: EXCUSE_CATEGORIES.map(item => ({ name: `${item.emoji} ${item.label}`, value: item.description, inline: true })),
        }],
        components: [0, 2, 4].map(start => ({ type: 1, components: EXCUSE_CATEGORIES.slice(start, start + 2).map(item => ({
          type: 2, style: 2, label: item.label, emoji: { name: item.emoji }, custom_id: `mermer:exit:category:${id}:${item.id}`,
        })) })),
      },
    };
    const category = EXCUSE_CATEGORIES.find(item => item.id === draft.actualCategory);
    return {
      type: initial ? 4 : 7,
      data: {
        ...(initial ? { flags: 64 } : {}),
        content: `Send will post this excuse in <#${draft.targetChannel}>. Nothing is posted until you confirm.\nThis preview expires after 10 minutes.`,
        embeds: [{ title: `${category.emoji} ${category.label}`, description: draft.text, color: 0xfee75c }],
        allowed_mentions: { parse: [] },
        components: [{ type: 1, components: [
          { type: 2, style: 3, label: 'Send', custom_id: `mermer:exit:send:${id}` },
          { type: 2, style: 2, label: 'Another One', custom_id: `mermer:exit:another:${id}` },
          { type: 2, style: 2, label: 'Cancel', custom_id: `mermer:exit:cancel:${id}` },
        ] }],
      },
    };
  }

  function start(body) {
    if (!body.guild_id || (guildId && body.guild_id !== guildId)) {
      return { response: privateReply('Please use the panel in the configured server.') };
    }
    for (const [id, draft] of drafts) if (draft.expires <= now()) drafts.delete(id);
    const owner = body.member?.user?.id ?? body.user?.id;
    // Re-delivery of the same interaction returns the same private draft.
    for (const [id, draft] of drafts) {
      if (draft.interactionId === body.id && draft.owner === owner) return { response: preview(id, draft, true) };
    }
    if (drafts.size >= 1000) return { response: privateReply('The bot is busy. Please try again shortly.') };
    const id = randomBytes(12).toString('hex');
    const draft = {
      owner, guild: body.guild_id, channel: body.channel_id,
      targetChannel: resultChannelId || body.channel_id,
      text: null, category: null, actualCategory: null, expires: now() + lifetime,
      status: 'open', interactionId: body.id,
    };
    drafts.set(id, draft);
    return { response: preview(id, draft, true) };
  }

  return function handle(body) {
    if (body.type === 2 && body.data?.name === 'social') return social(body);
    const action = body.data?.custom_id;
    if ((body.type === 2 && body.data?.name === 'excuse') || action === PANEL_ACTIONS.exit) return start(body);
    if (action === PANEL_ACTIONS.portrait || action?.startsWith('mermer:portrait:')) {
      return portrait ? portrait.handle(body) : { response: privateReply('Trait Picker is not configured yet. Ask the developer to set up the game voice channel.') };
    }
    if (action === PANEL_ACTIONS.picker || action?.startsWith('mermer:picker:')) {
      return picker ? picker.handle(body) : { response: privateReply('Random Pick is not configured yet. Ask the developer to set up the game voice channel.') };
    }
    const match = /^mermer:exit:(category|send|another|cancel):([a-f0-9]{24})(?::([a-z]+))?$/.exec(action ?? '');
    if (!match) return { response: privateReply('This button is no longer supported. Please use the control panel.') };
    const [, operation, id, categoryId] = match;
    const draft = drafts.get(id);
    const owner = body.member?.user?.id ?? body.user?.id;
    if (!draft || draft.expires <= now()) return { response: update('This preview expired or the bot restarted. Open Excuse Generator again.') };
    if (draft.owner !== owner || draft.channel !== body.channel_id || draft.guild !== body.guild_id) {
      return { response: privateReply('This preview belongs to another player or channel.') };
    }
    if (draft.status !== 'open') return { response: privateReply('This preview has already been handled. Please check the result channel.') };
    if (operation === 'cancel') {
      draft.status = 'cancelled';
      return { response: update('Cancelled. Nothing was posted.') };
    }
    if (operation === 'category') {
      if (draft.text || !EXCUSE_CATEGORIES.some(item => item.id === categoryId)) {
        return { response: privateReply('Please use the current excuse preview.') };
      }
      draft.category = categoryId;
      const selected = randomExcuse(categoryId);
      draft.text = selected.text;
      draft.actualCategory = selected.category ?? (categoryId === 'surprise' ? 'leave' : categoryId);
      return { response: preview(id, draft, false) };
    }
    if (!draft.text) return { response: privateReply('Please choose an excuse category first.') };
    if (operation === 'another') {
      const next = randomExcuse(draft.category, draft.text);
      draft.text = next.text;
      draft.actualCategory = next.category ?? draft.actualCategory;
      return { response: preview(id, draft, false) };
    }
    draft.status = 'sending'; // Claim synchronously, before any network awaits.
    return {
      response: { type: 6 }, // Acknowledge immediately; edit the private preview later.
      afterReply: async () => {
        let content;
        try {
          await api(`channels/${draft.targetChannel}/messages`, { method: 'POST', body: {
            content: `🎭 <@${draft.owner}> ${announcements[draft.actualCategory]}\n> ${draft.text}`,
            allowed_mentions: { parse: [], users: [draft.owner] },
            nonce: id, enforce_nonce: true,
          } });
          draft.status = 'sent';
          content = `Your excuse was sent to <#${draft.targetChannel}>.`;
        } catch (error) {
          // A timeout can mean Discord accepted the message. Never blindly resend.
          draft.status = 'failed';
          content = error.status && error.status < 500
            ? 'Discord rejected the message. Ask the team to check the bot’s channel permissions, then open a new preview.'
            : 'Could not confirm delivery. Check the result channel before opening another preview.';
        }
        await api(`webhooks/${body.application_id}/${body.token}/messages/@original`, {
          method: 'PATCH', body: update(content).data,
        });
      },
    };
  };
}
