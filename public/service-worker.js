const CACHE_NAME = 'memoire-v1';

const urlsToCache = [
  '/',
  '/index.html'
];

// ============ INSTALLATION ============
// Mise en cache des ressources
self.addEventListener('install', (event) => {
  console.log('Service Worker installé');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// ============ ACTIVATION ============
// Nettoyage des anciens caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker activé');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// ============ FETCH (CACHE) ============
// Stratégie : Network First (toujours essayer le réseau, cache en fallback)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
});

// ============ NOTIFICATIONS PUSH ============
// Réception des notifications push
self.addEventListener('push', (event) => {
  console.log('🔔 Notification push reçue!');
  
  let notificationData = {
    title: 'Rappel',
    body: 'Tu as quelque chose à faire!',
    icon: '/icon-192.png',
    badge: '/icon-192.png'
  };
  
  // Si des données sont envoyées avec la notification
  if (event.data) {
    try {
      const data = event.data.json();
      notificationData = {
        title: data.title || 'Rappel',
        body: data.body || 'Tu as quelque chose à faire!',
        icon: data.icon || '/icon-192.png',
        badge: data.badge || '/icon-192.png',
        data: data.data || {}
      };
    } catch (e) {
      console.error('Erreur parsing notification data:', e);
    }
  }
  
  event.waitUntil(
    self.registration.showNotification(notificationData.title, {
      body: notificationData.body,
      icon: notificationData.icon,
      badge: notificationData.badge,
      data: notificationData.data,
      requireInteraction: false,
      tag: 'memoire-reminder'
    })
  );
});

// Clic sur la notification
self.addEventListener('notificationclick', (event) => {
  console.log('🔔 Notification cliquée');
  event.notification.close();
  
  // Ouvrir l'app
  event.waitUntil(
    clients.openWindow('/')
  );
});