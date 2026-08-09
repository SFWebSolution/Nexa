# Nexa Messenger — Repository Notes

## Tech stack
- Static front-end PWA: `dashboard.html` (main app), `login.html`, `signup.html`, `admin.html`.
- Firebase (compat SDK v10.7.1): Auth, Firestore, Messaging. Project id `mel-odix`, storage bucket `mel-odix.firebasestorage.app`.
- Media uploads go to **Cloudinary** (`CLOUD_NAME = "doasf3d1u"`, `UPLOAD_PRESET = "NeuroStack"`), NOT Firebase Storage. See `uploadFile()`.
- PeerJS 1.5.4 loaded from unpkg with jsdelivr fallback.

## Run locally
- Serve the repo root with any static server, e.g. `python3 -m http.server 12000`.
- Work hosts map: port 12000 → work-1, port 12001 → work-2.
- `dashboard.html` redirects to `login.html` when there is no Firebase auth session.

## 1:1 voice/video calls (in dashboard.html)
- Signaling lives in the Firestore `calls` collection. Caller writes `{from,to,type,status:"ringing",callerPeerId}`.
- Callee answers by writing `status:"answered"` + `receiverPeerId`; caller then does `nexaPeer.call(receiverPeerId, localStream)`.
- Global `nexaPeer.on('call')` answers automatically once `callState==='active'` and `localStream` is ready.
- Remote audio for **voice** calls plays through a dedicated `<audio id="remoteAudio">` (NOT `#remoteVideo`). Video calls use `<video id="remoteVideo">`.
- Speaker toggle mutes BOTH `#remoteVideo` and `#remoteAudio`.

## Voice Room (nexa-voice-room.js + nexa-voice-room.css)
- Multi-user mesh via PeerJS. Stable peer id per user: `nexa_vr_<uid>`.
- **Participant sync uses a Firestore subcollection** `voice_rooms/{roomId}/participants/{uid}`. Each client writes ONLY its own participant doc (merge). Never overwrite the whole participants array — that clobbers other users and breaks cross-device visibility.
- `subscribeToRoomFirestore()` listens to the participants subcollection; on a new participant it calls `callPeer()` to build the mesh.
- Remote audio is played in hidden `<audio id="audio_<peerId">` elements with explicit `.play()` (autoplay can be blocked otherwise).
- Speaking/mute state is synced to Firestore (throttled ~1.2s) so cross-device clients reflect rings; `BroadcastChannel` only covers same-browser tabs.

## Presence / online status
- Online dots + chat-header "last seen" are driven by a SINGLE shared
  `db.collection("presence").onSnapshot` listener (`startSharedPresenceListener`)
  that feeds `userPresenceCache`. Do NOT re-introduce per-user
  `presence/{uid}` doc listeners — one per contact exploded Firestore read
  counts and is what broke presence at scale / hit the Spark-plan quota.
- `startLeaderboardListeners()` also listens to `presence` and writes into the
  same `userPresenceCache`, so both paths stay consistent.
- `updateOnline()` marks the user online whenever the app is open (not gated on
  `document.visibilityState === "visible"`), because mobile backgrounding
  flips visibility constantly and caused users to appear offline. Offline is
  only set on explicit `pagehide`/`beforeunload`.
- `listenPresence()` (chat header) no longer opens its own listener — it just
  refreshes from the shared cache.

## Audio autoplay / "can't hear anything"
- Browsers block autoplay + suspend `AudioContext` until a user gesture and on
  backgrounding. `resumeAllAudio()` (in dashboard.html) re-triggers `.play()`
  on `#remoteAudio`, `#remoteVideo`, all `audio[id^="audio_"]` (voice room),
  and resumes the voice room's `audioCtx`. It is wired to window `focus`,
  `visibilitychange`, and one-shot `touchstart`/`click` so audio resumes as
  soon as the user opens/returns to the app.

## Firestore rules + secrets
- `firestore.rules` now exists and is wired into `firebase.json` (`firestore.rules`).
  Deploy with `firebase deploy --only firestore:rules`. Rules allow auth-only
  cross-device reads/writes for users, presence, chats, calls,
  voice_rooms + participants subcollection, voice_invites, status, typing,
  and disappearingSettings.
- `.gitignore` excludes `serviceAccountKey.json` (and variants), `.env`, etc.
  A `serviceAccountKey.json` was previously committed; rotate that key.

## Gotchas
- `firebase.js` and the inline config in `dashboard.html`/`admin.html` duplicate the Firebase config — keep them in sync.
- Firestore security rules must allow the `voice_rooms` / `voice_rooms/{id}/participants` / `voice_invites` / `calls` collections for this to work cross-device.
- `dashboard.html` uses CRLF line endings; preserve them when editing or the whole file shows as changed in git diff.
- **`window.*` exposure (critical for presence + voice room):** `dashboard.html`
  declares `db`, `auth`, `currentUser`, `allUsersData`, `userPresenceCache`,
  `isUserOnline` with top-level `const`/`let`/`function`. In a browser these do
  NOT become `window` properties (only `var` does). `nexa-voice-room.js` is a
  separate `<script>` and can ONLY reach these via `window.*`, and
  `startSharedPresenceListener()`/`startLeaderboardListeners()` guard on
  `if (!window.db) return;`. Without explicit exposure both presence listeners
  silently no-op (no online dots / last seen) and the voice room invite can't
  see who's online. The fix lives right after `const db = firebase.firestore();`:
  `window.db = db; window.auth = auth;` plus an `Object.defineProperties(window,
  {...})` block with live getters for the reassigned caches (`allUsersData` is
  reassigned on every users snapshot, so a one-time assignment would freeze a
  stale reference — getters are required). Do NOT remove this block.

## Call engine gotchas (dashboard.html, ~line 4034 "VOICE & VIDEO CALLING ENGINE")
- Voice calls play remote audio through `<audio id="remoteAudio" autoplay playsinline>` (NOT `#remoteVideo`, which is `display:none` during voice calls). Video calls use `<video id="remoteVideo">`.
- `setupCallStreamHandlers()` routes to the correct element based on `callType`.
- Speaker toggle (`toggleCallSpeaker`) must mute/unmute BOTH `#remoteVideo` and `#remoteAudio`.
- `callLogged` flag + `logCallOnce()` guard against double call-log entries (endCall, mediaCall.on('close'), and listenCallStatus all try to log).
- `callStatusUnsub` holds the Firestore onSnapshot unsub for the calls/{id} doc and is cleared in `cleanupCall()`.
- `answerCall()` uses a one-time `nexaPeer.on('call')` handler with an `answered` flag (PeerJS may not expose `.off`, so the flag is the real guard) to handle the race where the PeerJS call arrives after writing "answered" to Firestore.

## Voice Room gotchas (nexa-voice-room.js)
- Stable peer id per user: `peerIdFor(uid)` returns `nexa_vr_<sanitized uid>`. Keep this consistent across all clients.
- `subscribeToRoomFirestore()` listens to the `voice_rooms/{roomId}/participants` SUBCOLLECTION (docChanges), not an array on the room doc. On a new participant it calls `callPeer(peerIdFor(id))` to build the mesh.
- `upsertOwnParticipantDoc()` writes ONLY this client's own doc (merge). `syncMuteState()` is the throttled (~1.2s) version used by toggleMic/raiseHand.
- `leaveRoom()` deletes ONLY the own participant doc, then migrates host to the next remaining participant (or deletes the room doc if empty). Never overwrite a participants array.
- `initPeerJS()` retries if PeerJS isn't loaded yet, falls back to a unique id on `unavailable-id` error, and auto-reconnects on `disconnected`/transient errors. `callPeer` only fires when `this.peer.open`.
- `?voiceroom=<roomId>` URL param auto-joins a room (waits for Firebase + user). `copyInviteLink()` generates these links.

