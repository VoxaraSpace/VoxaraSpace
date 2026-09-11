import { Emitter } from './utils.js';

const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_STEPS = [500, 1000, 2000, 4000, 8000, 15_000];

/**
 * WebSocket transport with request/response semantics, automatic reconnection
 * and silent re-authentication using the stored session token.
 *
 * Events: `status` (connecting|open|reconnecting|closed|failed), `event`
 * (server push), `resumed`, `resume-failed`.
 */
export class Net extends Emitter {
  constructor() {
    super();
    this.url = null;
    this.socket = null;
    this.status = 'idle';
    this.pending = new Map();
    this.nextId = 1;
    this.attempt = 0;
    this.token = null;
    this.shouldReconnect = false;
    this.reconnectTimer = null;
  }

  setStatus(status, detail) {
    this.status = status;
    this.emit('status', { status, detail });
  }

  /** Opens a socket. Resolves once the socket is open (not authenticated). */
  connect(url) {
    this.url = url;
    this.shouldReconnect = true;
    clearTimeout(this.reconnectTimer);

    return new Promise((resolve, reject) => {
      let settled = false;
      this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');

      let socket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        this.setStatus('failed', err.message);
        return reject(new Error(`That address is not valid: ${err.message}`));
      }
      this.socket = socket;

      socket.onopen = () => {
        this.attempt = 0;
        this.setStatus('open');
        settled = true;
        resolve();
      };

      socket.onmessage = (event) => this.handleMessage(event.data);

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Could not reach that server. Check the address and that the server is running.'));
        }
      };

      socket.onclose = () => {
        this.failAllPending('Connection lost.');
        if (this.socket === socket) this.socket = null;
        if (!settled) {
          settled = true;
          reject(new Error('Could not reach that server. Check the address and that the server is running.'));
          return;
        }
        if (this.shouldReconnect) this.scheduleReconnect();
        else this.setStatus('closed');
      };
    });
  }

  scheduleReconnect() {
    const delay = BACKOFF_STEPS[Math.min(this.attempt, BACKOFF_STEPS.length - 1)];
    this.attempt += 1;
    this.setStatus('reconnecting', { attempt: this.attempt, delay });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (!this.shouldReconnect) return;

      try {
        await this.connect(this.url);
      } catch {
        // The socket never opened, so no `close` event will retry for us.
        if (this.shouldReconnect && !this.isOpen) this.scheduleReconnect();
        return;
      }

      if (!this.token) return;
      try {
        const ready = await this.request('auth:resume', { token: this.token });
        this.emit('resumed', ready);
      } catch (err) {
        if (err.code === 'bad_session') {
          // Retrying will never help; hand the user back to the sign-in screen.
          this.shouldReconnect = false;
          this.token = null;
          this.emit('resume-failed', err);
        }
        // Anything else: the socket will drop and the retry loop continues.
      }
    }, delay);
  }

  handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (frame.id !== undefined && this.pending.has(frame.id)) {
      const entry = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.ok) entry.resolve(frame.data);
      else entry.reject(Object.assign(new Error(frame.error?.message || 'Request failed.'), {
        code: frame.error?.code || 'unknown',
      }));
      return;
    }

    if (frame.op) this.emit('event', frame);
  }

  request(op, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(Object.assign(new Error('Not connected to the server.'), { code: 'offline' }));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('The server did not answer in time.'), { code: 'timeout' }));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, op, data }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Fire-and-forget: used for typing pings, where a failure is irrelevant. */
  notify(op, data = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({ op, data }));
    } catch {
      /* ignore */
    }
  }

  failAllPending(message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(message), { code: 'disconnected' }));
    }
    this.pending.clear();
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  disconnect() {
    this.shouldReconnect = false;
    clearTimeout(this.reconnectTimer);
    this.failAllPending('Disconnected.');
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.setStatus('closed');
  }
}

/**
 * Accepts "chat.example.com", "host:port", or an explicit ws/wss/http/https
 * URL. Connections default to **wss://** — encrypted unless somebody
 * deliberately asks for plaintext by typing `ws://`.
 */
export function normalizeServerUrl(input) {
  let value = String(input || '').trim();
  if (!value) return '';
  value = value.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  if (!/^wss?:\/\//i.test(value)) value = `wss://${value}`;
  // No port is appended: the production address is wss://voxaraspace.com on
  // 443 (an appended :8787 would bypass the proxy and never connect); a
  // development server always names its port explicitly.
  return value.replace(/\/+$/, '');
}
