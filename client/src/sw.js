/* Voxara service worker: shows push notifications for DMs, mentions and
   replies while the app is closed, and opens the app on tap. It does not
   cache anything, so the client is always the live version. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Voxara', body: 'You have a new message.' }; }
  const title = data.title || 'Voxara';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/app/icons/icon-192.png',
    badge: '/app/icons/icon-192.png',
    tag: data.tag || 'voxara',
    renotify: true,
    data: { url: data.url || '/app/', channelId: data.channelId || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/app/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const client of list) {
      if (client.url.startsWith(self.location.origin + '/app') && 'focus' in client) {
        client.postMessage({ type: 'open-channel', channelId: event.notification.data?.channelId || null });
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});

/* A subscription can be rotated by the browser; re-send it to the server via any open page. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    for (const client of list) client.postMessage({ type: 'push-resubscribe' });
  }));
});
