
// Firebase SDK (modular style)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  setDoc,
  doc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// YOUR FIREBASE CONFIG (replace this)
const firebaseConfig = {
  apiKey: "AIzaSyBczCrV1vpJB_0DTsbBDupTXQuEV7l5IDg",
  authDomain: "mel-odix.firebaseapp.com",
  projectId: "mel-odix",
  storageBucket: "mel-odix.firebasestorage.app",
  messagingSenderId: "217595352090",
  appId: "1:217595352090:web:56696fd53ae5bb59d2eda3"
};


// INIT
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// EXPORT
export { auth, db, createUserWithEmailAndPassword, setDoc, doc };

// ---- Firebase Cloud Messaging (FCM) setup ----
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const messaging = getMessaging(app);

// VAPID public key provided by the user
const vapidKey = "BGD7zwejdkH_EnGAfFgi872tkBWDM8-k0It7Px7QzitJ_abkqyK8d1ZEfQFslGS4TY6JXY1mylpSIH5QNDfhCRI";

/**
 * Initialize FCM for a logged‑in user.
 * Requests notification permission, registers the service worker,
 * obtains the token and saves it to the backend.
 */
export async function initFCM(uid) {
  try {
    // Register the service worker (must be served from same origin)
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    // Request permission from the user
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.warn("🔔 Notification permission not granted");
      return null;
    }
    // Get the FCM token using the VAPID key
    const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
    if (token) {
      // Persist token in Firestore via backend API
      await fetch("/api/save-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, token })
      });
      console.log("🔔 FCM token saved:", token);
    }
    return token;
  } catch (e) {
    console.error("FCM init error:", e);
  }
}

// Listen for messages while the app is in the foreground
onMessage(messaging, (payload) => {
  console.log("[firebase-messaging] Foreground message:", payload);
  // Optional: show custom UI or toast here
});