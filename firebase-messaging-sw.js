// =====================================================
// NEXA MESSENGER - FIREBASE MESSAGING SERVICE WORKER
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

// Handle Background Push Messages
messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Received background message:", payload);

  const title = payload.notification?.title || payload.data?.title || "Nexa Messenger";
  const options = {
    body: payload.notification?.body || payload.data?.body || "You have a new message",
    icon: payload.notification?.icon || payload.data?.icon || "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.data?.tag || "nexa-chat-notification",
    data: payload.data || {},
    requireInteraction: false
  };

  return self.registration.showNotification(title, options);
});

// Handle Notification Click
self.addEventListener("notificationclick", (event) => {
  console.log("[firebase-messaging-sw.js] Notification click received:", event);
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus existing tab if open
      for (const client of clientList) {
        if (client.url.includes("dashboard.html") || client.url.endsWith("/")) {
          if ("focus" in client) {
            return client.focus();
          }
        }
      }
      // Otherwise open new tab
      if (clients.openWindow) {
        return clients.openWindow("/dashboard.html");
      }
    })
  );
});
