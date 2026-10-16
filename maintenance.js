/* =========================================================================
   Nexa — shared "taking a short break" maintenance screen
   -------------------------------------------------------------------------
   When Firestore hits its plan limits (daily read/write quota) the SDK throws
   `firestore/resource-exhausted` (or `unavailable`). Left unhandled the app
   just hangs on "Loading users…" / a blank dashboard and looks broken. This
   module detects that class of error and shows ONE friendly, on-brand overlay
   that auto-retries, so the app recovers by itself when the quota resets.

   Loaded by BOTH login.html and dashboard.html as a plain script that exposes
   `window.NexaMaintenance`. Keep it dependency-free and side-effect-light.
   ========================================================================= */
(function () {
  "use strict";

  var RELOAD_SECONDS = 60;      // wait between automatic recovery attempts
  var shown = false;            // overlay currently visible?
  var countdownTimer = null;
  var secondsLeft = RELOAD_SECONDS;

  // ── Detect a quota/limit error ───────────────────────────────────────────
  // Firestore strings to watch for. `resource-exhausted` is the canonical one
  // for an exceeded plan quota; `unavailable` covers the transient backend
  // unavailability that usually accompanies it. We also inspect the message
  // because errors arriving through different SDK paths can lose `code`.
  function nexaIsQuotaError(err) {
    if (!err) return false;
    var code = "";
    var message = "";
    try {
      if (typeof err === "string") {
        message = err;
      } else {
        code = String(err.code || (err.error && err.error.code) || "").toLowerCase();
        message = String(err.message || (err.error && err.error.message) || "").toLowerCase();
      }
    } catch (e) {
      return false;
    }
    if (code.indexOf("resource-exhausted") !== -1) return true;
    if (code.indexOf("unavailable") !== -1) return true;
    if (message.indexOf("resource_exhausted") !== -1) return true;
    if (message.indexOf("resource-exhausted") !== -1) return true;
    if (message.indexOf("quota") !== -1) return true;
    if (message.indexOf("exceeded") !== -1) return true;
    return false;
  }

  // ── Build + show the overlay (idempotent) ───────────────────────────────
  function nexaShowMaintenance() {
    if (shown) return;
    shown = true;

    // Stop the boot splash from sitting on top forever.
    try {
      var splash = document.getElementById("nexaSplash");
      if (splash) { splash.classList.add("nexa-done"); splash.style.display = "none"; }
    } catch (e) {}

    if (!document.getElementById("nexaMaintOverlay")) {
      var el = document.createElement("div");
      el.id = "nexaMaintOverlay";
      el.className = "nexa-maint";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.innerHTML =
        '<div class="nexa-maint-card">' +
          '<div class="nexa-maint-logo">N</div>' +
          '<div class="nexa-maint-name">Nexa</div>' +
          '<div class="nexa-maint-title">Nexa is taking a short breather</div>' +
          '<div class="nexa-maint-text">We&rsquo;re giving things a quick refresh so everything stays smooth. ' +
            'We&rsquo;ll be right back &mdash; hang tight.</div>' +
          '<button type="button" class="nexa-maint-btn" id="nexaMaintRetry">Try again now</button>' +
          '<div class="nexa-maint-note" id="nexaMaintNote"></div>' +
          '<div class="nexa-maint-foot">' +
            '<span id="nexaMaintUid"></span>' +
            '<a href="#" id="nexaMaintSignout">Sign out</a>' +
          '</div>' +
        '</div>';
      document.body.appendChild(el);

      var retry = document.getElementById("nexaMaintRetry");
      if (retry) retry.addEventListener("click", function () { window.location.reload(); });
      var out = document.getElementById("nexaMaintSignout");
      if (out) out.addEventListener("click", function (ev) {
        ev.preventDefault();
        try {
          if (window.NexaMaintenance && typeof window.NexaMaintenance.signOut === "function") {
            window.NexaMaintenance.signOut();
          } else {
            window.location.href = "login.html";
          }
        } catch (e) { window.location.href = "login.html"; }
      });
    }

    // Show the current account (helps support / the user know which account).
    try {
      var uidEl = document.getElementById("nexaMaintUid");
      var uid = "";
      try { uid = (window.currentUser && window.currentUser.uid) || ""; } catch (e) {}
      if (!uid) {
        try {
          var fb = window.firebase;
          uid = (fb && fb.auth && fb.auth().currentUser && fb.auth().currentUser.uid) || "";
        } catch (e) {}
      }
      if (uidEl && uid) { uidEl.textContent = "Signed in as " + String(uid).slice(0, 10) + "…"; }
    } catch (e) {}

    startCountdown();
  }

  function startCountdown() {
    if (countdownTimer) return;
    secondsLeft = RELOAD_SECONDS;
    renderNote();
    countdownTimer = setInterval(function () {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        window.location.reload();
        return;
      }
      renderNote();
    }, 1000);
  }

  function renderNote() {
    var note = document.getElementById("nexaMaintNote");
    if (note) note.textContent = "Auto-retrying in " + secondsLeft + "s\u2026";
  }

  function nexaHideMaintenance() {
    shown = false;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    var el = document.getElementById("nexaMaintOverlay");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // ── Wrap any Firestore call so a quota error shows the screen ───────────
  // Usage: try { await NexaMaintenance.guard(doThing()); } catch (e) {}
  //        — or simply call NexaMaintenance.check(err) inside an existing catch.
  function nexaCheck(err) {
    if (nexaIsQuotaError(err)) {
      nexaShowMaintenance();
      return true;
    }
    return false;
  }

  function nexaGuard(promise) {
    var p = promise;
    try {
      if (p && typeof p.then === "function") {
        return p.then(
          function (v) { return v; },
          function (err) { nexaCheck(err); throw err; }
        );
      }
    } catch (e) { nexaCheck(e); throw e; }
    return p;
  }

  // ── Global safety net ───────────────────────────────────────────────────
  // Any unhandled quota error anywhere (an onSnapshot callback, a stray await)
  // still surfaces the friendly screen instead of a silent hang.
  window.addEventListener("unhandledrejection", function (ev) {
    try { nexaCheck(ev && ev.reason); } catch (e) {}
  });
  window.addEventListener("error", function (ev) {
    try { nexaCheck(ev && (ev.error || ev.message)); } catch (e) {}
  });

  var api = {
    RELOAD_SECONDS: RELOAD_SECONDS,
    isQuotaError: nexaIsQuotaError,
    check: nexaCheck,
    guard: nexaGuard,
    show: nexaShowMaintenance,
    hide: nexaHideMaintenance,
    // Overridden per-page to also sign the user out before redirecting.
    signOut: function () { window.location.href = "login.html"; }
  };

  window.NexaMaintenance = api;
  // Back-compat convenience for quick inline checks.
  window.nexaIsQuotaError = nexaIsQuotaError;
})();
