'use strict';

/**
 * A minimal Voxara bot — the raw protocol, no library.
 *
 * See ping-bot.js for the same bot written against sdk/voxara-bot.js, which
 * is the easier way to start (events instead of frame parsing). This version
 * exists for when you want to see exactly what goes over the wire, or don't
 * want even the small SDK file as a dependency.
 *
 * It signs in with a bot token, then in any space it's been added to it answers
 * a couple of chat commands:
 *
 *   !ping          -> "pong 🏓"
 *   !say <text>    -> repeats <text>
 *   !hello         -> greets you by name
 *
 * Run it:
 *   1. In Voxara: Settings -> Bots -> create a bot, copy its token.
 *   2. In Voxara: add the bot to a space (the dropdown on the bot).
 *   3. npm install ws        (the only dependency)
 *   4. PULSE_BOT_TOKEN=your_token node examples/raw-ping-bot.js
 *
 */

const WebSocket = require('ws');

const SERVER = process.env.PULSE_SERVER || 'wss://voxaraspace.com';
const TOKEN = process.env.PULSE_BOT_TOKEN;

if (!TOKEN) {
  console.error('Set PULSE_BOT_TOKEN to your bot token (Settings -> Bots).');
  process.exit(1);
}

// Accept the server's certificate as is, so a rotation never strands the bot.
const ws = new WebSocket(SERVER, { origin: 'app://pulse', rejectUnauthorized: false });

let selfId = null;
let nextId = 1;
const pending = new Map();

/** Send a request and await its reply. */
function request(op, data = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, op, data }));
  });
}

function send(channelId, content) {
  return request('message:send', { channelId, content }).catch((err) => {
    console.error('could not send:', err.message);
  });
}

ws.on('open', async () => {
  try {
    const ready = await request('auth:bot', { token: TOKEN });
    selfId = ready.user.id;
    console.log(`Connected as ${ready.user.displayName} (@${ready.user.username}).`);
    console.log(`In ${ready.guilds.length} space(s): ${ready.guilds.map((g) => g.name).join(', ') || '(none yet — add me to one)'}`);
  } catch (err) {
    console.error('sign-in failed:', err.message);
    process.exit(1);
  }
});

ws.on('message', async (raw) => {
  let frame;
  try { frame = JSON.parse(raw); } catch { return; }

  // Replies to our own requests.
  if (frame.id && pending.has(frame.id)) {
    const { resolve, reject } = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.ok) resolve(frame.data);
    else reject(new Error(frame.error?.message || frame.error?.code || 'error'));
    return;
  }

  // Live events. We only care about new messages here.
  if (frame.op === 'message:new') {
    const m = frame.data.message;
    if (!m || m.authorId === selfId) return; // never answer ourselves

    const text = (m.content || '').trim();
    if (text === '!ping') {
      await send(m.channelId, 'pong 🏓');
    } else if (text.startsWith('!say ')) {
      await send(m.channelId, text.slice(5));
    } else if (text === '!hello') {
      await send(m.channelId, 'Hi there! I’m a Voxara bot. Try `!ping` or `!say something`.');
    }
  }
});

ws.on('close', () => { console.log('disconnected'); process.exit(0); });
ws.on('error', (err) => { console.error('socket error:', err.message); });
