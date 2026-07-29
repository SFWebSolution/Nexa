// =====================================================
// NEXA MESSENGER - FIREBASE MESSAGING SERVICE WORKER
// =====================================================
// This service worker handles push notifications from FCM.
// It receives DATA-ONLY messages (no `notification` key)
// so that it ALWAYS fires, even when the app is completely
// closed or the user hasn't opened it.
// =====================================================

importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js");

// Initialize Firebase App in Service Worker
firebase.initializeApp({
  apiKey: "AIzaSyBczCrV1vpJB_0DTsbBDupTXQuEV7l5IDg",
  authDomain: "mel-odix.firebaseapp.com",
  projectId: "mel-odix",
  storageBucket: "mel-odix.firebasestorage.app",
  messagingSenderId: "217595352090",
  appId: "1:217595352090:web:56696fd53ae5bb59d2eda3"
});

const messaging = firebase.messaging();

// ─── Handle Background Data Messages from FCM ───
// Since the backend sends data-only payloads (no `notification` key),
// this handler ALWAYS fires — foreground, background, or closed app.
messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Received background data message:", payload);

  // Extract notification content from the data payload
  const data = payload.data || {};
  const title = data.title || "Nexa Messenger";
  const options = {
    body: data.body || "You have a new message",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    tag: data.tag || "nexa-chat-notification",
    data: data,
    requireInteraction: true,
    // Vibrate pattern: short-long-short
    vibrate: [100, 200, 100],
    // Actions for quick reply (if supported)
    actions: [
      { action: "open", title: "Open Chat" },
      { action: "dismiss", title: "Dismiss" }
    ]
  };

  return self.registration.showNotification(title, options);
});

// ─── Also handle raw `push` events as a fallback ───
// If the FCM SDK doesn't intercept the push for some reason,
// the raw `push` event will fire. This ensures 100% coverage.
self.addEventListener("push", (event) => {
  // Check if FCM SDK already handled this
  // FCM SDK sets a flag on the event when it handles it
  if (event.__handled) return;

  console.log("[firebase-messaging-sw.js] Raw push event received:", event);

  let data = {};
  if (event.data) {
    try {
      const json = event.data.json();
      // FCM wraps data messages in a `data` key
      data = json.data || json;
    } catch (e) {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || "Nexa Messenger";
  const options = {
    body: data.body || "You have a new message",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    tag: data.tag || "nexa-notification-" + Date.now(),
    data: data,
    requireInteraction: true,
    vibrate: [100, 200, 100]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ─── Handle Notification Click ───
self.addEventListener("notificationclick", (event) => {
  console.log("[firebase-messaging-sw.js] Notification click received:", event);
  event.notification.close();

  const action = event.action;
  if (action === "dismiss") return;

  // Determine the URL to open
  const clickAction = event.notification.data?.click_action || "/dashboard.html";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus existing tab if open
      for (const client of clientList) {
        if (
          (client.url.includes("dashboard.html") || client.url.endsWith("/")) &&
          "focus" in client
        ) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      if (clients.openWindow) {
        return clients.openWindow(clickAction);
      }
    })
  );
});

// ─── Handle Notification Dismiss ───
self.addEventListener("notificationclose", (event) => {
  console.log("[firebase-messaging-sw.js] Notification dismissed");
});

console.log("✅ Firebase Messaging Service Worker loaded and ready");
