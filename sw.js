// =====================================================
// NEXA MESSENGER - PWA SERVICE WORKER
// =====================================================
// Imports firebase-messaging-sw.js so FCM push notifications
// and offline caching use a single, unified worker.

try {
  importScripts("/firebase-messaging-sw.js");
} catch (e) {
  console.warn("Could not import firebase-messaging-sw.js:", e.message);
}