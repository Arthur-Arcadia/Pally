import 'dotenv/config';
import { InstallGlobalCommands, InstallGuildCommands } from './utils.js';

const TEST_COMMAND = {
  name: 'test',
  description: 'Check that the bot is awake',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const EXCUSE_COMMAND = {
  name: 'excuse',
  description: 'Choose an excuse category, then preview and send when you are ready',
  description_localizations: null,
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const SOCIAL_COMMAND = {
  name: 'social',
  description: 'Show the social panel without publicly identifying who opened it',
  description_localizations: null,
  type: 1,
  integration_types: [0],
  contexts: [0],
  dm_permission: false,
};

const ALL_COMMANDS = [TEST_COMMAND, EXCUSE_COMMAND, SOCIAL_COMMAND];

if (process.env.GUILD_ID) {
  await InstallGuildCommands(process.env.APP_ID, process.env.GUILD_ID, ALL_COMMANDS);
  console.log('Registered guild commands for', process.env.GUILD_ID);
}

await InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
console.log('Registered global commands');
