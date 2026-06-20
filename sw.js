// Service Worker for Nexa Messenger
// Handles background notifications, caching, and offline functionality

const CACHE_NAME = 'nexa-messenger-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

// Install event - cache assets
self.addEventListener('install', event => {
  console.log('🔧 Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('📦 Caching assets');
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.log('Note: Some assets could not be cached (this is normal):', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('🚀 Service Worker activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('🗑️ Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request).then(response => {
        // Don't cache non-successful responses
        if (!response || response.status !== 200) {
          return response;
        }

        // Clone the response
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });

        return response;
      });
    }).catch(() => {
      // Offline fallback
      console.log('📴 Offline - serving from cache');
      return caches.match(event.request);
    })
  );
});

// Handle push notifications (when app is closed)
self.addEventListener('push', event => {
  console.log('📨 Push notification received:', event);

  let title = 'Nexa Messenger';
  let options = {
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'nexa-notification',
    requireInteraction: true,
    vibrate: [200, 100, 200],
    sound: '/notification-sound.mp3'
  };

  if (event.data) {
    try {
      const data = event.data.json();
      title = data.title || title;
      options.body = data.body || 'New message from Nexa Messenger';
      options.icon = data.icon || options.icon;
      options.badge = data.badge || options.badge;
      options.tag = data.tag || options.tag;
      
      // Add notification data for click handling
      if (data.fromUid) {
        options.data = { fromUid: data.fromUid };
      }
    } catch (e) {
      options.body = event.data.text ? event.data.text() : 'New message';
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Handle notification click (open app and show conversation)
self.addEventListener('notificationclick', event => {
  console.log('🔔 Notification clicked:', event);

  event.notification.close();

  const urlToOpen = new URL('/', self.location).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Check if there's already a window open with the target URL
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // If not, open a new window
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// Handle notification dismissal
self.addEventListener('notificationclose', event => {
  console.log('📭 Notification dismissed');
});

// Background sync for offline message queuing (optional)
self.addEventListener('sync', event => {
  console.log('🔄 Background sync triggered:', event.tag);

  if (event.tag === 'sync-messages') {
    event.waitUntil(
      // Queue messages to be sent when online
      Promise.resolve()
    );
  }
});