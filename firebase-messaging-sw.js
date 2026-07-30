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

// ─── Native Web Push Event Listener (App Closed / Background / Foreground) ───
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

  const options = {
    body: body,
    icon: icon,
    badge: badge,
    tag: data.tag || ("nexa-msg-" + (data.senderUid || Date.now())),
    data: data,
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    actions: [
      { action: "open", title: "Open Chat" },
      { action: "dismiss", title: "Dismiss" }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ─── Handle Firebase Background Push Notifications ───
messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Background message received:", payload);

  const data = payload.data || {};
  const title = data.title || "Nexa Messenger";
  const body = data.body || "You have received a new message";

  const options = {
    body: body,
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    tag: data.tag || ("nexa-msg-" + (data.senderUid || Date.now())),
    data: data,
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    actions: [
      { action: "open", title: "Open Chat" },
      { action: "dismiss", title: "Dismiss" }
    ]
  };

  return self.registration.showNotification(title, options);
});

// ─── Handle Notification Clicks ───
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;

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
const CACHE_NAME = 'nexa-v3';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/login.html',
  '/signup.html',
  '/dashboard.html',
  '/styles.css',
  '/dashboard.css',
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

console.log("✅ Nexa Firebase Messaging Service Worker ready");
