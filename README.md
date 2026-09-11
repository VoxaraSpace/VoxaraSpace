# Voxara

Voice and text chat for friends and communities. This repository holds the
code that runs on your computer: the desktop app, the bot SDK and example
bots. It is published so that anyone can check what the app does with their
data, build it themselves, and report problems.

- Website and downloads: https://voxaraspace.com
- Bot documentation: https://voxaraspace.com/developers/docs/
- Security reports: security@voxaraspace.com (see SECURITY.md)

## What is here

| Directory | What it is |
| --- | --- |
| `client/` | The desktop app (Electron). `main.js` is the desktop process, `preload.js` the only bridge into the page, `src/` the app itself, `updater.js` the self-updater. |
| `sdk/` | `voxara-bot.js`, a small dependency-light client for writing bots. |
| `examples/` | Example bots using the SDK and the raw protocol. |

## What is not here, and why

The server is not published. It holds the moderation, anti-abuse and
rate-limiting logic, and keeping that private is what stops the people it is
there to stop from studying it. Everything the server sends to and asks of
the app goes through the documented WebSocket protocol, which the client
code in this repository implements in full, so what leaves your computer is
entirely visible here.

Voxara is a hosted service: the app talks to `wss://voxaraspace.com` and
nothing else. There is no configuration for pointing it at another server.

## Building the app

```
cd client
npm install
npm start            # runs the app from source
npm run build:win    # Windows build, output in ../dist
```

Node 18 or newer. The Windows builds published on the website are produced
from this same tree; `client/package.json` carries a `buildSerial` that the
updater uses to order releases.

## Security

Every connection is TLS. Passwords are hashed with scrypt on the server;
sessions are random 256-bit tokens the app stores through the operating
system's own secret store (see `readSettings` in `client/main.js`). Uploaded
files and the message database are encrypted at rest on the server. Messages
are not end to end encrypted: the server decrypts them to deliver them, and
the privacy policy at https://voxaraspace.com/legal/ says so plainly.

Found something? Please read SECURITY.md and write to security@voxaraspace.com
rather than opening a public issue.

## Licence

Apache License 2.0, see LICENSE. "Voxara" and the Voxara logo are trademarks
and are not covered by the licence, see NOTICE.
