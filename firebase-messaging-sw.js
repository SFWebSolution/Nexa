// =====================================================
// NEXA MESSENGER - FIREBASE MESSAGING & UNIFIED SERVICE WORKER
// =====================================================
// Handles FCM Push Notifications (Foreground, Background, App Closed)
// and PWA asset caching.

importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBczCrV1vpJB_0DTsbBDupTXQuEV7l5IDg",
  authDomain: "mel-odix.firebaseapp.com",
  projectId: "mel-odix",
  storageBucket: "mel-odix.firebasestorage.app",
  messagingSenderId: "217595352090",
  appId: "1:217595352090:web:56696fd53ae5bb59d2eda3"
});

const messaging = firebase.messaging();

// ─── Single notification path (background) ───
// For data-only FCM messages there are two ways the SW can learn about a
// push: the native "push" event and Firebase's onBackgroundMessage wrapper.
// Handling BOTH made each message produce 2+ notifications. We keep ONLY the
// native push handler (the reliable path for data-only messages) and DROP
// onBackgroundMessage entirely so one message = one notification.
self.addEventListener("push", (event) => {
  console.log("[firebase-messaging-sw.js] Native push event received:", event);

  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      payload = { data: { body: event.data.text() } };
    }
  }

  const notification = payload.notification || {};
  const data = payload.data || payload.fcmOptions || {};

  const title = notification.title || data.title || "Nexa Messenger";
  const body = notification.body || data.body || "You have received a new message";
  const icon = notification.icon || data.icon || "/icon-192.png";
  const badge = notification.badge || data.badge || "/icon-192.png";
  const isCall = title.includes("Call") || data.isCall === "true";

  // Stable tag per message so duplicate pushes (e.g. the same message sent to
  // multiple of the user's FCM tokens) COLLAPSE into a single notification
  // instead of stacking. Calls use a fixed tag so an incoming call replaces
  // any prior call notification.
  const msgId = data.messageId || data.msgId || (data.senderUid ? (data.senderUid + "_" + (data.timestamp || Date.now())) : null);
  const tag = isCall ? "nexa-incoming-call" : (data.tag || (msgId ? ("nexa-msg-" + msgId) : ("nexa-msg-" + (data.senderUid || Date.now()))));

  const options = {
    body: body,
    icon: icon,
    badge: badge,
    sound: isCall ? "/iphone.mp3" : null,
    tag: tag,
    data: data,
    renotify: false,
    requireInteraction: isCall ? true : false,
    vibrate: isCall ? [500, 250, 500, 250, 500, 250, 500, 250, 500] : [200, 100, 200],
    actions: isCall ? [
      { action: "answer", title: "📞 Answer Call" },
      { action: "decline", title: "❌ Decline" }
    ] : [
      { action: "open", title: "Open Chat" },
      { action: "dismiss", title: "Dismiss" }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );

  // Auto-dismiss after 10 seconds so the user doesn't have to clear it
  // manually (WhatsApp-style). Calls keep requireInteraction and are NOT
  // auto-dismissed (they need a deliberate answer/decline).
  if (!isCall) {
    setTimeout(() => {
      self.registration.getNotifications({ tag: tag }).then(notifs => {
        notifs.forEach(n => n.close());
      }).catch(() => {});
    }, 10000);
  }
});

// NOTE: onBackgroundMessage is intentionally NOT registered. It wraps the same
// push event as the handler above and would create duplicate notifications.

// ─── Handle Notification Clicks ───
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss" || event.action === "decline") return;

  const clickAction = event.notification.data?.click_action || "/dashboard.html";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (
          (client.url.includes("dashboard.html") || client.url.endsWith("/")) &&
          "focus" in client
        ) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(clickAction);
      }
    })
  );
});

// ─── Service Worker Cache & Lifecycle ───
const CACHE_NAME = 'nexa-v5-perf';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/login.html',
  '/signup.html',
  '/dashboard.html',
  '/styles.css',
  '/dashboard.css',
  '/nexa-voice-room.css',
  '/nexa-voice-room.js',
  '/firebase.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Stale-While-Revalidate fetch strategy for ultra-fast asset loading
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Serve static UI assets with Stale-While-Revalidate
  if (
    url.origin === self.location.origin ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('jsdelivr.net')
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(req).then((cachedResponse) => {
          const fetchPromise = fetch(req).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(req, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => cachedResponse);

          return cachedResponse || fetchPromise;
        });
      })
    );
  }
});

console.log("✅ Nexa High-Performance Service Worker ready");
