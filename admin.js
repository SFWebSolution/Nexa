const firebaseConfig = {
  apiKey: "AIzaSyBczCrV1vpJB_0DTsbBDupTXQuEV7l5IDg",
  authDomain: "mel-odix.firebaseapp.com",
  projectId: "mel-odix",
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

const ADMIN_EMAIL = "neuro_stack@outlook.com";

let users = [];
let chart;

/* 🔐 LOGIN */
async function checkEmail() {
  const email = document.getElementById("emailInput").value.trim();

  if (email !== ADMIN_EMAIL) {
    alert("Access denied ❌");
    return;
  }

  try {
    // required so Firestore rules allow access
    await auth.signInAnonymously();

    document.getElementById("loginBox").style.display = "none";
    document.getElementById("dashboard").classList.remove("hidden");

    initDashboard();

  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

/* 🚀 INIT */
function initDashboard() {
  listenUsers();

  document.getElementById("search").addEventListener("input", e => {
    const value = e.target.value.toLowerCase();

    const filtered = users.filter(u =>
      (u.name || "").toLowerCase().includes(value) ||
      (u.email || "").toLowerCase().includes(value)
    );

    renderTable(filtered);
  });
}

/* 📡 REALTIME USERS */
function listenUsers() {
  db.collection("users").onSnapshot(
    snapshot => {

      users = snapshot.docs.map(doc => {
        const data = doc.data();

        return {
          uid: doc.id,
          ...data,

          // 🔥 SAFE TIMESTAMP FIX (no crash ever)
          createdAt: normalizeTime(data.createdAt)
        };
      });

      render();

    },
    err => {
      console.error(err);
      alert("Firestore error: " + err.message);
    }
  );
}

/* 🔥 SAFE DATE CONVERTER */
function normalizeTime(value) {
  if (!value) return Date.now();

  // Firestore Timestamp
  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  // number timestamp
  if (typeof value === "number") {
    return value;
  }

  // string date
  const parsed = new Date(value).getTime();
  return isNaN(parsed) ? Date.now() : parsed;
}

/* 📊 RENDER */
function render() {
  document.getElementById("totalUsers").innerText = users.length;

  const today = Date.now() - 86400000;

  const activeToday = users.filter(u => u.createdAt >= today).length;

  const banned = users.filter(u => u.banned).length;

  document.getElementById("activeToday").innerText = activeToday;
  document.getElementById("bannedUsers").innerText = banned;

  renderTable(users);
  renderChart();
}

/* 👤 TABLE */
function renderTable(data) {
  const table = document.getElementById("usersTable");
  table.innerHTML = "";

  data.forEach(u => {
    table.innerHTML += `
      <tr>
        <td>${u.name || "-"}</td>
        <td>${u.email || "-"}</td>
        <td>${u.uid}</td>
        <td>${u.banned ? "🚫 Banned" : "🟢 Active"}</td>
        <td>
          <button onclick="deleteUser('${u.uid}')">Delete</button>
          <button onclick="banUser('${u.uid}', ${u.banned})">
            ${u.banned ? "Unban" : "Ban"}
          </button>
        </td>
      </tr>
    `;
  });
}

/* ❌ DELETE */
async function deleteUser(uid) {
  if (!confirm("Delete this user?")) return;

  try {
    await db.collection("users").doc(uid).delete();
    log("Deleted user " + uid);
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

/* 🚫 BAN */
async function banUser(uid, state) {
  try {
    await db.collection("users").doc(uid).update({
      banned: !state
    });

    log((state ? "Unbanned " : "Banned ") + uid);

  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

/* 📈 CHART */
function renderChart() {
  const canvas = document.getElementById("chart");

  const days = [0, 0, 0, 0, 0, 0, 0];

  users.forEach(u => {
    const d = new Date(u.createdAt).getDay();
    days[d]++;
  });

  if (chart) chart.destroy();

  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      datasets: [{
        label: "User Growth",
        data: days,
        borderColor: "lime",
        tension: 0.3
      }]
    },
    options: {
      responsive: true
    }
  });
}

/* 📜 LOG */
function log(text) {
  const box = document.getElementById("logBox");
  const time = new Date().toLocaleTimeString();

  box.innerHTML = `[${time}] ${text}<br>` + box.innerHTML;
}