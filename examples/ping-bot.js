'use strict';

/**
 * A minimal Voxara bot, written against sdk/voxara-bot.js — a small
 * event-driven client: `client.on('messageCreate', ...)` instead of
 * parsing WebSocket frames by hand. See raw-ping-bot.js for the same bot
 * against the bare protocol, if you'd rather not depend on the SDK file.
 *
 * In any space it's been added to, it answers a couple of chat commands:
 *
 *   !ping          -> "pong 🏓"
 *   !say <text>    -> repeats <text>
 *   !hello         -> greets you by name
 *
 * Run it:
 *   1. In the Developer Portal (https://voxaraspace.com/developers/): create a bot, copy its token.
 *   2. In the portal: open the bot and add it to a space.
 *   3. npm install ws        (the only dependency)
 *   4. PULSE_BOT_TOKEN=your_token node examples/ping-bot.js
 *
 */

const { Client } = require('../sdk/voxara-bot');

const TOKEN = process.env.PULSE_BOT_TOKEN;
if (!TOKEN) {
  console.error('Set PULSE_BOT_TOKEN to your bot token (from the Developer Portal).');
  process.exit(1);
}

const client = new Client();

client.on('ready', () => {
  const spaces = [...client.guilds.values()].map((g) => g.name).join(', ') || '(none yet — add me to one)';
  console.log(`Connected as ${client.user.displayName} (@${client.user.username}).`);
  console.log(`In ${client.guilds.size} space(s): ${spaces}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // never answer a bot, including yourself

  const text = message.content.trim();
  if (text === '!ping') {
    await message.reply('pong 🏓');
  } else if (text.startsWith('!say ')) {
    await message.channel.send(text.slice(5));
  } else if (text === '!hello') {
    await message.reply(`Hi there! I'm a Voxara bot. Try \`!ping\` or \`!say something\`.`);
  }
});

client.on('disconnect', () => console.log('disconnected — reconnecting…'));
client.on('error', (err) => console.error('socket error:', err.message));

client.login(TOKEN).catch((err) => {
  console.error('sign-in failed:', err.message);
  process.exit(1);
});
