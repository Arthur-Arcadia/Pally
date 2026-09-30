import 'dotenv/config';
import express from 'express';
import { pathToFileURL } from 'node:url';
import {
  InteractionResponseType,
  InteractionType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { getRandomExcuse } from './excuses.js';
import { getRandomEmoji } from './utils.js';
import { discordApi } from './discord-api.js';
import { createInteractions } from './interactions.js';
import { createPortraitRuntime } from './portrait-runtime.js';

export function createApp({ api = discordApi, publicKey = process.env.PUBLIC_KEY, portrait = null, picker = null,
  resultChannelId = process.env.RESULT_CHANNEL_ID, guildId = process.env.GUILD_ID } = {}) {
  const app = express();
  const handleInteraction = createInteractions({ api, resultChannelId, guildId, portrait, picker });

  app.get('/', function (_req, res) {
    return res.send('ok');
  });

  app.get('/api/excuse', function (_req, res) {
    return res.json(getRandomExcuse());
  });

  app.post('/interactions', verifyKeyMiddleware(publicKey), function (req, res) {
    const { type, data } = req.body;

    if (type === InteractionType.PING) {
      return res.send({ type: InteractionResponseType.PONG });
    }

    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name } = data;

      if (name === 'test') {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `hello world ${getRandomEmoji()}`,
          },
        });
      }

      if (name === 'excuse' || name === 'social') {
        return respondToInteraction(req, res);
      }

      console.error(`unknown command: ${name}`);
      return res.status(400).json({ error: 'unknown command' });
    }

    if (type === InteractionType.MESSAGE_COMPONENT) {
      return respondToInteraction(req, res);
    }

    console.error('unknown interaction type', type);
    return res.status(400).json({ error: 'unknown interaction type' });
  });

  function respondToInteraction(req, res) {
    const { response, afterReply } = handleInteraction(req.body);
    if (afterReply) {
      res.once('finish', () => {
        afterReply().catch(() => console.error('Could not update private interaction response.'));
      });
    }
    return res.send(response);
  }

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = process.env.PORT || 3000;
  let runtime;
  try { runtime = createPortraitRuntime({ api: discordApi }); }
  catch { console.error('Multiplayer features disabled: check the state volume and channel configuration.'); }
  const server = createApp({ portrait: runtime?.portrait, picker: runtime?.picker }).listen(PORT, '0.0.0.0', () => console.log('Listening on port', PORT));
  runtime?.start().catch(() => console.error('Multiplayer features could not recover their state.'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    runtime?.stop();
    server.close();
  });
}
