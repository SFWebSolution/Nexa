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

## Stories / status (`status` collection)
- Stories live in the Firestore `status` collection (doc id auto, fields: `uid`, `type`, `createdAt` (ms epoch), `expireAt` (Firestore Timestamp = createdAt + 24h), `url`/`text`/`musicData`, `views`, `likes`, `reshares`).
- **Stories auto-expire 24h after posting and are actually DELETED, not just hidden.** Every open client's `startStatusListener()` garbage-collects ALL expired stories on each snapshot (any signed-in user may delete a story past its `expireAt`, per the Firestore rule). New stories are stamped with `expireAt = firebase.firestore.Timestamp.fromMillis(createdAt + 24h)`. Legacy docs without `expireAt` are expired via `createdAt + 24h`. A story with no usable timestamp is treated as already expired (deleted). Don't re-introduce a "never delete, only hide" listener — that left `status` growing forever and inflated Firestore reads (same quota failure mode as the old per-user presence listeners).
- **Firestore rules (`firestore.rules`, `match /status/{statusId}`)** are what make cross-user deletion safe: `allow delete` = owner anytime OR `storyExpired(resource.data)` (past `expireAt`, or legacy `createdAt + 24h`); `allow update` = owner anytime OR non-owner touching ONLY `views`/`likes`/`reshares` (`affectedKeys().hasOnly`); `allow create` = own uid + `createdAt is int` + `expireAt` is a future Timestamp (optional). **The old rule was owner-only update, which silently broke view/like/reshare recording on others' stories — that's now fixed.** Rules must be DEPLOYED to take effect: `firebase deploy --only firestore:rules` (project `mel-odix`; create a local `.firebaserc` with `{projects:{default:"mel-odix"}}` — it's gitignored).
- **`startStatusListener()` is scoped to the last 24h** via `.where("createdAt", ">=", Date.now() - 24h)` (a single-field range query — `createdAt` is auto-indexed, no composite index needed). This is the single biggest stories read saver: instead of re-reading the ENTIRE `status` collection on every post/view anywhere, Firestore only returns the last 24h of stories. A client-side TTL guard also drops any story that aged past 24h during a very long session (the server query cutoff is fixed at listener creation). Do NOT revert to an unscoped `db.collection("status").onSnapshot`.
- The dashboard "Weekly Most Active Users" leaderboard in Settings has been REMOVED (it ran a real-time week-scoped `chats` listener + derived scores on every send/presence/status change). `admin.html` still has its own separate leaderboard. Do NOT re-add a leaderboard to `dashboard.html`.

## Chat list ordering (`renderUsers`)
- The user list is sorted primarily by **last-chat time** (`latestMsgTime[uid]`, descending) — "those you chatted last" on top. Favorites / online / name are only tiebreakers among contacts with the same (or no) last-chat time. Don't put favorites or a "has message" tier ABOVE recency — that buries recently-chatted contacts under old favorites.
- `latestMsgTime` is persisted to `localStorage` (`nexa_latest_msg_time`) and restored on app open for instant ordering, then refreshed from Firestore (`loadInitialChatTimestamps`).

## Presence / online status
- Online dots + chat-header "last seen" are driven by a SINGLE shared
  `db.collection("presence").onSnapshot` listener (`startSharedPresenceListener`)
  that feeds `userPresenceCache`. Do NOT re-introduce per-user
  `presence/{uid}` doc listeners — one per contact exploded Firestore read
  counts and is what broke presence at scale / hit the Spark-plan quota.
- **"Online" = the user's app is actively heartbeating RIGHT NOW** (the
  "in the app alone" rule). `isUserOnline(pdata)` returns true ONLY if
  `lastSeen` (or `last_seen`) is fresher than `PRESENCE_TIMEOUT_MS` (90s),
  i.e. the heartbeat wrote within the last ~90s. It does NOT trust a bare
  `online === true` / `status === "online"` flag — that flag lingers true
  forever when a mobile tab is swiped away without firing `beforeunload`.
  An explicit `online === false` / `status === "offline"` wins immediately
  (returns false) so a clean logout/`pagehide` shows offline at once; in every
  other case it's pure heartbeat freshness. This is what makes online status
  reflect ONLY people who currently have the app open.
- **Heartbeat (`heartbeat()`):** runs every 30s via `setInterval` and is NOT
  gated on `document.visibilityState === "visible"` — a backgrounded-but-open
  tab is still "in the app", so it keeps heartbeating and stays online. It
  refreshes `lastSeen`/`last_seen` + re-asserts `online:true` while PRESERVING
  the current `userStatus` (so the inactivity timer's "away" status isn't
  clobbered). A truly closed/killed app stops heartbeating → `lastSeen` goes
  stale → within ~90s the user shows "last seen Xm ago", even when
  `beforeunload`/`pagehide` failed to fire (mobile often doesn't). The 30s
  interval (was 10s) cuts presence writes ~3x and reduces presence-listener
  re-fires ~3x; the 90s window gives a 3x margin so a single missed tick
  doesn't flicker a user offline.
- `updateOnline(on)` is now only for state transitions (init online, explicit
  offline on `beforeunload`/`pagehide`, back-to-online on interaction). Going
  online preserves "away" if idle; going offline sets `status:"offline"`.
- `visibilitychange` → hidden does NOT write offline (the tab is still alive);
  visible re-asserts online + `resumeAllAudio()`. Only `beforeunload`/`pagehide`
  write offline (true close) — and if they don't fire, staleness handles it.
- Inactivity (3 min, `resetInactivity`): sets `userStatus = "away"` and calls
  `heartbeat()` (so an idle-but-open user shows 🟡 away, still "online" by
  freshness). Any click/key/mouse resets to "online" + heartbeat.
- The 10s ticker also re-evaluates dots/Active Now/chat-header from the cache,
  so a stale peer flips to offline locally without waiting for their write.
- `updateChatHeaderPresence` shows "🟢 online" (fresh + status online),
  "🟡 away" (fresh + status away), or "⚪ last seen {formatLastSeen}".
- `listenPresence()` (chat header) no longer opens its own listener — it just
  refreshes from the shared cache.

## Firestore quota / read+write optimization (do NOT undo)
Several patterns burned the Spark-plan quota. These are fixed and MUST stay fixed:
- **Dashboard weekly leaderboard — REMOVED entirely.** It previously opened a
  real-time `chats` listener (scoped to the week) plus derived scores on every
  send/presence/status change, and (before that) THREE extra full-collection
  listeners (`users`, `chats`, `status`). The leaderboard UI, its JS
  (`startLeaderboardListeners`, `renderWeeklyLeaderboard`, `reloadWeeklyStats`,
  `computeStoryScores`, `getCurrentWeekStart`, `getWeekDateRange`, `getMonday`,
  `normalizeTimestamp`, `checkUserOnline`), and its `adminUsers`/`adminPresenceData`/
  `cachedMsgScores`/`cachedStoryScores`/`leaderboard*Unsub` globals are all gone
  from `dashboard.html`. `admin.html` keeps its own independent leaderboard.
  Do NOT re-add a leaderboard to the dashboard.
- **Status/stories listener scoped to 24h**: `startStatusListener()` uses
  `.where("createdAt", ">=", Date.now() - 24h)` so Firestore returns only the
  last 24h of stories instead of the whole `status` collection on every change.
  Single-field range, no composite index. Do NOT revert to unscoped.
- **Unread counts scoped to unread-only**: `loadUnreadCounts()` listens to
  `.where("to","==",me).where("read","==",false)` and rebuilds per-sender
  counts from the (small) unread snapshot each event. Previously it listened to
  the ENTIRE incoming inbox (every message ever received) and re-read all of it
  on every change — a major read burner for users with long histories. The
  all-equality query needs no composite index (Firestore zigzag-merges
  single-field indexes). `recountUnreadForSender` was removed (no longer needed).
- **Read-marking** (`markRead()` + the messages-B onSnapshot): previously did
  one `update()` call PER unread message (N writes for N unread). Now both use
  a single `db.batch()` so opening a chat with many unread messages is ONE
  write request.
- **Typing indicator**: the input handler previously wrote `typing:true` on
  EVERY keystroke (many writes/sec during fast typing). Now a
  `typingCurrentlyActive` guard writes `typing:true` only ONCE per typing
  session (idle→typing transition); the 1200ms timeout writes `typing:false`
  and clears the guard. The guard is reset on chat switch.
- **Heartbeat**: 30s (was 10s) → ~3x fewer presence writes, and the presence
  listener re-fires ~3x less. `PRESENCE_TIMEOUT_MS = 90000` (was 35000) gives
  a 3x safety margin so a single missed heartbeat doesn't flicker offline.
- **"Active Now" bar** (Facebook-style): `renderActiveNowBar()` (dashboard.html)
  draws a horizontal row of round avatars + green dots showing ONLY
  currently-online users (via `isUserOnline()` freshness). Hidden entirely when
  no one is online; re-called from `renderUsers()`, `startSharedPresenceListener`,
  and the 10s ticker. Container `#activeNowBar`; CSS `.active-now-*` in dashboard.css.
- `nexa-voice-room.js` `isUserOnline(uid)` delegates to `window.isUserOnline`
  (the shared timestamp rule); its fallbacks use the SAME freshness rule and do
  NOT trust a stale `u.online === true` user flag.

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
- The voice room mesh uses ONE bidirectional MediaConnection per pair,
  enforced by a tie-breaker: `shouldInitiateCallTo(theirUid)` returns
  `String(myUid) < String(theirUid)` — only the lower-uid peer INITIATES the
  call; the other ANSWERS. A single PeerJS call carries audio both ways, so one
  connection is enough. Do NOT let both peers call each other: that creates two
  redundant connections keyed under the SAME `peerCalls[peerId]` slot; when
  PeerJS prunes one, the shared `audio_<peerId>` element tears down while the
  survivor already fired `stream` → that pair goes permanently deaf (the
  "even 2 people can't hear each other" bug). `callPeer(peerId, uid)` and the
  `peer.on('open')` / participants-`added` paths all gate on the tie-breaker;
  ANSWERING (`peer.on('call')`) is always allowed (only initiation is gated).
- `attachCallHandlers(call, targetPeerId)` MUST be called BEFORE `call.answer()`
  on the answer side. PeerJS can fire `stream` synchronously during/immediately
  after `answer()`, and attaching `call.on('stream')` AFTER means the caller's
  audio fires into zero listeners → asymmetric "B can't hear A". (The answer
  path calls `attachCallHandlers(call, call.peer)` then `call.answer(...)`.)
- `attachCallHandlers` wires stream/close/error. close/error: a double-call
  guard (`this.peerCalls.get(peerId) !== call` → skip) prevents tearing down
  a newer survivor; then it deletes the slot, removes the audio element, and
  retries ONCE via `retryCallPeer()` — but only if this peer is the initiator
  (tie-breaker), so the answerer doesn't recreate the redundant leg.
  `retriedPeers` Set guards against close→re-call loops (resets after 15s and
  on peer leave). Do NOT re-introduce bare `call.on('close') => delete`
  without the retry, or one-way audio holes won't self-heal.
- `peerIdToUid` Map (peerId→uid) is populated from participant docs and
  `peer.on('open')` so `attachCallHandlers`/`retryCallPeer` can resolve a
  `call.peer` (a peerId) back to a uid for the tie-breaker. It is cleared on
  leave/host-close.
- A 10-user room = 9 connections per peer worst case (mesh). With the
  tie-breaker there are exactly N*(N-1)/2 total connections (45 for 10), one
  per pair, all bidirectional — everyone hears everyone.
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
- `dashboard.html` uses CRLF line endings; preserve them when editing or the whole file shows as changed in git diff. `dashboard.css` ALSO uses CRLF — the `file_editor` tool strips CRLF on save, so after editing either file run the normalize step (`python3 -c "d=open('dashboard.css','rb').read(); d=d.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'); open('dashboard.css','wb').write(d)"`) or the whole file shows as changed in git diff.
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
- **`window.db.fieldValue`** is set to `firebase.firestore.FieldValue` so the
  voice room module (which only has `window.db`) can use `arrayUnion` for the
  invite-only `invitedUids` grant. Keep it exposed.
- **WhatsApp-style "chat yourself":** `renderUsers()` prepends a synthetic
  self-contact (uid === currentUser.uid) pinned at the top of the chat list
  (`.user-item.self-chat-item`). `isSelfChat()` = `selectedUser.uid ===
  currentUser.uid`. `loadMessages()` uses a SINGLE listener (from==me &&
  to==me) for self-chat — the normal A/B split would run two identical queries
  and double-render. `sendMessage()` skips the push notification and marks the
  message `read: true` immediately. `listenIncoming()` and `loadUnreadCounts()`
  both skip messages where `from === currentUser.uid` (don't toast/notify
  yourself, don't count as unread). `selectChat()` skips `listenPresence()` +
  `listenTyping()` for self-chat (no presence/typing for yourself). Call
  buttons (`openVoiceCall`/`openCallModal`) are blocked for self-chat. Long-
  press delete on the self-contact row is disabled (you can still delete
  individual messages inside). `getChatKey(uid, uid)` returns the single uid
  (sorted join), so disappearing-settings works for self-chat too.

## Stories gotchas (dashboard.html, "STORIES / STATUS" + story viewer)
- **Add Yours composer z-index (the "Add Yours button does nothing" bug):**
  `#addYoursModalOverlay` uses class `status-modal-overlay` (z-index 8000) but
  is opened FROM the story viewer overlay (`.story-viewer-overlay`, z-index
  9000). Without an override the composer opens BEHIND the story viewer and is
  invisible, so tapping "Add Yours" appears to do nothing. The override
  `#addYoursModalOverlay { z-index: 9500; }` (above the story viewer) is the
  fix — do NOT remove it. The prompt-responses viewer uses
  `notif-settings-overlay` (z-index 9500) and is already above the viewer.
- **Pause the story when a sticker action opens a modal:** the story auto-
  advances on a timer (`startStoryAnimation`). `openAddYoursComposer()`,
  `openPromptResponsesModal()`, and `answerStoryQuestion()` must call
  `pauseStoryPlayback()` so the story doesn't advance behind the modal and
  dismiss it. Do NOT remove those pause calls.
- **`handleStoryContentClick` exclusion list:** a tap on `#storyViewerContent`
  toggles pause UNLESS the target is inside one of the excluded selectors
  (`#storyViewerActions`, `#storyViewerHeader`, `#storyStatsBar`,
  `.story-sticker-overlay`, `.addyours-sticker`, `.prompt-story-overlay`,
  `.addyours-cta-btn`, `.addyours-viewall-btn`). When adding a new tappable
  element inside a story slide, add its class here or the tap will toggle
  pause instead of firing the element's own handler.
- **Reshare carries the sticker chain:** `reshareStory()` copies `sticker`,
  `promptId`, `promptText`, `questionId`, `questionText` onto the reshared
  doc so a reshared "Add Yours" / "Ask a Question" story keeps the same
  prompt viewers can tap into (WhatsApp-style). Don't drop these fields on
  reshare or the chain breaks.
- **Chat Info contact header:** `#infoPanel` (Chat Info, opened from the chat
  header ℹ️ button) now starts with a contact profile header
  (`.info-contact`: avatar + name + presence + 24h note) rendered by
  `renderInfoContact()` (called from `openChatInfo()`). The avatar opens the
  full-pic viewer with `returnTo='chatinfo'` so `profilePicGoBack()` returns
  to the Chat Info panel. The 24h note reuses `fetchUserNote(uid)`.

## Call engine gotchas (dashboard.html, ~line 4034 "VOICE & VIDEO CALLING ENGINE")
- Voice calls play remote audio through `<audio id="remoteAudio" autoplay playsinline>` (NOT `#remoteVideo`, which is `display:none` during voice calls). Video calls use `<video id="remoteVideo">`.
- `setupCallStreamHandlers()` routes to the correct element based on `callType`.
- Speaker toggle (`toggleCallSpeaker`) must mute/unmute BOTH `#remoteVideo` and `#remoteAudio`.
- `callLogged` flag + `logCallOnce()` guard against double call-log entries (endCall, mediaCall.on('close'), and listenCallStatus all try to log).
- `callStatusUnsub` holds the Firestore onSnapshot unsub for the calls/{id} doc and is cleared in `cleanupCall()`.
- `answerCall()` uses a one-time `nexaPeer.on('call')` handler with an `answered` flag (PeerJS may not expose `.off`, so the flag is the real guard) to handle the race where the PeerJS call arrives after writing "answered" to Firestore.
- **TURN relays are REQUIRED for cross-network calls.** `NEXA_ICE_SERVERS` includes OpenRelay TURN entries (metered.ca, public test creds `openrelayproject`). STUN-only ICE cannot traverse symmetric NAT/CGNAT (mobile carriers, hotel WiFi, most ISP routers) — calls "connect" at the signaling level but no media flows → one-way/no audio. Replace the public OpenRelay creds with your own Metered/Twilio TURN for production (the public relay is rate-limited).
- **`setupCallStreamHandlers()` must run BEFORE `mediaCall.answer()`.** PeerJS can fire `stream` synchronously during `answer()`; wiring handlers after means remote video/audio fires into zero listeners → "can hear but can't see" (video) / one-way audio. The handler attaches `mediaCall.on('stream')`, a polled `peerConnection.ontrack` fallback (peerConnection may not exist immediately — polls every 200ms up to 10×), and `oniceconnectionstatechange` (auto `restartIce()` on `failed`). Voice calls route audio to `#remoteCallAudio`; video calls also pipe the stream to `#remoteVideo` (muted, audio comes from `#remoteCallAudio` to avoid echo).
- **User profile modal:** clicking the chat header avatar calls `openUserProfile()` which opens `#userProfileModal` (NOT just a toast). Shows avatar (click to zoom via `openProfilePic`), name, presence status from `userPresenceCache`, bio/username, and the user's **24h profile note** (fetched via `fetchUserNote`). Action buttons: Message / Voice / Video. `closeUserProfile()` closes both via no-arg and event-based overloads. Avatar is 72px (down from 92px) and the close button is a **← back button** top-left (`.user-profile-back`), not ✕.
- **Full profile pic viewer (`#profilePicModal`):** tapping the avatar in `#userProfileModal` calls `openProfilePic(src, 'profile')`, opening a WhatsApp-style full-pic viewer with a **normal-sized** image (`max-width: min(380px,86vw)`, `max-height: 70vh`, `object-fit: contain` — NOT the old oversized natural-size render) and its own **← back button** (`.profile-pic-back` → `profilePicGoBack()`) that returns to the contact profile modal when opened from there. `#profilePicModal` sits above `#userProfileModal` (z-index 10100 vs 10000).
- **Profile Notes (24h):** `profile_notes/{uid}` Firestore collection. The Profile/Settings tab has a note editor (`#profileNoteInput`, `saveProfileNote()`, `loadProfileNote()` with onSnapshot). Notes auto-expire after 24h (enforced on read in `fetchUserNote`/`loadProfileNote` by checking `createdAt`). `openUserProfile()` calls `fetchUserNote(uid)` to display the other user's active note in `#userProfileNote`. Firestore rules: auth-only read; owner-only write/delete.
- **"Add Yours" stories (WhatsApp-style prompt sticker):** a story type `type:"prompt"` with `promptId` + `promptText`. Created via the ➕ tab in the story composer (`switchStatusTab('addyours')` → `shareStatus` builds a prompt doc). When viewing a prompt story, `renderStorySlide` renders a prompt card with an "Add Yours" CTA button + "View all N responses" link. Tapping "Add Yours" opens `#addYoursModalOverlay` composer (`openAddYoursComposer`) where the viewer posts an image/video/text response — saved as a normal `status` doc carrying the same `promptId`/`promptText`. Response stories render a tappable `.addyours-sticker`; tapping it reopens the composer seeded with the SAME prompt (WhatsApp reshare chain — viewer posts their own), and a small `.addyours-sticker-viewall` link opens `openPromptResponsesModal(promptId)` to browse all responses (gathered client-side from `userStatuses` since the status onSnapshot already loads all docs). No extra Firestore collection needed — the `promptId` field on `status` docs is the link key.
- **WhatsApp-style sticker ON a photo (the correct model):** stickers are NOT posted on their own — you pick a photo/video/text in the story composer, then tap the **😀 sticker toolbar button** (top-right of the preview, `.sticker-tool-btn`) which opens a `.sticker-tray` popup with "Add Yours" / "Ask a Question". `attachStorySticker('addYours'|'question')` requires content first (it toasts "Pick a photo first" otherwise) and stores `pendingStorySticker = {type, text, id}`. The sticker renders **ON the preview image** as a `.ws-sticker-card` (`.sticker-on-image` overlay, removable). `shareStatus` saves it as `statusData.sticker = {type, text, id}` (and, for backward-compat, also writes `promptId`/`promptText` for addYours or `questionId`/`questionText` for question); the story stays a normal image/video/text story with a URL. In the viewer, `renderStorySlide` renders the SAME `.ws-sticker-card` as a `.story-sticker-overlay` riding on the image (bottom-center); tapping it: addYours → `openAddYoursComposer(sticker.id, sticker.text)` (viewer posts own photo w/ same prompt); question → `answerStoryQuestion(story)`. `refreshStickerToolButton()` enables/disables the sticker button based on whether content exists; it's called from `switchStatusTab`/`previewStatusImage`/`previewStatusVideo`/`updateStoryStickerPreview` (textarea oninput). `handleStoryContentClick` ignores `.story-sticker-overlay`/`.addyours-sticker` so taps don't toggle pause; `handleStatusOverlayClick` closes the tray when clicking outside. Legacy standalone `type:"prompt"`/`type:"question"` imageless stories still render. **Don't re-add standalone ➕/❓ tabs that post the sticker alone** — that's the bug the user reported ("only the sticker posts on its own nothing else").
- **"Ask a Question" stories:** a story type `type:"question"` with `questionId` + `questionText`. The WhatsApp-correct path is to attach a question STICKER to a photo (see above). Legacy standalone question stories (imageless) still render as a purple question overlay with a "💬 Type your answer" CTA; `answerStoryQuestion(story)` prompts the viewer and sends the answer to the asker as a `chats` doc carrying `storyReplyId`/`storyReplyUid` (renders via the existing story-reply preview card) + `storyQuestionId`/`storyQuestionText`/`storyQuestionAnswer`. `answerStoryQuestion` reads the question text from `story.sticker.text` first, falling back to `story.questionText`/`story.text`.



## Push notifications — ONE notification per message (firebase-messaging-sw.js + dashboard.html)
- The receiver's service worker (`firebase-messaging-sw.js`) registers ONLY the native `push` event listener and calls `showNotification` exactly once. Do NOT re-add `messaging.onBackgroundMessage(...)` — it wraps the same push event and produces a 2nd notification for the same message (the "2-3 notifications per message" bug).
- Notifications use a **stable `tag`** derived from `data.messageId` (`nexa-msg-<messageId>`), so if the backend delivers the same message to several of the user's FCM tokens, the OS collapses them into a single notification instead of stacking.
- `sendPushNotification(title, body, target, extraData)` generates `notifId` and sends it as `data.messageId` to the backend; pass `extraData.messageId` to reuse an existing id. Calls use the fixed tag `nexa-incoming-call`.
- Foreground handler (`messaging.onMessage` in `initFCM`) shows an in-app toast always, but shows a SYSTEM notification only when the relevant chat is NOT already open & focused (`sameChatOpen` guard on `selectedUser.uid` + `visibilityState` + `document.hasFocus()`), avoiding toast+system duplicates while reading. It reuses the same stable `tag` as the SW.

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
- **Audio mesh uses a tie-breaker, NOT a full bidirectional call graph.** Every peer only INITIATES calls to participants whose uid sorts strictly greater than its own (`shouldInitiateCallTo(theirUid)` = `myUid < theirUid`), and ANSWERS all incoming calls. This yields exactly ONE bidirectional MediaConnection per pair (a single PeerJS call carries audio both ways: caller's stream → answerer, answerer's stream → caller via `call.answer(stream)`). Do NOT revert to "every peer calls every other peer" — that creates two redundant connections per pair both keyed under the same `peerCalls[peerId]` slot; when PeerJS prunes one, the shared `audio_<peerId>` element is torn down while the survivor has already fired its `stream` event, so that pair goes permanently deaf → the "only two people can hear each other in a 3+ room" bug. `retryCallPeer` is also gated by the tie-breaker (only the initiator retries) so a reconnect never recreates the redundant second leg.
- `upsertOwnParticipantDoc()` writes ONLY this client's own doc (merge). `syncMuteState()` is the throttled (~1.2s) version used by toggleMic/raiseHand.
- **TURN relays are REQUIRED for the voice room mesh too** (same reason as 1:1 calls). `initPeerJS()` `iceServers` includes OpenRelay TURN entries. STUN-only ICE = "in the same room but can't hear anyone across networks".
- **`syncOwnPeerId()` writes the ACTUAL `this.peer.id` to the participant doc** (called in `peer.on('open')`). `upsertOwnParticipantDoc()` writes the stable `peerIdFor(uid)`, but if the stable id was taken (another tab/device) PeerJS falls back to `nexa_vr_<uid>_xxxx`. Other peers call the id from the participant doc — if it's the stale stable id, the call goes to a non-existent peer and fails silently. The participants `onSnapshot` `modified` handler detects a `peerIdChanged` and re-calls the new id (closing the stale call/audio first). `peer.on('disconnected')` reconnects and re-meshes after 1.5s.
- **Invite docs are DELETED on accept/decline** (not just status-flagged). `showIncomingInvite`'s join/decline handlers `delete()` the `voice_invites/{uid}` doc so stale invites don't re-toast on reload.
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
- **In-room text chat:** `subscribeToRoomChat()` listens to the `voice_rooms/{roomId}/messages` subcollection (`orderBy('createdAt')`, `limitToLast(100)`). `sendRoomMessage()` adds a doc `{uid, name, avatar, text, createdAt: Date.now()}`. The chat panel markup lives inside the voice room overlay body (`#nexaVrChatMessages` / `#nexaVrChatInput`). `roomChatUnsub` is cleared in `leaveRoom()` alongside `roomFirestoreUnsub`. Firestore rules allow any signed-in user to read, only the sender to create/delete their own message.

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


## Scroll-to-bottom button (dashboard.html)
- WhatsApp-style floating button `#scrollDownBtn` (`.scroll-down-btn` in
  dashboard.css) sits absolute inside `.chat` (bottom: 92px, right: 18px,
  z-index 40). It shows only when `#messages` is scrolled >200px from the
  bottom (`isChatNearBottom`), toggled via `updateScrollDownBtn()` which is
  wired to the messages div's inline `onscroll` and called from
  `renderMessageList()` (both exit paths) and `selectChat()`.
- `scrollChatToBottom()` just sets `box.scrollTop = box.scrollHeight` —
  `.messages` already has `scroll-behavior: smooth`, so it animates.
- The green badge (`#scrollDownBadge`) counts incoming messages that arrive
  while the user is scrolled up (`scrollDownNewCount`, incremented in
  `renderMessageList` only when the new last message has a NEWER `createdAt`
  — an id check alone false-positives when the last message is deleted).
  Counter resets on reaching the bottom, on button click, and on chat switch.

## Security hardening (do NOT regress)
- **`safeMediaUrl(url)`** (dashboard.html, next to `escapeHtml`): every URL from
  Firestore/APIs that gets interpolated into HTML markup (`src="…"`,
  `style url("…")`, inline `onclick`) MUST go through it. It allows only
  http(s)/blob:/data:image|video|audio and strips quotes/backslashes so a
  crafted URL can't break out of the attribute or run `javascript:`. Applied
  at: chat image/video bubbles, view-once media, story-reply thumbnails,
  shared-media grid, wallpapers, music art, prompt-response media, and user
  photos (sanitized centrally in `startUsersListener` + `loadCachedUsers`,
  which covers every avatar sink).
- Text content is safe via `escapeHtml`/`linkify`/`textContent` — keep it
  that way; never interpolate raw user text into innerHTML.
- **CSP + referrer meta tags** are set in the `<head>` of dashboard.html,
  login.html, signup.html, admin.html, index.html. dashboard.html's CSP
  allows gstatic/unpkg/jsdelivr scripts (with 'unsafe-inline' for the inline
  init script), https/wss connect-src, and frame-src limited to
  askifyai.onrender.com. If you add a new external script/frame/font, extend
  the CSP or it will be blocked.
- **firestore.rules tightened** (must be DEPLOYED:
  `firebase deploy --only firestore:rules`):
  - chats/calls create requires `from == request.auth.uid` (no impersonation)
    + `to` non-empty + `text` ≤ 10000 chars.
  - chats update split by role: recipient (`to`) may only touch
    read/readAt/status/react/reactions/viewOnceOpened; sender (`from`) may
    additionally edit text/edited/editedAt/updatedAt (text size re-checked).
    NOTE: client reaction writes use field `reactions`, edits use `editedAt`
    — keep both in the allowed lists or those features break.
  - voice_rooms delete = host only (`hostId`); voice_invites create/update
    only into someone else's doc, delete only by the invitee.
  - typing docs are keyed by the TYPER's uid (not the chat key!) — read:
    any signed-in user, write: owner only. disappearingSettings docs are
    keyed by getChatKey (sorted uid pair joined with "_") and restricted to
    pair members via `request.auth.uid in keyId.split('_')`.
- Chat textarea has `maxlength="5000"` (client-side cap; the 10000-char rules
  cap is the server-side backstop).
- Scroll button: `scrollChatToBottom()` uses `scrollIntoView` on the last
  `.msg` + deferred re-scrolls (250/600ms) so late-loading media can't leave
  the view stranded above the latest message.
