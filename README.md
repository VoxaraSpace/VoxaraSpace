<p align="center">
  <img src="https://voxaraspace.com/site/coming-soon/logo.png" width="96" alt="Voxara" />
</p>

<h1 align="center">Voxara</h1>

<p align="center">Free voice and text chat for friends and communities. No ads, no data sales, no ID checks.</p>

<p align="center">
  <a href="https://voxaraspace.com/download">Download</a> ·
  <a href="https://voxaraspace.com/features">Features</a> ·
  <a href="https://voxaraspace.com/developers/docs/">Bot docs</a> ·
  <a href="https://voxaraspace.com/discover/">Discover spaces</a> ·
  <a href="SECURITY.md">Security reviews</a>
</p>

<p align="center">
  <img src="https://voxaraspace.com/site/coming-soon/app.jpg" width="820" alt="Voxara, open on a space's #general channel" />
</p>

**Spaces** with text, voice and forum channels, roles and permissions, automod word packs and moderation tools. **Voice and video** calls with screen sharing that carries game audio and an in-game overlay. **Bots and webhooks** through a small SDK. **Templates** so a new space starts ready. **Space Discovery** for public communities.

Runs on **Windows**, **Linux** (AppImage and .deb), **Android**, and in any **browser** (iPhone via Add to Home Screen). Every app updates itself.

This repository holds the code that runs on your computer, published so that anyone can check what the app does with their data. The server is not included.

- Source: https://github.com/VoxaraSpace/VoxaraSpace
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
