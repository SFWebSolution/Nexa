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
- **WhatsApp-style online/last-seen (current behaviour):** online is driven by
  heartbeat FRESHNESS, not the `online`/`status` flags. `isUserOnline(pdata)`
  returns `(Date.now() - pdata.lastSeen) < PRESENCE_TIMEOUT_MS` (90s) and
  intentionally does NOT early-return on `online===false`/`status==="offline"`,
  because those flags flicker false on every mobile background/screen-lock
  (`pagehide`/`beforeunload` fire on tab-switch, not just real close). A fresh
  `lastSeen` with `online:false` is that flicker → still online. When the app
  is truly closed, the heartbeat stops → `lastSeen` goes stale → after 90s the
  user correctly shows "last seen Xm ago". The 90s grace window absorbs mobile
  setInterval throttling (backgrounded tabs run ~1/min).
- `writeOfflineBeacon()` fires a `navigator.sendBeacon` to the Firestore REST
  API on `pagehide`/`beforeunload` so the final `lastSeen`/offline stamp lands
  even when the mobile tab is evicted before the async `set()` resolves (the
  async `updateOnline(false)` is also called as a fallback). This REST write
  targets `projects/mel-odix/.../presence/{uid}` with an `updateMask` for the
  three fields — keep the project id in sync with the Firebase config.
- Do NOT lower `PRESENCE_TIMEOUT_MS` back to 35s or re-add the
  `if (pdata.online === false) return false` short-circuit — both caused the
  "can't see online / flickers offline" symptom on mobile.
- `listenPresence()` (chat header) no longer opens its own listener — it just
  refreshes from the shared cache. `updateChatHeaderPresence` shows "🟢 online"
  when `isUserOnline` is true and "⚪ last seen {formatLastSeen}" otherwise
  (staleness-driven, no "away" branch anymore).

## Audio autoplay / "can't hear anything"
- Browsers block autoplay + suspend `AudioContext` until a user gesture and on
  backgrounding. `resumeAllAudio()` (in dashboard.html) re-triggers `.play()`
  on `#remoteAudio`, `#remoteVideo`, all `audio[id^="audio_"]` (voice room),
  and resumes the voice room's `audioCtx`. It is wired to window `focus`,
  `visibilitychange`, and one-shot `touchstart`/`click` so audio resumes as
  soon as the user opens/returns to the app.
- **Voice room root cause of "can't hear anyone":** `call.on('stream')` fires
  asynchronously OUTSIDE the user-gesture context, so a bare
  `audioEl.play().catch(()=>{})` silently swallows the autoplay rejection and
  the element sits paused forever. `nexa-voice-room.js` now uses
  `attemptAudioPlay()` (retries play() a few times, then parks the peer in
  `pendingAudioPlays`) + `unlockPendingAudio()` wired to PERSISTENT
  `click`/`touchstart`/`visibilitychange`/`focus` listeners that force-start
  parked audio on the next gesture. The dashboard's one-shot `{once:true}`
  listeners are NOT enough for the voice room because streams arrive after
  the join gesture.

## Echo in calls / voice room
- The plain `echoCancellation:true` flag alone does NOT reliably engage
  Chromium's hardware AEC pipeline — speaker output leaks back into the mic
  and callers hear themselves (echo). All `getUserMedia` audio captures now
  use a shared `NEXA_AUDIO_CONSTRAINTS` object (dashboard.html) / inline
  `goog*` flags (nexa-voice-room.js) that include the legacy
  `googEchoCancellation2` / `googNoiseSuppression` / `googAutoGainControl` /
  `googHighpassFilter` constraints. Keep these on every audio capture site
  (3 in dashboard.html: voice-msg recording, startCall, answerCall; 1 in
  nexa-voice-room.js initMicrophone). Do NOT regress to bare
  `{ echoCancellation: true }`.

## One-way / no audio across devices (TURN + ICE retry)
- STUN-only ICE CANNOT traverse symmetric NAT / CGNAT (mobile carriers,
  hotel WiFi, most home routers behind an ISP NAT). Two devices on different
  networks then "answer" but media flows one way or not at all — the classic
  "I hear them, they don't hear me". A TURN relay is the ONLY reliable fix:
  when direct P2P ICE fails, the relay tunnels the audio through a public
  server. Both `NEXA_ICE_SERVERS` (dashboard.html, 1:1 calls) and
  `NEXA_VR_ICE_SERVERS` (nexa-voice-room.js, voice room) now include TURN
  entries. They use the shared public OpenRelay (metered.ca) test
  credentials `openrelayproject` / `openrelayproject` — rate-limited and
  shared; for production sign up for your own free Metered/Twilio/Xirsys
  TURN and replace in BOTH places.
- The voice room mesh has TWO legs per pair (A→B and B→A are separate
  MediaConnections). If one leg's ICE fails, you get one-way audio. The
  incoming-call answer path (`peer.on('call')`) previously had NO
  `call.on('error')` handler, so a failed leg silently died. All call legs
  now go through `attachCallHandlers()` (stream/close/error) which calls
  `retryCallPeer()` once on close/error while the peer is still a room
  participant — recovering from transient ICE blips. `retriedPeers` Set
  guards against close→re-call loops (resets after 15s and on peer leave).
- Do NOT re-introduce bare `call.on('close') => delete` without the
  `retryCallPeer` call, or one-way audio holes won't self-heal.


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
- **Reply quote persistence:** when replying to a message, `extras.replySnapshot`
  (`{id, from, fromName, text, hasImage, hasVideo, hasAudio}`) is stored on the
  outgoing message at SEND time, in addition to `extras.replyTo` (the id). The
  render side (`createBubble`) prefers `msg.replySnapshot` and only falls back to
  `allMessages.find(m => m.id === msg.replyTo)` for legacy replies with no
  snapshot. The snapshot is what makes the quote render on the recipient's side
  and after a reload — without it the quote vanished because the original message
  wasn't guaranteed to be in the locally-loaded `allMessages` (race between the
  two onSnapshot listeners, or recipient loading the reply before the original).
  Keep the snapshot self-contained; do NOT store only an id.
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
- **NEVER put `isUserOnline` in the `Object.defineProperties` block (app-breaking).**
  `isUserOnline` is a top-level `function` declaration, which already creates a
  NON-configurable property on `window` via hoisting. `Object.defineProperties`
  is atomic, so trying to redefine it throws
  `TypeError: Cannot redefine property: isUserOnline`. That uncaught throw
  halts the ENTIRE inline init script before `auth.onAuthStateChanged` is
  registered → the dashboard never redirects to login when signed out and never
  initializes when signed in → app stuck on "Loading…" / "Loading users…"
  forever. `isUserOnline` is already reachable as `window.isUserOnline` (the
  voice room reads it via `typeof window.isUserOnline === 'function'`); it does
  not need a getter. Only `let`-backed caches (`currentUser`, `allUsersData`,
  `userPresenceCache`) go in the defineProperties block, and each getter must be
  TDZ-safe (`try { return x; } catch (_) { return <default>; }`) so an early
  read before the `let` executes can't throw a Temporal Dead Zone error and halt
  init the same way.

## Call engine gotchas (dashboard.html, ~line 4034 "VOICE & VIDEO CALLING ENGINE")
- Voice calls play remote audio through `<audio id="remoteAudio" autoplay playsinline>` (NOT `#remoteVideo`, which is `display:none` during voice calls). Video calls use `<video id="remoteVideo">`.
- `setupCallStreamHandlers()` routes to the correct element based on `callType`.
- Speaker toggle (`toggleCallSpeaker`) must mute/unmute BOTH `#remoteVideo` and `#remoteAudio`.
- `callLogged` flag + `logCallOnce()` guard against double call-log entries (endCall, mediaCall.on('close'), and listenCallStatus all try to log).
- `callStatusUnsub` holds the Firestore onSnapshot unsub for the calls/{id} doc and is cleared in `cleanupCall()`.
- `answerCall()` uses a one-time `nexaPeer.on('call')` handler with an `answered` flag (PeerJS may not expose `.off`, so the flag is the real guard) to handle the race where the PeerJS call arrives after writing "answered" to Firestore.

## Voice Room gotchas (nexa-voice-room.js)
- Stable peer id per user: `peerIdFor(uid)` returns `nexa_vr_<sanitized uid>`. Keep this consistent across all clients.
- **PeerJS answer-before-handlers race (the #1 "can't hear each other" bug):**
  in `peer.on('call')`, `attachCallHandlers()` MUST be called BEFORE `call.answer()`.
  PeerJS can emit the `stream` event (carrying the caller's remote audio) synchronously
  during/immediately after `answer()`. If `call.on('stream', ...)` is wired AFTER
  `answer()` (the old order), the event fires into zero listeners and the answerer
  never plays the caller's audio → asymmetric "B can't hear A". Same fix applies to
  the 1:1 call engine in `dashboard.html`: `setupCallStreamHandlers(mediaCall)` must
  run before `mediaCall.answer()` in BOTH the global `nexaPeer.on('call')` handler AND
  `answerCall()` (incl. the one-time `oneTimeCallHandler`).
- **Mesh double-call guard:** in a 2-way mesh, both an outgoing and an incoming
  MediaConnection can exist for the same peer and share one `peerCalls` slot + one
  `audio_<peerId>` element. `attachCallHandlers`'s `close`/`error` handlers must check
  `this.peerCalls.get(targetPeerId) === call` before deleting the slot / removing the
  audio element — otherwise an orphaned redundant connection closing mid-call kills the
  audio element the still-live connection is using.
- `subscribeToRoomFirestore()` listens to the `voice_rooms/{roomId}/participants` SUBCOLLECTION (docChanges), not an array on the room doc. On a new participant it calls `callPeer(peerIdFor(id))` to build the mesh.
- `upsertOwnParticipantDoc()` writes ONLY this client's own doc (merge). `syncMuteState()` is the throttled (~1.2s) version used by toggleMic/raiseHand.
- **Access control (invite-only):** rooms are invite-only. `startRoom`/`createRoom`
  seeds the room doc with `invitedUids: [hostId]`; `sendInvite` grants access by
  adding the target uid to `invitedUids` via `arrayUnion` (idempotent); `joinRoom`
  is async and calls `canJoinRoom(roomId, uid)` which reads the room doc's
  `invitedUids` — the host is always allowed, anyone not on the list is refused
  with "🚫 You need an invite from the host to join this Voice Chat." The invite
  LINK alone does NOT grant access; the host must invite the person first (which
  also sends the push toast). Multiple rooms coexist independently.
- **Host close destroys the room for everyone:** when the HOST calls `leaveRoom()`,
  it does NOT migrate the host. It batch-deletes ALL participant docs then deletes
  the `voice_rooms/{id}` doc, and broadcasts `ROOM_CLOSED`. Non-host participants
  are kicked two ways: (1) the `voice_rooms/{id}` doc `onSnapshot` listener
  (set up in `subscribeToRoomFirestore`, stored in `this.roomDocUnsub`) sees the
  deletion and auto-`leaveRoom()`s with "📞 The host ended the Voice Chat." — this
  is the cross-device signal; (2) same-browser tabs get the `ROOM_CLOSED`
  BroadcastChannel (handled in `setupChannelListeners`). `this.roomDocUnsub` is
  torn down in `cleanupCall()`/`leaveRoom()` alongside `roomFirestoreUnsub`.
  A NON-host leaving only deletes their OWN participant doc (no room deletion).
- `initPeerJS()` retries if PeerJS isn't loaded yet, falls back to a unique id on `unavailable-id` error, and auto-reconnects on `disconnected`/transient errors. `callPeer` only fires when `this.peer.open`.
- `?voiceroom=<roomId>` URL param auto-joins a room (waits for Firebase + user) — but `joinRoom` still enforces the `canJoinRoom` access check, so an uninvited user following the link is refused. `copyInviteLink()` notes that only invited users can join.

## Invite gotchas (nexa-voice-room.js)
- An invite is delivered via TWO paths: BroadcastChannel `INVITE_USER`
  (same-browser tabs, instant) AND Firestore `voice_invites/{inviteeUid}`
  (cross-device). `showIncomingInvite()` dedupes by `roomId:timestamp` in
  `currentInviteRoomId` so the recipient never sees two stacked toasts. Do
  NOT remove the dedupe guard.
- On Join/Decline the invite doc is DELETED (not marked accepted/declined).
  Leaving a stale 'accepted' doc causes cache-replay to re-fire the listener;
  deleting keeps a future re-invite a clean 'pending' write. Firestore rules
  allow `delete` on `voice_invites/{uid}` for any signed-in user.
- `sendInvite()` keeps the modal open (no `closeInviteModal()`) so the host
  can invite multiple people, and marks each invited user with an
  `invitedUserIds` Set → button flips to a disabled "✓ Invited" state.
- The "Invited" mark is NOT permanent: when a participant LEAVES the room
  (Firestore 'removed' in subscribeToRoomFirestore) or the host leaves
  (`leaveRoom()` clears the set), the user is removed from
  `invitedUserIds` and the invite list re-renders so the "Invite" button
  reappears — the host can re-invite someone who left. Do NOT make
  `invitedUserIds` a persistent/lifetime set.
- **Invite listener uid race (was the #1 invite bug):**
  `setupFirestoreListeners()` is called once from the constructor at +1s.
  At that point Firebase auth has often NOT restored from LOCAL persistence
  yet, so `getCurrentUser()` returns a FAKE random id (`user_xxx`). The old
  code subscribed to `voice_invites/user_xxx` — a doc nobody writes to — so
  cross-device invites never arrived. Now the listener tracks the uid it
  bound to (`inviteListenerUid`) and (a) refuses to subscribe to the fake
  `user_*` id (scheduling a 1.5s re-check) and (b) re-subscribes when the
  real uid lands. The dashboard publishes the real user to
  `window.currentUser` in `onAuthStateChanged` and calls
  `NexaVoiceRoom.bindInviteListener()` so the re-bind is deterministic. Do
  NOT revert `window.currentUser` being set early, and do NOT go back to a
  one-shot `setTimeout(setupFirestoreListeners, 1000)` with no uid check.

## Voice note recording gotchas (dashboard.html, VOICE RECORDING section)
- The mic record button is PRESS-AND-HOLD (WhatsApp-style). The old code
  bound stop to GLOBAL `mouseup`/`touchend` listeners — those fired on ANY
  release anywhere on the page and silently cut recordings short (the
  "stops at ~30s on mobile" symptom, caused by stray touchends / browser
  gestures / context-menu hijacks during a long press). Stop is now bound
  to `pointerup`/`pointercancel`/`pointerleave` ON THE BUTTON ONLY, with
  `touch-action:none` + `user-select:none` to stop the browser stealing the
  long press. Do NOT re-introduce global mouseup/touchend stop listeners.
- CRITICAL: `#voicePanel` is a FULL-SCREEN OVERLAY (`position:fixed;
  inset:0; z-index:9999`) that is shown DURING recording (live timer).
  Because it covers the record button, the `pointerup` release lands on the
  OVERLAY, not the button — so a stop listener bound only to the button
  never fires, `stopRec()` never runs, `recordingBlob` stays null, and
  `sendVoice()` silently returns at `if (!recordingBlob) return`. This was
  the "I'm sending, it is not sending" bug. Fix: `startRec()` also binds
  `pointerup`/`pointercancel` on `#voicePanel` (`onOverlayRecEnd`) while
  recording, and `stopRec()`/`cancelVoice()` remove them. The overlay
  handler ignores clicks on `.vbtn-del`/`.vbtn-send` so Discard/Send keep
  their own behavior. Keep this overlay-listener binding or sending breaks.
- `sendVoice()` no longer silently returns on a missing blob. If recording
  is still active when Send is tapped, it calls `stopRec()` and waits (up
  to 1.5s) for the async `stop` event to produce the blob, then proceeds.
  If there's still no blob it shows a `showNotifToast` error instead of
  doing nothing. Upload/DB failures also surface via `showNotifToast`
  (previously used `alert`, which blocked the UI).
- `mediaRecorder.start(250)` is called WITH a 250ms timeslice so
  `dataavailable` fires periodically and partial audio is preserved if the
  recorder is interrupted (backgrounding, OS grabbing the mic). The old
  `start()` with no timeslice lost everything if it was cut mid-recording.
- The `MediaRecorder` picks the best supported codec from
  `audio/webm;codecs=opus` → `audio/webm` → `audio/ogg;codecs=opus` →
  `audio/mp4`. `sendVoice` uses `recordingBlob.type` for the File so the
  stored clip matches what was recorded. `recDuration` is captured at stop
  time (not at send time) so the displayed duration is accurate even if the
  user waits before sending.
- An `error` handler on MediaRecorder finalizes whatever was captured
  (calls `stop()`) so backgrounding doesn't silently discard the clip.
- `cancelVoice()` now tears down an in-flight recorder/mic if Discard is
  tapped mid-recording (previously it only reset state, leaving the mic
  capturing in the background).

## Auto-login gotchas (login.html)
- Auto-login relies on Firebase `onAuthStateChanged` restoring a
  LOCAL-persisted session, which on a cold start / slow network can take
  several seconds. A 10s watchdog (`autoLoginWatchdog`) shows
  "Restoring your session…" immediately, then after 10s with no resolution
  tells the user they can sign in manually. The manual form is always
  usable the whole time. Do NOT remove the watchdog or the immediate hint.
- The immediate hint is suppressed on `?banned=1`/`?deleted=1` redirects so
  it doesn't overwrite those more important messages.

