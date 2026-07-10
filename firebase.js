
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