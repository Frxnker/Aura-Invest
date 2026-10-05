/* =========================================================================
 * Aura Invest · Service worker mínimo
 * Solo sirve para mostrar las notificaciones de las alertas: Chrome para Android no admite
 * `new Notification()` desde la página y exige registration.showNotification().
 * No intercepta peticiones ni guarda nada en caché: la app se carga siempre de la red.
 * ========================================================================= */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/** Al pulsar una notificación se vuelve a la app (o se abre si estaba cerrada). */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
