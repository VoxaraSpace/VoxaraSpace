/**
 * Web Push for the browser build, the Android app and iPhone home-screen
 * installs: registers the service worker, subscribes with the server's VAPID
 * key, and keeps the subscription current. The desktop app has its own
 * system notifications and never uses this.
 */
import { net, isWeb, getSetting, setSetting } from './client.js';
import { store } from './state.js';

const SETTING = 'pushEnabled';

export function pushSupported() {
  return isWeb && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
}

export function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return getSetting(SETTING) ? 'on' : 'off';
}

function keyBytes(b64u) {
  const s = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s + pad), (c) => c.charCodeAt(0));
}

async function registration() {
  return navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' });
}

/** Ask permission, subscribe, and tell the server. Returns the new state. */
export async function enablePush() {
  if (!pushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const { publicKey } = await net.request('push:key');
  if (!publicKey) throw new Error('Push is not set up on this server.');
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await net.request('push:subscribe', { subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 60) });
  setSetting(SETTING, true);
  return 'on';
}

export async function disablePush() {
  setSetting(SETTING, false);
  if (!pushSupported()) return 'off';
  try {
    const reg = await navigator.serviceWorker.getRegistration('/app/');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await net.request('push:unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  } catch { /* nothing to undo */ }
  return 'off';
}

/** On sign-in: refresh an existing subscription so a rotated endpoint reaches the server. */
export async function syncPush() {
  if (!pushSupported() || !getSetting(SETTING) || Notification.permission !== 'granted') return;
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) await net.request('push:subscribe', { subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 60) });
    else await enablePush();
  } catch { /* best effort */ }
}

/** Messages from the service worker: a tapped notification, or a rotated subscription. */
export function listenToWorker(openChannel) {
  if (!pushSupported()) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'open-channel' && msg.channelId) openChannel(msg.channelId);
    if (msg.type === 'push-resubscribe') void syncPush();
  });
}
