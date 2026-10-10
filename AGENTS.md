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
- **Firestore rules (`firestore.rules`, `match /status/{statusId}`)** are what make cross-user deletion safe: `allow delete` = owner anytime OR `storyExpired(resource.data)` (past `expireAt`, or legacy `createdAt + 24h`); `allow update` = owner anytime OR non-owner touching ONLY `views`/`likes`/`reshares` (`request.resource.data.diff(resource.data).affectedKeys().hasOnly(...)` — `affectedKeys()` is a method on the MapDiff returned by `diff()`, NOT directly on `request.resource.data`; the bare form throws "Function not found: affectedKeys" and denies EVERY non-owner update, i.e. "Missing or insufficient permissions" on story likes/reshares/views); `allow create` = own uid + `createdAt is int` + `expireAt` absent (`!('expireAt' in request.resource.data)`) or a future Timestamp — never write `request.resource.data.expireAt == null`, accessing a MISSING key errors the whole rule and denies reshared-story creates (reshareStory omits `expireAt`). Both bugs emulator-verified. **The old rule was owner-only update, which silently broke view/like/reshare recording on others' stories — that's now fixed.** Rules must be DEPLOYED to take effect: `firebase deploy --only firestore:rules` (project `mel-odix`; create a local `.firebaserc` with `{projects:{default:"mel-odix"}}` — it's gitignored).
- **`startStatusListener()` is scoped to the last 24h** via `.where("createdAt", ">=", Date.now() - 24h)` (a single-field range query — `createdAt` is auto-indexed, no composite index needed). This is the single biggest stories read saver: instead of re-reading the ENTIRE `status` collection on every post/view anywhere, Firestore only returns the last 24h of stories. A client-side TTL guard also drops any story that aged past 24h during a very long session (the server query cutoff is fixed at listener creation). Do NOT revert to an unscoped `db.collection("status").onSnapshot`.
- The dashboard "Weekly Most Active Users" leaderboard in Settings has been REMOVED (it ran a real-time week-scoped `chats` listener + derived scores on every send/presence/status change). `admin.html` still has its own separate leaderboard. Do NOT re-add a leaderboard to `dashboard.html`.

## Chat list ordering (`renderUsers`)
- The user list is sorted primarily by **last-chat time** (`latestMsgTime[uid]`, descending) — "those you chatted last" on top. Favorites / online / name are only tiebreakers among contacts with the same (or no) last-chat time. Don't put favorites or a "has message" tier ABOVE recency — that buries recently-chatted contacts under old favorites.
- `latestMsgTime` is persisted to `localStorage` (`nexa_latest_msg_time`) and restored on app open for instant ordering, then refreshed from Firestore (`loadInitialChatTimestamps`).

## User discovery by username (`renderUsers` + `#userSearch`)
- **Any signed-in user can find any other user by their @username** via the
  `#userSearch` box in the chat sidebar; results open `selectChat` on click
  (the row's click handler un-deletes a deleted-chat entry on open). This is
  what the change-username hint means by "others find you by this handle" —
  don't weaken username search.
- Search matching rules in `renderUsers()` (`app-main.js`):
  - Empty query: hidden deleted chats only.
  - Query starting with `@`: matches `handle === bare || handle.includes(bare) || name.includes(bare)` (exact/prefix over username, display-name fallback).
  - Other queries: `name.includes(q) || handle.includes(q) || phone-digits includes` (phone digits stripped).
  - **During a search, deleted chats are NOT hidden** so a deleted conversation
    still surfaces the person when you look up their handle (clicking re-opens).
- The **instant-paint fallback** in `dashboard.html` (runs before Firebase/app
  JS loads) renders `.user-handle` under each `.user-name` and its fallback
  `window.searchUsers` matches BOTH `.user-name` and `.user-handle` text — keep
  both in sync with the main `renderUsers` if you touch username rendering.

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
- The 10s ticker also re-evaluates dots/chat-header from the cache,
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
- **"Active Now" bar — REMOVED entirely (do NOT re-add).** The Facebook-style
  horizontal avatar strip is gone: `renderActiveNowBar()` +
  `selectUserFromActiveNow()` and all their call sites were deleted from
  `app-main.js`, the `#activeNowBar`/`#activeNowScroller` markup was deleted from
  `dashboard.html`, and all `.active-now-*` CSS (both the sidebar block and the
  "I. ACTIVE NOW HORIZONTAL SCROLLER" block) was deleted from `dashboard.css`.
  The `.active-now-dot` selector was dropped from the shared
  `.online-dot, .chat-status-dot.online` pulse rule (those two stay). Online
  status is still surfaced via the chat-list green dots + the chat-header
  "last seen" line only.
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


## Message pagination (`loadMessages` + scroll-up paging)
- A chat opens with only the newest **12 messages per direction** (`MSG_PAGE_SIZE`), via `.orderBy("createdAt","desc").limit(12)` on the two per-chat listeners. Older history loads in **25-message** chunks (`MSG_OLDER_PAGE_SIZE`) when the user scrolls within 80px of the top (`maybeLoadOlderMessages` → `loadOlderMessages`, with a `.older-msgs-loading` pill + scroll-position preservation).
- **Composite index REQUIRED**: `chats (from, to, createdAt DESC)` — defined in `firestore.indexes.json` (also covers the pre-existing `from/to + createdAt` indexes used by `loadInitialChatTimestamps`; deploying indexes DELETES any not listed). Deploy with `firebase deploy --only firestore` (rules + indexes).
- **Sliding-window continuity:** the live window slides as new messages arrive. `retainSlidOut()` moves ejected messages into `_olderMsgsA/B` so no gap forms, and `recordSeam()` detects BULK slides (window's previous newest < new window's oldest → messages between never appeared in any snapshot) and records a seam range that gets healed lazily on scroll-up via `startAfter/endBefore` fetch. Do NOT remove either — removing them makes mid-history messages silently vanish in active chats.
- Older pages live in `_olderMsgsA/B` (NOT `_msgsA/B`, which the live listener replaces wholesale). `renderMessageList` merges all four and DEDUPES by id (a seam-healed message can later slide back into the window).
- Features that now must account for unloaded history: `clearChat` (deletes the WHOLE conversation via full-conversation queries, batched ≤400/batch — BOTH sides' messages, since the `chats` delete rule is `isParty`, so Clear is a true WhatsApp two-sided wipe — plus the local `_olderMsgsA/B`), message search (full-history fetch cached 60s per chat + 250ms debounce), `scrollToMsg` (pages older chunks until the target renders), `saveEditMessage`/`deleteMsg` (patch older pages locally since they aren't live-listened).
- Remote deletes of messages that only live in `_olderMsgs` are NOT live-propagated (ghost until chat re-open) — accepted tradeoff to keep the listener windowed.
- **Older-page cursor MUST be `startAfter(oldestA)`, NOT `endBefore`** (the "show older messages stopped working" bug). The page query is `orderBy("createdAt","desc").startAfter(msgPaging.oldestA).limit(25)`. Firestore cursor semantics are relative to the QUERY ordering: on a DESC query `endBefore(X)` returns docs that sort BEFORE X = **NEWER** messages, i.e. exactly the ones already in the live window — every older-page fetch got deduped to nothing, `oldestA` never advanced, and history falsely appeared exhausted. `startAfter` returns docs AFTER the cursor in DESC order = genuinely older. The seam-heal query IS correctly an ASC query (`orderBy("createdAt","asc").startAfter(range.after).endBefore(range.before)` — after=older ts, before=newer ts) — do NOT "fix" the seam query to match.
- `autoSaveMedia` caches the parsed `nexa_autosaved_media` localStorage map in memory (`_autoSavedMediaCache`) instead of re-parsing per media message per render; the map is capped at 500 entries.

## Admin backend (`server/admin-api.js`)
- The hardened Firestore rules forbid browser-side edit/ban/delete of OTHER users' `users` docs (update is owner-only, delete is `if false`). `admin.html` therefore routes Edit/Ban/Delete through an Express backend using the Firebase Admin SDK: `POST /api/admin/edit-user`, `/api/admin/ban-user`, `/api/admin/delete-user`.
- **Champions/Top-20 message counts come from the backend, NOT the browser.** `admin.html` signs in ANONYMOUSLY, so the `chats` read rule (`from == auth.uid || to == auth.uid`) denies reading other people's messages — a client-side scan can never count them. The old client scan was also removed for cost. So `GET /api/admin/weekly-activity?weekStart=<ms>` (Admin SDK, X-Admin-Secret) scans `chats` + `status` and returns `{messages, stories, totals}` per uid; `loadWeeklyActivity()` (admin.html) fetches it into `cachedMsgScores`/`cachedStoryScores` before `renderChampions()`. Pure `aggregateWeeklyActivity(chatDocs, statusDocs, weekStart)` (unit-tested) does the counting; `tsMs` tolerates number/Timestamp/string `createdAt`. If the endpoint 404s (not deployed to nexa-backend), the fetch is caught and the list degrades to stories + referrals only. `renderChampions()` ranks ALL users (no `activity > 0` hard filter — that made the list look empty before) by `msgs + stories + referrals`, top 20. `reloadWeeklyStats()` awaits `reloadAnalytics()` so Refresh pulls fresh numbers. **Deploy the backend `server/admin-api.js` to nexa-backend for message counts to appear.**
- Deploy it into the SAME backend the dashboard already uses for push notifications (`BACKEND_URL` = `https://nexa-backend-e6pq.onrender.com`, see dashboard.html). `admin.html` picks the same base via `ADMIN_API_BASE` (localhost:3000 in dev).
- Auth is a shared secret: every request must send header `X-Admin-Secret` matching the backend's `ADMIN_SECRET` env var, else 403. `admin.html` has an `ADMIN_SECRET` const that must be set to the same value (it's visible in page source — accepted since the page is admin-email-gated, but the backend copy stays in an env var, never in the repo).
- Backend env vars: `ADMIN_SECRET`, `ALLOWED_ORIGIN` (CORS), and either `GOOGLE_APPLICATION_CREDENTIALS` (local key file) or `FIREBASE_SERVICE_ACCOUNT` (whole JSON as env var, for Render). ban-user also disables the Firebase Auth account; delete-user removes users + presence docs and the Auth account.
- Run locally: `cd server && npm install && ADMIN_SECRET=... GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json npm start`.

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
- **Reply preview is clickable (jump-to-original):** the `.reply-quote` in
  `buildMessage` (1:1) and `buildGroupMessage` (groups) carries
  `reply-quote-clickable` + `data-reply-to` and an inline
  `onclick="scrollToMsg('<id>')"` / `onclick="scrollToGroupMsg('<id>')"`. The id is
  sanitized with `String(id).replace(/[^A-Za-z0-9_-]/g,"")` before interpolation
  (it's inside an inline handler, so a crafted doc id must not break out).
  `flashMsgEl(el)` does the shared scroll-to-centre + cyan flash. 1:1 paging is
  handled inside `scrollToMsg` (pages older chunks until it renders); groups
  render all loaded history, so `scrollToGroupMsg` is a straight lookup. Keep the
  quote clickable — do NOT revert to a plain non-interactive div.
- **Disappearing messages run on WhatsApp's rule: the countdown is anchored on
  the SEND time (`createdAt`), NOT on read.** `msgDisappearAt(msg, msLimit)` =
  `createdAt + msLimit` (Firestore `Timestamp.createdAt` handled via
  `toMillis()`); `isMsgExpired` compares against `Date.now()`. A message the
  recipient never opens STILL disappears after the duration — do NOT re-anchor on
  `readAt` (that "after reading" behaviour was the old, wrong model: it let a
  message linger until the peer opened the chat). Option set is WhatsApp's Off /
  24h / 7d / 90d; `parseDisappearingMs` still parses legacy `5m`/`1h`/`12h` so a
  saved setting keeps working, but the picker no longer offers them.
- **Only NEW messages are affected — enabling a timer never nukes history.**
  `disappearingSettingsSince[key]` (mirrored from the settings doc's `updatedAt`,
  set to `Date.now()` on change) marks when the timer was turned on. In
  `renderMessageList`, any message whose `createdAt` is BEFORE `since` is kept
  unconditionally; only messages sent after are subject to `isMsgExpired`.
  WhatsApp has the same "existing messages are unaffected" rule. A legacy
  settings doc with no `updatedAt` is treated as "on from now" (first sighting)
  so it can't retroactively delete everything.
- **Both sides' expired docs are purged.** The filter pushes every expired
  non-`temp_` id (own AND the peer's) to `expiredDocIds`, because the `chats`
  delete rule now allows EITHER party (`isParty(resource.data)`). WhatsApp
  removes the message from both devices; with the old sender-only rule the peer's
  copy stayed and reappeared. Keep the `temp_` guard — an optimistic temp
  message has no Firestore doc to delete.
- **`startDisappearSweep()`** (30s `setInterval`, started at boot after
  `setupHeartbeat()`) re-renders only when a message in the open 1:1 chat has
  actually elapsed, so bubbles vanish while the chat sits idle instead of
  lingering until the next open. It no-ops when the timer is Off or the mode
  isn't `direct`, and is idempotent (single `disappearSweepInterval`).
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
  header ℹ button) now starts with a contact profile header
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
- **THE BACKEND MUST SEND DATA-ONLY (`nexa-backend/server.js`, `buildFCMPayload`).** A top-level `notification` (or `webpush.notification`) payload is a DISPLAY_NOTIFICATION: the FCM SDK's own `push` listener auto-calls `showNotification` **in addition to** the SW's custom push handler → **TWO notifications per message**. Emulator/sim-verified with the real `firebase-messaging-compat@10.7.1`: a notification payload = 2 `showNotification` calls, data-only = 1. Do NOT re-add `notification`/`webpush.notification` to the backend payload. It also runs on iOS (APNs `aps.alert`) and native Android — `notification` breaks the "SW owns the notification" design there too.
- **The backend's data `tag` must stay EMPTY for messages** — only calls get the fixed `nexa-incoming-call`. A hardcoded per-message tag (e.g. `nexa-push-<Date.now()>`) defeats the SW's stable tag, so the same message delivered to several of a user's tokens stacks instead of collapsing.
- The receiver's service worker (`firebase-messaging-sw.js`) registers ONLY the native `push` event listener and calls `showNotification` exactly once. It also early-returns on any `payload.notification` (defense-in-depth against a foreign sender). Do NOT re-add `messaging.onBackgroundMessage(...)` — it wraps the same push event and produces a 2nd notification for the same message (the "2-3 notifications per message" bug).
- Notifications use a **stable `tag`** derived from `data.messageId` (`nexa-msg-<messageId>`), so if the backend delivers the same message to several of the user's FCM tokens, the OS collapses them into a single notification instead of stacking.
- **Android APK caveat:** the APK (`SFWebSolution/nexa-andriod`) is a native WebView shell with NO Firebase/FCM code. Android WebView does not support the Web Push/Push API at all, so **web push cannot work in the APK** (closed, background, or even open) — it only works in the browser/PWA. Fixing it requires native `firebase-messaging` + a `FirebaseMessagingService` + `google-services.json` in that repo, not a web change.
- `sendPushNotification(title, body, target, extraData)` generates `notifId` and sends it as `data.messageId` to the backend; pass `extraData.messageId` to reuse an existing id. Calls use the fixed tag `nexa-incoming-call`.
- Foreground handler (`messaging.onMessage` in `initFCM`) shows an in-app toast always, but shows a SYSTEM notification only when the relevant chat is NOT already open & focused (`sameChatOpen` guard on `selectedUser.uid` + `visibilityState` + `document.hasFocus()`), avoiding toast+system duplicates while reading. It reuses the same stable `tag` as the SW.

## Notification History (app-main.js + dashboard.html/dashboard.css)
- Stored per-user in Firestore `notifHistory/{uid}` as `{items:[], updatedAt, lastViewedAt}` (`recordNotificationHistory`, capped at `NEXA_NOTIF_HISTORY_MAX`=50 items).
- Entry lives ONLY in **Settings** (row uses `.notif-item-count` badge `#notifHistoryCount` + `openNotificationHistory()`), NOT in Profile — do NOT re-add a Profile button.
- **Badge shows UNREAD count**, not total: `updateNotificationHistoryBadge()` filters `items` by `at > lastViewedAt`; docs written before `lastViewedAt` existed default the view time to 0, so pre-existing history reads as unread until first viewed.
- **Opening the history STAMPS `lastViewedAt: Date.now()`** (merge write) and then refreshes the badge, so viewing clears the unread badge. `renderSettingsTab()` calls `updateNotificationHistoryBadge()`; `renderProfileTab()` must NOT.
- **Clear history** = `clearNotificationHistory(btn)` (two-step confirm: first tap arms "Sure?", second tap wipes). Writes `{items: [], lastViewedAt: now}` with merge, swaps the list to the `nhEmptyStateHtml()` empty state, refreshes badge. Clear button lives in the modal header (`.nh-clear-btn`).
- Retains the existing `.nh-item` list rendering (icon/title/body/`relTime(at)`) and `closeNotificationHistory()`.
- Remember: `dashboard.html`/`dashboard.css` are CRLF — preserve after editing.

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

## Composer "+" menu (WhatsApp-style) + Settings reorganization
- **Chat composer is mic-primary with everything else behind a `+` menu.** The
  mic (`#recordBtn`) stays permanently visible in `.input-wrap`; photos, files,
  polls and View Once live inside `#attachMenu`, opened by `#attachToggleBtn`
  (`toggleAttachMenu` / `closeAttachMenu` / `handleAttachMenuOutsideClick`).
  `toggleActionButtons()` no longer hides the whole row — it only refreshes the
  menu's stateful rows (poll visibility + the View Once check mark), because a
  hidden row would otherwise take the mic with it. Works in direct, group and
  channel chats; `updatePollButtonVisibility()` shows `#pollBtn` only for
  group/channel. Do NOT move the mic inside the menu.
- **Profile is no longer a tab.** `#tabPaneProfile` and its rail button are
  gone; the profile UI now lives in the Settings "Personal Info" sub-page
  (`openSettingsSubPage('personal')`). `switchTab('profile')` is kept as a
  defensive redirect to Settings→Personal (it has no callers). If you add
  profile fields, put them in `subpagePersonal`, not a resurrected tab.
- **Settings is a classified root list + sub-pages.** `#settingsRoot` lists 11
  categories (Personal Info, Privacy & Security, Account, Notifications,
  Appearance & Theme, Chat Wallpaper, Messages & Media, Invite Friends,
  AI Assistant, Storage & Cache, About Nexa); each row calls
  `openSettingsSubPage(<key>)` and `.settings-subpage[data-subpage=<key>]`
  renders it, with `closeSettingsSubPage()` / the `.settings-back-btn`
  returning to the root. The root list scrolls inside `.settings-scroll-area`
  (the content is taller than the pane — don't remove that scroller).
- **Personal Info body:** the sub-page body wraps the profile markup in ONE
  `.profile-tab-content`; `.settings-subpage-body > .profile-tab-content`
  resets its padding to 0 so it doesn't double-pad inside the sub-page shell.
  Don't nest a second `.profile-tab-content` (it doubles the padding and
  inflates the layout).

## Composer send button + input pill (do NOT regress)
- The send button (`#composerSendBtn .btn-send`) sets ONE token for both axes:
  `--composer-ctl` (44px), applied as width/height/min-width/min-height. It used
  to hardcode `width:44px; height:42px` with no `min-height`, so the 480px
  breakpoint and the theme blocks (which only override `height`) squashed it
  into a 44x42 OVAL. Never give it independent width/height values, and always
  set `min-height` alongside `height` on any future override.
- The pill is `min-height: var(--composer-ctl)` (44px) so the button bottom-aligns
  with it (`.input-area` is `align-items:flex-end`).
- `#text` has `rows="1"` and `height: var(--composer-line)` (22px). Without
  `rows`, a <textarea> defaults to TWO rows (~62px), which inflated the pill to
  ~76px at rest and made the 44px button read as small/unbalanced. The CSS
  height also matters because the send paths reset the box with
  `style.height = "auto"`, which then falls back to one line instead of two.
- `autoGrowComposer(ta)` (app-main.js) is the single grow path, used by the
  input listener and all three send paths (1:1 / group / channel). Do not
  revert to a bare `ta.style.height = "auto"` reset - that leaves the composer
  stuck at whatever height the inline style last had.

## APK (WebView) parity + smoothness (do NOT regress)
- **`html.nexa-native`** is added early in `dashboard.html`'s inline pre-paint
  script when the UA contains `NexaMobileNative` (set by the Android shell).
  `dashboard.css` has an ADDITIVE native-only block keyed on it: global
  `overscroll-behavior:none` (kills the WebView rubber-band "shake" on taps near
  edges), `backdrop-filter:none` on the modal overlays (per-surface blur is the
  biggest Android scroll/tap jank source), and snappier tap transitions. Keep it
  additive and native-only so the browser app is untouched. The APK must keep
  emitting the `NexaMobileNative/<version>` UA token or the class never applies.
- **`color-scheme` matters on Android.** `:root` (light) sets
  `color-scheme: light` and `:root[data-theme="nexa"]` sets `dark`. Without it the
  WebView renders native form-control text/caret dark even when our own color is
  light — that is why the Edit textarea looked black with invisible typed text.
- **Edit modal surface is tokenized** (`--bg-1` / `--bg-2` / `--text-0` /
  `caret-color: var(--primary)`), NOT the old hardcoded dark glass
  (`rgba(18,24,32,.97)`), so it is readable in both themes. Be wary of other
  hardcoded dark-modal surfaces when the user reports "black box" inputs.
- **`startEdit()` defers `focus()` ~320ms** (until the open animation settles)
  and then selects the end. Focusing mid-animation makes Android pop the keyboard
  during the transition, which fights the layout and reads as a jolt; it could
  also leave the field looking empty until the next repaint. Do NOT move focus
  back to synchronous.
- Viewport meta includes `interactive-widget=resizes-content` so the keyboard
  resizes the layout instead of scrolling the whole WebView.

## Recent UX fixes (do NOT regress)
- **Channel voice notes use the modern voice-note player.** `renderChannelPostsList`
  (app-main.js) renders `post.audio` through `renderVoiceNotePlayer(post.id, post.audio,
  post.duration || 0, false)` inside a `.channel-post-audio` wrapper — NOT a stock
  `<audio controls>` element. CSS `.channel-post-audio .nexa-vn-player { max-width:100%;
  width:100%; }` lets the player fill the post card (the base `.nexa-vn-player` caps at
  ~300px for chat bubbles). `post.duration` is in ms, same field the chat modes use.
- **Channel player must be MOUNTED as a real DOM node, never stringified**
  (the "channel voice note no day work / play dead" bug). `renderChannelPostsList`
  builds each card into a template string (`wrap.innerHTML`), and interpolating
  `renderVoiceNotePlayer(...)` via its `outerHTML` into that string DROPS every
  DOM event listener the player attaches (play/seek/speed/audio). Fix (current
  code): the audio branch emits a placeholder
  `<div class="channel-post-audio" data-vn-for="${post.id}" ...></div>`, and
  after `box.appendChild(wrap)` the loop does
  `slot.appendChild(renderVoiceNotePlayer(post.id, post.audio, post.duration||0, false))`
  so the node is appended live with listeners intact. Keep this mount step; do
  NOT go back to `vnHost.outerHTML` / innerHTML for the player.
- **Polls work in groups AND channels.** `updatePollButtonVisibility()` shows `#pollBtn`
  when `currentChatMode === 'channel' && selectedChannel || currentChatMode === 'group' &&
  selectedGroup` (previously channel-only, so groups never saw the button).
  `openPollModal()`'s gate allows `selectedChannel` too — before the fix it early-returned
  with "Select a chat or group..." whenever only a channel was open (the "asking me to
  select something" bug). Poll post/vote paths already supported all three modes
  (`submitPoll` → `sendGroupMessageWithExtras`/`sendChannelPostWithExtras`; `votePollOption`
  picks `channels`/`groups`/`chats` by `currentChatMode`).

## Voice note recording gotchas (dashboard.html, VOICE RECORDING section)
- The mic record button is PRESS-AND-HOLD (WhatsApp-style). The old code
  bound stop to GLOBAL `mouseup`/`touchend` listeners — those fired on ANY
  release anywhere on the page and silently cut recordings short (the
  "stops at ~30s on mobile" symptom, caused by stray touchends / browser
  gestures / context-menu hijacks during a long press). Stop is now bound
  to `pointerup`/`pointercancel`/`pointerleave` ON THE BUTTON ONLY, with
  `touch-action:none` + `user-select:none` to stop the browser stealing the
  long press. Do NOT re-introduce global mouseup/touchend stop listeners.
- **`#voicePanel` is now an INLINE bar (`.voice-bar`), NOT a full-screen
  overlay.** The composer capsule keeps its layout; the textarea collapses
  (`display:none`) and the bar slides into its place beside the mic. States
  are driven by ONE function, `setVoiceUI('idle'|'recording'|'preview')`
  (app-main.js), which toggles `.voice-active` on `.input-area`,
  `.voice-recording` on `#inputWrap`, and the bar/mic/discard/play/speed
  visibility. Do NOT go back to a `position:fixed; inset:0` overlay.
- **Hold-to-record release MUST be bound to the MIC (`#recordBtn`) as well as
  the bar.** The bar used to be a full-screen overlay that covered the record
  button, so the release landed on the overlay and a bar-only listener
  sufficed. Inline, the bar sits BESIDE the mic (bar ~x74–294, mic ~x301–337
  at 420px wide) so the two do NOT overlap — a bar-only listener means the
  release never reaches any handler, `stopRec()` never runs, the recorder
  stays `isRecording:true` forever and the clip is never held (the exact
  "sending, it is not sending" failure). Wire `pointerup`/`pointercancel` on
  `#recordBtn` AND keep them on `#voicePanel`, plus
  `recordBtn.setPointerCapture(e.pointerId)` in `pointerdown` and a
  `lostpointercapture` → `stopRec()` fallback so a finger drifting off the mic
  (or a cancelled touch) still ends the recording. Never move these to
  `document` (a global release truncates long recordings).
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


## Media viewer — download-first (WhatsApp-style) + view-once is never saved
- **Every photo/video/file opens in ONE viewer that downloads the media FULLY
  before showing it.** `openMediaViewer(url, kind, opts)` (`app-main.js`) shows
  a spinner, `await fetch(url, {mode:"cors", credentials:"omit"})` → `blob()`
  → `URL.createObjectURL`, and only then swaps in the real `<img>/<video>/<audio>`
  /save-link. Rendering the remote URL directly is what made media "open then
  stall / half-load / play choppy"; never go back to `<img src=remote>` /
  `<video src=remote>` for an opened item. Cloudinary (`res.cloudinary.com`)
  sends `Access-Control-Allow-Origin: *`, so the fetch works — a different host
  would need CORS.
- **Entry points:** `viewImg(url)` (images) and `viewVideo(url)` (videos) both
  call the viewer; inline video bubbles/grids/channel posts are now a
  control-less muted `<video preload="metadata">` POSTER (`.media-video-poster`)
  with a `.media-play-overlay` (inline SVG play glyph — NOT a `<i data-lucide>`,
  because these bubbles don't re-run `lucide.createIcons()`), and clicking the
  container opens the viewer. File attachments (`.file-attach`) carry
  `data-media-url` / `data-media-name` / `data-media-audio` and are handled by a
  SINGLE document-level click listener — never an inline `onclick`, because a
  filename containing a quote would break out of the attribute. Audio files get
  an inline player INSIDE the viewer (`isAudioFile`).
- **Blob cache:** `NEXA_MEDIA_BLOB_CACHE` (Map, cap `NEXA_MEDIA_BLOB_MAX`=60)
  makes re-opening instant with no network; `revokeOldMediaBlobs()` revokes the
  oldest on overflow. `mediaViewerToken` guards the async download so a slow
  fetch can't paint over a newer open. Keep both.
- **View-once is NEVER saved and never listed.** `openViewOnceModal` uses the
  same download-first path but with `fetchMediaBlobUrl(url, {noCache:true})` —
  the blob is NOT put in `NEXA_MEDIA_BLOB_CACHE`, and `releaseViewOnceBlob()`
  (called from `closeViewOnceModal()` AND the `visibilitychange` blank) revokes
  it, so the ephemeral media is gone from memory once dismissed. The viewer has
  NO download button by design. `loadMediaGrid()` filters `!m.isViewOnce`, so
  view-once media never appears in Chat Info → shared media. Do NOT add a
  download button to the view-once viewer or cache its blob.
- CSS lives in dashboard.css next to `.media-container`: `.media-video-poster`,
  `.media-play-overlay`, and the `.media-viewer-*` block (overlay z-10200, spinner
  with a `prefers-reduced-motion` guard). Channel posts need the extra
  `.channel-post-media.media-video-poster { position: relative; }` so the play
  overlay anchors correctly.

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


## Notifications master toggle (do NOT regress)
- Settings → Notifications has a master **All notifications** switch (`#tabNotifAll`,
  `toggleNotif('all')`) that flips EVERY category at once. The master ON means
  `NEXA_NOTIF_TYPES = ["messages","stories","calls","reactions"]` are all enabled;
  turning ANY one off drops the master to off (so it's a true reflection, not a
  separate flag). `setAllNotif(on)` / `isNotifAllOn()` own this.
- Settings UI has TWO id sets for the same toggles: the Settings **subpage**
  (`tabNotifMessages`/`tabNotifStories`/`tabNotifCalls`/`tabNotifReactions`) and the
  quick **modal** (`notifMessages`/`notifStories`/`notifCalls`/`notifReactions`).
  `updateNotifUI()` MUST sync BOTH sets (and the Reactions toggle — that was the
  unsynced one). Do NOT reintroduce a manual partial sync block; `loadNotificationSettings()`
  calls `updateNotifUI()` which is the single source of UI truth.
- `persistNotificationSettings()` writes `notificationSettings.all` alongside the
  per-type flags to localStorage (`notificationSettings`).

## APK / WebView theme flash (do NOT regress)
- The web app **defaults to a LIGHT theme** (`#EDF1F7` page background). The native
  APK (`SFWebSolution/nexa-andriod`, `MainActivity.java` + `res/values/{colors,themes}.xml`)
  used to hard-code a DARK window/WebView background (`#0B0F19`) → the first frame
  flashed dark then snapped to light (the "dark something skipping" bug). The native
  `window_background` is now the light default and `windowLightStatusBar`/
  `windowLightNavigationBar` are set; the WebView gets `forceDarkAllowed=false` and
  `FORCE_DARK_OFF` so Chromium never auto-darkens the light page.
- `dashboard.html` has a **pre-paint inline script** (right after the stylesheets,
  before `<body>`) that reads the saved theme from `localStorage.nexaPrefs` and sets
  `data-theme="nexa"` on `<html>` before the first frame — so a dark-theme user never
  flashes light either. `setTheme()` later re-applies the same value.
- `.nexa-splash` is **theme-aware** (uses `var(--bg-0)` + `--sp-*` tokens) with a
  dark override under `:root[data-theme="nexa"]`. Do NOT put a hard-coded dark
  gradient back on the base `.nexa-splash` — that reintroduces the light-user flash.
- `setTheme()` notifies the native shell via `window.NexaAndroid.setTheme(themeName)`
  (JS bridge `addJavascriptInterface(..., "NexaAndroid")`); MainActivity repaints
  window/status/nav bars live and persists the choice to SharedPreferences, re-applied
  in `onCreate` before the page loads (no flash on cold start for either theme).
  No-op in a normal browser.

## Recent modernization (2026-09)
- **Modern CSS layer (dashboard.css, dashboard.html, app-main.js, styles.css):** ADDITIVE "FLUID & MODERN 2026 POLISH" block appended to dashboard.css + a matching "MODERN POLISH — AUTH PAGES" block appended to styles.css (login/signup only; index/admin use their own styling). Dashboard polish uses @starting-style, clamp(), color-mix(), light-dark(), prefers-reduced-motion guard, ::selection, text-wrap: balance/pretty. Keep it additive — do NOT restyle the whole file.
- **Welcome popup (task 1):** Non-blocking re-engagement nudge. presence/{uid} lastSeen absence > RETURN_WELCOME_MIN_GAP_MS (2–3d) pops #welcomeBackModal (1200ms after load, once per RETURN_WELCOME_COOLDOWN_MS = 30d, mirrored in localStorage key nexa_return_welcome_seen storing epoch ms, no server writes))). "Invite friends" (returningWelcomeInvite) → getMyUsername() then copyReferralLink(. Markup at dashboard.html (~line 1084), JS at app-main.js (checkReturningUserWelcome, showReturningWelcome, dismissReturningWelcome), CSS in dashboard.css (welcome zone between "RETURNING-USER WELCOME" and "FLUID & MODERN"")). Do NOT delete interstitial </p> </div> closure lines in that zone — they're syntactic glue.
- **Icons:** lucide pinned @0.469.0 with jsDelivr UMD fallback (was @latest — drift risk). Un-icode modal close/back glyphs swapped to <i data-lucide> (x 14–20px, arrow-left 18–20px): story-close, notif-close x3(analytics, prompt-responses, notif-settings), status-modal-close x2(add-yours, status-share), modal-close(search), delete-chat-close, wallpaper-modal-close, askify-coming-close, welcome-back-close, info-back+info-close, profile-pic-back, user-profile-back, ai-back-btn, chat-back-btn, mc-icon-btn-back, view-once close(inline styles, font-size→<i>x> 20px). Ensure any NEW modal close/back uses <i data-lucide> + pinned loader, never raw ✕/←. (Story-close differs: no title attr — exact-string matches must be per-line.)
- **Toolchain quirk (critical for this repo):** heredocs + paren-dense python inline in terminal often get paren-dropped — author scripts via file_editor then run python3 script.py, never heredoc. Keep ONE action per line, use locals for nested prints (trailing ) corruption). Plain-ASCII marker )→() conversion + brace/paren audit scripts are the reliable authoring loop for CSS blocks. dashboard.html & dashboard.css use CRLF — preserve via the normalize step (python3 replace b'\r\n'→b'\n'→b'\r\n') after any file_editor edit or the whole file shows as changed in git diff.)


## One-time username change (Profile tab)
- Every user (with OR without a username) may set/change their `@username` EXACTLY ONCE.
  The `users/{uid}` doc flag `usernameChangeUsed: true` (written by `saveUsernameChange()` in
  app-main.js) is the single source of truth; the Profile-tab button `#changeUsernameBtn`
  shows only while the flag is absent (`refreshMyUsernameInfo()`). Do NOT let users change
  it again once set — removing the flag silently breaks the one-time guarantee.
- Uniqueness is enforced by a Firestore query `where("username","==",newUsername).limit(2)`
  (single-field equality -> auto index, no composite needed); usernames are stored lowercase.
  Format rule: `NEXA_USERNAME_RE = /^[a-z0-9_]{3,20}$/`. The users `update` rule is already
  owner-only, so NO firestore.rules change is needed.
- Modal markup is `#changeUsernameModal` (reuses `.notif-settings-overlay` / `#notif-hdr`
  patterns, z-9500); JS: `openChangeUsernameModal`, `closeChangeUsernameModal`,
  `handleChangeUsernameOverlayClick`, `saveUsernameChange`; CSS `.username-edit-btn`/`.cuu-*`
  in the PROFILE NOTE CSS zone of dashboard.css. Reads are one-off (modal open + save
  double-check), never listeners — keep it lean for the Spark quota.
## Starter tabs (bell + tray + drawer) — rule-safe design
- Starter tabs are PERSONAL (WhatsApp-style). The array lives ONLY on `users/{me}.starter` as `[{uid, t}]`;toggle/dismiss/cleanup write THE OWN DOC ONLY. Firestore rules make `users` updates owner-only — NEVER batch-write `users/{theirUid}` (the old "mirror on their side" design would be DENIED → "Couldn't update Starter”). No new collections or rule deploys needed.
- TTL: `NEXA_STARTER_TTL_MS` 24h;`getStarterTabsFromCache()` filters stale + garbage-collects on own doc (cheap,write-own-only。 `NEXA_STARTER_CAP` 4 most recent。
- Presence tri-state via `starterStatusFor(uid)` reusing the shared `userPresenceCache` + `isUserOnline()` freshness: online(green dot), today(yellow,and away(days label。 Tray/drawer/bell markup lives in `dashboard.html`;styles `.starter-*` / `.sd-action-*` in `dashboard.css`;boot call `loadStarterTray()` right after `checkReturningUserWelcome()`。
- Welcome popup logic verified headless in Node (stale-2.5d shows,30d cooldown,presence-fallback-to-last_login())` — 4/4 scenarios pass。



## Toolchain quirk: authoring `)` parens get dropped/corrupted when authoring long blocks
- Writing big JS/CSS blocks through the `file_editor` tool AND through heredoc-to-stdin repeatedly DROPS/converts `)` (plus `  ` / `,and `,1:` fragments(`. Node --check + brace/paren balance are the ground truth;comments containing parens also false-positive the paren count。
- RELIABLE LOOP: author with placeholder chars `«`/`»` for parens in temp file → convert via `python3 -c` single-line → per-line brace/paren audit via bash `grep -o '('`/`')'` counts (subprocess-heavy on >8k lines.）→ append binary CRLF-safe via `python3 -c` (check `b'\r\n' in base` first）. For small patches prefer surgical `sed` line-delete/replace or file_editor on short unique strings,then node --check。
- dashboard.css factual state: total parens are uneven ONLY inside comments(parser-fine);comment text with parens shifts the raw count — use brace balance(`{`==`}`) as the validity gate,not raw paren equalsofar。

## Connect tab — connection-gated 1:1 chat + stories
- New tab (after Stories) where ALL users appear; you send a Connect request and the recipient accepts before they show in the 1:1 Chats tab. Tab order: Chats · [voice] · Stories · Connect · Community · Settings.
- **Firestore `connections` collection**, one doc per pair, id = the two uids SORTED and joined with `_` (`connKey`). Fields `members:[uidA,uidB]`, `from`, `to`, `status:"pending"|"accepted"`, `createdAt`, `updatedAt`. Client listener is a SINGLE `where("members","array-contains",myUid).onSnapshot` (single-field auto-index, NO composite index) feeding global `myConnections` (otherUid -> record). Do NOT open a listener per contact.
- **`firestore.rules` `connections` block** (must be DEPLOYED): read = member only; create = `from==auth.uid`, `to` in `members`, `to!=from`, status pending|accepted; update = ONLY the recipient (`auth.uid == resource.data.to`) changing only `status`/`updatedAt` (members/from/to must be unchanged); delete = either member. `getConnectionWith(uid)`/`isConnectedTo(uid)` (accepted only) are the client helpers.
- **Auto-connect migration** (`maybeMigrateExistingChats`, one-time per uid via `nexa_conn_migrated_<uid>`): everyone you already exchanged a chat with is written as an `accepted` connection so existing conversations aren't lost. It SKIPS any uid already in `myConnections` (accepted OR pending) — overwriting an existing pending doc is DENIED by the rules. Runs from the connections listener so `myConnections` is populated first.
- **1:1 Chats tab is connection-gated:** `renderUsers()` filters to `isConnectedTo` + self-chat, and is a thin wrapper over `renderUserList(list)` (which owns the sort/self-pin/paint). Chats-tab search is scoped to connections via `renderSearchResults()`; global discovery lives in the Connect tab (`#connectSearch` -> `renderConnectDiscover`). The instant-paint fallback in dashboard.html also filters by cached `nexa_connections_<uid>` (accepted only) so there's no flash of non-connections.
- **Stories are connection-gated:** `renderStoriesBar`, `renderStoriesTab`, `updateStoryTabDot`, and `openStoryViewer` all skip non-connections (client-side; the `status` rules still allow any signed-in read — hardening the rules is a future option).
- **Connect tab UI** (`#tabPaneConnect`): segmented `Discover` | `Requests` (`switchConnectSubTab`), `renderConnectDiscover` (all users, action button per relationship: Connect / Requested / Accept / Message), `renderConnectRequests` (incoming + Sent section). Requests search box (`#connectSearchWrap`) is hidden on the Requests sub-tab.
- **Green update dot** (`.connect-tab-dot` on `sTabConnect` + `navBtnConnect`): `updateConnectTabDot()` shows it for a new incoming pending request or an accepted outgoing request newer than `nexa_connect_seen_<uid>`; opening the Connect tab (`switchTab('connect')` -> `markConnectRequestsSeen`) clears it.
- Actions: `sendConnectRequest` / `acceptConnectRequest` (recipient flips status) / `declineConnectRequest` / `cancelConnectRequest` / `disconnectUser` (both delete the doc) / `openConnectedChat(uid)` (switches to Chats and selects). Accept just shows the person in the 1:1 list — no auto-open.
- **Channels are NOT message-forward targets.** The Forward modal lists contacts (accepted connections) + groups only. A channel is a broadcast feed where only the owner/admins may post, so a follower must never be able to push a message into one. `renderForwardTargets` no longer adds `myChannels`, and `executeForward` skips a `channel` target (`continue`) instead of writing a `channels/{id}/posts` doc. Do NOT re-add channels to the forward list.
- **Every contact picker is connection-gated (not just chat/stories/Live).** Only ACCEPTED connections (`isConnectedTo`) may be picked for: message Forward targets (`renderForwardTargets`), the "Invite to Group"/"Invite to Channel" picker (same forward modal via `openInvitePicker`), Create-Group members (`renderCreateGroupContacts`), and Add-Member-to-Group (`renderAddMemberContacts`). `sendGroupInviteToChat`/`sendChannelInviteToChat` ALSO re-check `isConnectedTo(contactUid)` server-side and refuse with "You can only invite your connections". Do NOT re-widen any of these to `allUsersData` — a stranger must never be forwardable-to or invitable into a group/channel. The Voice Room/Live invite list is gated too (`renderUserInviteList` -> `isConnection`).
- dashboard.html & dashboard.css & app-main.js are CRLF — after editing run the normalize step or the whole file shows as changed.

## Channel feed auto-open + "2nd open shows nothing" fix (app-main.js)
- **The last opened channel auto-reopens on app open**, exactly like the last 1:1
  chat (`maybeReopenLastChat`). `selectChannelFeed()` stamps `nexa_last_open_channel_<uid>`
  (+ a `nexa_last_channel_ts_<uid>` timestamp); `maybeReopenLastChannel()` reads it and
  calls `selectChannelFeed()` with the matching entry from `myChannels`/`discoverChannels`.
- **Channels aren't loaded at boot**, so the boot call is a no-op on the first try. It is
  retried from `listenMyChannels()`'s snapshot (where `myChannels` is finally populated),
  and gated by `nexaChannelReopenChecked` so it runs **at most once per app open** — a
  later channels snapshot must never yank the user back into a feed they left. `selectChat()`
  also sets `nexaChannelReopenChecked = true` so opening a chat settles it.
- **Precedence vs the last chat:** both are "reopen" targets, so the more recent one wins.
  `setLastOpenChat()`/`setLastOpenChannel()` each write a `..._ts_<uid>` stamp;
  `lastOpenChannelIsNewer()` compares them. `maybeReopenLastChat()` bails (and un-checks the
  channel flag) when a channel is newer; `maybeReopenLastChannel()` bails when the chat is newer.
  Do NOT drop the timestamp compare or both would open on top of each other.
- **"Channel messages not showing (2nd open)" root cause:** `loadChannelPosts()` paints the
  "Loading broadcast posts…" placeholder, then its `onSnapshot` compares the fresh snapshot
  against `window._nexaChannelPostsCache`. Re-opening the SAME channel produced an identical
  snapshot → the reactions-only fast path `return`ed early **without rendering**, leaving the
  loading text stuck forever (and an empty channel did the same via `0 === 0`). Fix (current
  code): `loadChannelPosts()` resets `window._nexaChannelPostsCache = null` and stamps
  `window._nexaChannelPostsChannelId = channelId` on every open, the snapshot handler bails if
  that marker no longer matches (a slow snapshot from a channel you left), and the delta
  shortcut now requires `posts.length > 0`. The optimization still applies to genuine
  live reaction updates on an already-open channel. Do NOT remove the cache reset or the
  `posts.length > 0` guard.

## "Live" rooms — rename + connections-only gating
- The multi-user audio feature formerly called "Voice Room / Voice Chat" is now **"Live"** in all user-facing copy (room header, mini bar, invite modal, toasts, and the `index.html` marketing page). Internal identifiers are UNCHANGED and must stay: file `nexa-voice-room.js`, class `NexaVoiceRoomManager`, CSS `nexa-vr-*`, Firestore `voice_rooms` + `voice_invites`, the `?voiceroom=` URL param, and BroadcastChannel names. Renaming the URL param would break every shared join link.
- **Inviting AND joining are connections-only** (same gate as 1:1 chat + stories). `renderUserInviteList()` filters `getActualUsers()` through `this.isConnection(uid)`, `sendInvite()` refuses non-connections, and `canJoinRoom()` returns a reason string (`'ok' | 'no-connection' | 'not-invited' | 'no-room' | 'error'`) — a valid invite LINK no longer lets a non-connection in (the host still passes via `hostId === uid`). `joinRoom()` toasts "Connect with the host first…" for `no-connection`. Do NOT revert `canJoinRoom` to a boolean.
- `isConnection(uid)` (nexa-voice-room.js) prefers `window.isConnectedTo` and falls back to the cached `nexa_connections_<uid>` localStorage map, so gating works even if `app-main.js` hasn't finished loading.
- **Starting your own room is NOT gated** (it's your room); only inviting/joining is. There is no "Start a room" entry in the Connect tab by design.

## Live rooms — voice/video mode + camera (do NOT regress)
- A Live room is started in one of two modes, chosen via the **mode chooser popup** (`#nexaVrModeModal`) that appears EVERY time a `.start-voice-chat-btn` is tapped (the click handler calls `openModeChooser()`, NOT `startRoom()` directly). Voice = mic only, cap **10**; Video = camera + mic, cap **6**.
- `roomMode` ('voice' | 'video') is chosen at creation by the host and stored on the room doc as `mode`; joiners inherit it (`joinRoom` reads `roomData.mode`). There is no mid-room upgrade/downgrade. `isVideoRoom()` / `capForMode()` / `modeLabel()` are the helpers; `maxParticipants` is set from the cap on start/join.
- **Bandwidth, not code, is the video limit:** it is a P2P mesh, so each peer uploads its camera to every other peer (N−1 streams). 6 is the deliberate sweet spot (~1.6 Mbps up); do NOT raise the video cap without accounting for that.
- `initMicrophone()` captures `video: wantVideo ? {width:1280,height:720,frameRate:24,facingMode:'user'} : false` and **falls back to audio-only** (with a toast) if the camera is blocked/unavailable. Audio still runs through the same Web Audio DSP chain.
- `attachCallHandlers`'s `stream` handler calls BOTH `playRemoteAudioStream` (hidden `<audio>`) and `playRemoteVideoStream` (video tile). Remote streams are cached in `remoteStreams` keyed by **stable uid, NOT peerId** and **re-applied after every `updateUI()`** via `reapplyRemoteVideos()`. Two reasons: (1) `updateUI` rebuilds the grid's innerHTML, which recreates the `<video>` elements and drops their `srcObject`; (2) a peer can reconnect with a fallback id (`unavailable-id`), so a peerId-keyed tile would never receive the stream — **that is the "host can't see the joiners" bug** (the joiner, whose peerId is the stable one, sees the host fine). `playRemoteVideoStream` resolves peerId→uid via `peerIdToUid`, then a participant peerId scan, then falls back to the raw peerId; the participants `onSnapshot` migrates a stream parked under a raw peerId onto the uid once the mapping lands and re-attaches.
- **Video layout is a uniform tile wall, self included** (`renderVideoUI()`): the avatar stage (`#nexaVrStage`) is HIDDEN in video mode and the grid renders one `.nexa-vr-video-card` per participant — your own tile FIRST (id `nexaVrSelfVideo`, muted + mirrored, name "You"), then everyone else (`nexaVrRemoteVideo_<uid>`). Tiles are the same size, so it looks clean whether you're alone or with 5 others. There is NO separate stage self-view element (the old `#nexaVrLocalVideo` is gone — do not re-add it). A camera-off participant falls back to their avatar (`isCameraOn` synced to Firestore + carried in the participant map). The camera toggle (`#nexaVrCamBtn`, video rooms only) flips `isCameraOn` and disables the video track.
- `nexa-voice-room.css`: `.nexa-vr-grid-video` is `repeat(auto-fit, minmax(150px,1fr))` with 3/4 tiles; the ≤600px media query drops it to a **single column, 4/5 tiles, `max-height:58vh` scroll**, and shrinks the footer buttons to 44px so the tiles get the room on small phones (this is the "video looks bad on small phones" fix). Voice mode keeps the old auto-fill 130px grid + stage.

- `leaveRoom()` / `leaveRoomFromHostClose()` also remove `video[id^="nexaVrRemoteVideo_"]`, clear `remoteStreams`, and reset `roomMode`/`isCameraOn`/`maxParticipants` back to voice defaults.
- **Echo in Live rooms (both voice and video) — two independent causes, both fixed, do NOT regress:**
  1. **Remote video tiles MUST stay `muted`.** Remote audio is played ONLY through the hidden `audio[id^="audio_"]` element. If a remote `<video>` is left unmuted it also plays that stream's audio, so video rooms hear everything twice (sounds like echo). `videoTileHtml` hardcodes `muted` on every tile (self is muted too) and `playRemoteVideoStream` re-asserts `v.muted = true` defensively.
  2. **`initMicrophone()` must pass the Chromium `goog*` AEC flags**, not just the bare `echoCancellation:true`. The bare flag alone does not reliably engage Chromium's hardware echo canceller, so speaker output leaks back into the mic and callers hear themselves. The `audioConstraints` object now includes `googEchoCancellation`, `googEchoCancellation2`, `googNoiseSuppression`, `googAutoGainControl`, `googHighpassFilter` (same set as `NEXA_AUDIO_CONSTRAINTS` in app-main.js).

## PWA service worker caching (firebase-messaging-sw.js) — do NOT regress
- The service worker caches `dashboard.html`, `nexa-voice-room.js`/`.css`, `app-main.js` etc. If first-party JS/CSS is served Stale-While-Revalidate, **the first load after every deploy runs the PREVIOUS version** — so a pushed fix silently doesn't apply until a second reload (this is exactly why "the echo is still there" / "the layout is still broken" after a fix was deployed). First-party `.js`/`.css` are now NETWORK-FIRST (falling back to cache only when offline); HTML navigations were already network-first.
- `CACHE_NAME` must be BUMPED on each release (`nexa-v6-perf` → `nexa-v7-av`): `activate` deletes every cache whose name differs, so bumping purges the stale copy on existing devices. Do NOT leave the cache name unchanged across releases.
- When adding a new first-party script/style to the page, add it to `ASSETS_TO_CACHE` too (currently `nexa-voice-room.css` + `nexa-voice-room.js` are listed).

## Live video layout (nexa-voice-room.css) — do NOT regress
- Phones (≤600px) render the video grid as **2 columns** (`repeat(2,1fr)`, cards `aspect-ratio:3/4`, `gap:8px`) so several faces show at once instead of one giant tile with a long scroll. Landscape phones use `repeat(2,1fr)` with `16/10` cards.
- **`grid-auto-rows: max-content` + `align-content: start` are REQUIRED on `.nexa-vr-grid-video` when it has `max-height` + `overflow-y:auto`.** Without them a height-constrained grid squishes its rows to a fraction of the card height while `aspect-ratio` forces each card tall → **the cards overlap each other** (the "arrangement scattered" bug). Every row must be as tall as its card.

- Firestore needs NO rules change for video — the `voice_rooms` update rule only pins `hostId`, so the `mode` field and participant `isCameraOn` are allowed. `nexa-voice-room.css` holds `.nexa-vr-mode-*`, `.nexa-vr-local-video`, `.nexa-vr-video-card` styles.

## Boot progress bar (dashboard.html splash + app-main.js)
- The splash now carries a real 0→100% bar (`#nexaSplashProgress` / `#nexaSplashBarFill` / `#nexaSplashPct` / `#nexaSplashHold`) driven by `nexaBootStep(name)` in app-main.js. Milestones are WEIGHTED (`NEXA_BOOT_STEPS`: auth 15, profile 10, users 15, listeners 20, chats 20, community 15, paint 5) and idempotent; `nexaBootPaint()` only ever moves the bar FORWARD. `revealNexaApp()` fires exactly when the total hits 100 (the `paint` step) — the app is NOT revealed earlier. Do NOT revert to a fixed-timer bar — 100% must mean "ready".
- **100% is a PROMISE, and it is never faked.** 100% is only reached when EVERY milestone (including `users`) has actually completed — i.e. the user list is loaded and showing. There are two reveal paths and they are deliberately different: `nexaBootFinish()` (all milestones done → 100% → reveal) and `nexaBootRevealIncomplete()` (the safety timeout / first-run profile-setup path → reveals at the CURRENT held progress, **capped at 99**, leaving the bar short of 100). The old code called `nexaBootFinish()` from the 12s hard timeout and from the `profileSetupRequired` branch, which forced 100% for an app that wasn't loaded — that is the "splash hit 100% but no users were showing" bug. Do NOT reintroduce a `nexaBootPaint(100)` / `nexaBootFinish()` call on any path that isn't genuinely fully loaded. `nexaBootStep` routes `pct >= 100` through `nexaBootFinish()` so the hold label is cleared at the same time.
- While the bar is below 100%, `#nexaSplashHold` shows "Loading your chats and contacts…" so a slow load reads as progress, not a stuck screen; `nexaBootFinish()` clears it. CSS `.nexa-splash-hold` in dashboard.css.
- `nexaBootStep('users')` is fired from INSIDE the `users` onSnapshot (after `renderUsers()`), not at kick-off, so the bar reflects the real chat-list readiness. All boot globals (`_nexaBootDone`, `_nexaBootShownPct`, `_nexaSplashShown`) are `let`, so the boot functions must run before/with them (they live together near the reveal block, ~line 555).

## Story composer redesign (dashboard.html `.status-modal` + app-main.js + dashboard.css)
- The story composer (`#statusModalBox`) is now a **full-screen WhatsApp-style editor**: floating top bar (close / "New Story" / 😀 sticker button) over a tall editor canvas (`.status-preview-wrap`, flex-grow, `height:88vh` modal), with a bottom `.status-sheet` holding the tabs, music search, caption textarea and Cancel/Share. The empty state is `.status-empty-state` (`#statusEmptyState`), painted by `openStatusModal()` and replaced by `setStatusPreview(html)` on image/video preview. Preview media uses `object-fit: contain` (not `cover`) so nothing is cropped.
- **The caption and the interactive sticker are DRAGGABLE on the canvas** (`applyStoryDrag(el, posObj)` — pointer events + `setPointerCapture`, clamped 0.06–0.94). Positions are normalized 0..1 in `statusCaptionPos` / `statusStickerPos` and SAVED with the story: `statusData.captionPos = {x,y}` and `statusData.sticker.pos = {x,y}`. The VIEWER reads them (`story.captionPos`, `sk.pos`) with fallbacks to the old layout (`{0.5,0.78}` caption, `{0.5,0.5}` sticker), so legacy stories still render. `openStatusModal()` MUTATES the position objects in place (`statusCaptionPos.x = …`) rather than reassigning — the drag handlers hold a reference to them, so a reassignment would silently break dragging on the second open.
- `renderStatusCaption()` shows the caption overlay only when there's text AND `statusTab !== 'text'` (the plain text story renders its own full-bleed slide). It uses `linkify(val)` on RAW text — `linkify()` escapes internally, so wrapping it in `escapeHtml()` double-escapes.
- `#statusPreviewWrapHost` is the drag host (fallback: `#statusModalBox .status-preview-wrap`); `#statusModalBox .sticker-on-image` is `left/top`-positioned (the base rule's `bottom:14px` is overridden) and the composer's `.sticker-tool-btn` is `position:relative` inside the flex header (base rule is absolute top-right).

## Story posting progress (dashboard.html + app-main.js + dashboard.css)
- Posting a story now shows a real 0→100% ring (`#storyUploadOverlay` / `#storyUploadRingFill` / `#storyUploadPct` / `#storyUploadStage`) over the composer canvas, so the user never stares at a static "Sharing…" button. `setStoryUploadUI(active, pct, stage)` (app-main.js) drives it; the ring is an SVG circle with `stroke-dasharray: 326.7` (2π·52) and `stroke-dashoffset = CIRC * (1 - pct/100)`. `STORY_RING_CIRC` must stay in sync with the SVG `r="52"`.
- **`uploadFile(file, onProgress)` uses XHR, not fetch**, because only XHR exposes `upload.onprogress` for a real byte-level percentage. The signature is backward-compatible: the other 10 callers pass no callback and behave exactly as before. Do NOT revert it to `fetch` — that silently kills the progress bar.
- `shareStatus()` shows the overlay at 0, updates it from the upload callback ("Uploading photo/video…"), bumps to 92% ("Posting…") after the upload returns, 96% before the Firestore write, 100% ("Posted!") on success, then waits ~350ms so the ring visibly lands before `closeStatusModal()`. A `finally { setStoryUploadUI(false) }` hides it on every path, and the two early-validation returns (empty text, no song) also call `setStoryUploadUI(false)`. Story is only revealed at 100%.

## Story composer v2 — full-screen + one shared 9:16 frame (do NOT regress)
- The composer (`#statusModalBox`) is now TRUE full-screen on every device: `position:fixed` overlay with `padding:0`, box `width:100%; height:100dvh; max-height:100dvh; border-radius:0`, dark `#05070c` letterbox. It used to be a 430px phone-shaped card centred in a blurred backdrop, which looked broken on desktop.
- **The stage must NOT be capped.** `#statusModalBox .status-preview-wrap` is `flex:1 1 auto; min-height:0; max-height:none` (an older rule set `max-height:62vh` and left a dead strip under the canvas — the v2 block overrides it to `none`). The bottom sheet (`flex:0 0 auto`, `max-width:560px`, centred) takes only what it needs.
- **One 9:16 frame, shared by editor AND viewer.** Composer: `.status-story-frame` (`#statusStoryFrame`), sized by `sizeStoryFrame()` (JS picks the limiting dimension so the frame is as large as possible inside the stage, keeping 9/16). Viewer: `.story-viewer-frame`, created in `renderStorySlide()` and ALL viewer content (media, caption, sticker, text slide, music/prompt overlays) is appended to it, NOT to `#storyViewerContent` (which keeps its padding). Because both frames are the same 9:16 box, a caption/sticker dropped in the composer lands in the identical spot in the viewer — this was the "I move it and it appears somewhere else" bug (composer normalized to the canvas, viewer to the padded content area).
- **`applyStoryDrag` host = `#statusStoryFrame`** (fallback to the wrap). Positions are normalized to the frame; the clamp uses the element's OWN half-size (`offsetWidth/Height`) instead of the old flat 6%..94%, so wide sticker cards can be dropped near any edge without clipping. A gentle snap to the centre lines (within 5%) runs on release. `storyDragHintSeen` gates a one-time `.drag-hint` pulse on the caption/sticker.
- **Music is collapsed by default** behind `.status-music-toggle` (`toggleMusicPanel(force)`, `#musicToggleBtn` + `.media-controls.collapsed`), keeping the sheet short; `openStatusModal()` calls `toggleMusicPanel(false)` and sizes the frame in a `requestAnimationFrame` (clientHeight is 0 while the overlay is `display:none`). A `resize` listener re-sizes the frame while the composer is open.
- The plain **Text** tab keeps the textarea-as-story behaviour (no draggable caption overlay), so `updateStoryStickerPreview()` only re-renders the caption/sticker when `statusTab !== "text"`.
- Floating header + sticker tray are aligned to the same centred 560px column (`#statusModalBox .status-modal-header { max-width:560px; margin:0 auto }`; tray anchored via `right: calc(50% - 280px + 10px)` at ≥620px).

## Message translation (translate-on-receive) — app-main.js + dashboard.html
- **Model is translate-on-receive, NOT translate-on-send.** Each device translates whatever it DISPLAYS into its owner's chosen language (`getUserLang()`). So "every message I receive shows in my language and vice versa" falls out for free: my friend picking English is what makes MY messages appear in English on their screen. No message is ever mutated in Firestore, no recipient's language needs to be known, and groups/channels work identically. Do NOT switch to translating at send time (it would need a fan-out per recipient language in groups).
- **Languages are deliberately just two** — `NEXA_LANGS` = English (en) / Français (fr), default `en`. Settings → **Language** sub-page (`subpageLanguage`, opened via `openSettingsSubPage('language')`; the Preferences row uses the `languages` lucide icon). Add a language by appending to `NEXA_LANGS` + a `.lang-option` div — nothing else.
- **Prefs are device-local** (`nexa_translate_lang`, `nexa_translate_auto` (default ON), `nexa_translate_show_original`) like theme/wallpaper. No Firestore, no rules, no writes.
- **Engine:** `translateText(text, target, source)` → MyMemory free API, falling back to Google's public gtx endpoint (`translateViaGtx`). Both sit behind `translateText()`, so swapping in a paid Google/DeepL proxy later is a ONE-function change. `_enqueueTranslation`/`_pumpTranslateQueue` cap concurrency at 3 and `_translateInFlight` dedupes identical requests.
- **Caching:** every result is cached in memory + localStorage (`nexa_translate_cache`, capped at 400 entries, newest-wins) keyed `source|target|text`. A message is translated at most once per device; scrolling back is instant and free. `loadTranslateCache()` must run before any cache read.
- **Where the strip is injected (all three render paths):**
  - 1:1 → `buildMessage()`: `inner += maybeTranslationStrip(id, msg.text, fromMe)`.
  - group → `buildGroupMessage()`: same call (skip for polls).
  - channel → `renderChannelPostsList()`: `maybeTranslationStrip(post.id, post.text||'', false)` in the template string, then the mount step stamps `data-source-lang`/`data-target-lang` on the `[data-translation-for]` node and calls `requestTranslation()` (mirrors the voice-note placeholder/mount pattern — the strip is HTML-safe because the async patch only touches `.msg-translation-text`).
- **`maybeTranslationStrip(msgId, text, fromMe)` returns `''`** for your own messages, non-prose (URLs/numbers/emoji), same-language text, and unknown-language single tokens (a bare word is almost always a name). `detectLang()` is script-range based (ar/ru/ja/zh/ko/hi/he) + a stopword scorer for Latin (en vs fr) — deliberately conservative: it returns `''` when unsure rather than mislabeling.
- **Auto-translate OFF** (`nexa_translate_auto='0'`) suppresses *new* translations but still shows anything already cached, and the long-press **Translate** menu item (`translateMsg(id)`) always works as the manual escape hatch. That item is only added to the ENHANCED `showCtxMenu` (the one with Forward/Star), and only for `msg.text && !fromMe`.
- **Strip anatomy:** `.msg-translation[data-translation-for][data-translated]` → `.msg-translation-head` (names source→target + "Show original" toggle) + `.msg-translation-text` + `.msg-translation-original`. `patchTranslationStrip()` fills it in place when the async result lands (`requestTranslation`), and `removeTranslationStrip()` deletes the pending strip when the API returns nothing — the bubble is never re-rendered for a translation.
- **`setUserLang()` re-renders** the current 1:1 list, group list and channel cache so switching language repaints immediately. Anything calling it must be prepared for `renderMessageList()` to run.
- Verified: 40/40 Node logic tests (detection, gating, entity decoding, prefs, cache, strip decisions, escaping) + structural checks (no duplicate ids, wiring in all 3 paths, CSS classes, CRLF preserved). Note app-main.js is loaded as a CLASSIC script (`<script defer src>`), so every top-level function declaration (`translateMsg`, `selectLanguage`, `toggleAutoTranslate`, `toggleShowOriginalPref`, `updateLanguageUI`) is a real `window` global — which is what the inline `onclick` attributes in the ctx menu and the Language settings page rely on. Do NOT move the translation module inside the `(function(){...})()` IIFE (lines ~626-633) or those onclicks break.

## Askify AI — REVERTED to "Coming Soon" (do NOT re-add the in-chat version)
- The in-chat `@askify` assistant was **deliberately reverted**. Askify is a
  placeholder again: `openAI()` shows the **"Coming Soon" modal**
  (`#askifyComingModal` -> `openAskifyComingSoon`/`closeAskifyComing`/
  `handleAskifyComingClick`) and the `#aiPanel` iframe shell is back in
  `dashboard.html`. The CSP `frame-src https://askifyai.onrender.com` is back too.
- Removed for good: the `#askifyPopup` quick-action popup, the Askify row in
  `#mentionsPopup`, `insertAskifyMention`, `askifyQuickAction`,
  `handleAskifySend`, `buildAskifyContext`, `askifyReply*` bubble rendering,
  the "thinking" bubble, all `.askify-*` CSS, and `server/ai-api.js`. Do NOT
  reintroduce any of these without an explicit request.
- Reason it was reverted: the answer was posted into the chat thread (wrong UX —
  it should have been a small cancellable modal), and the live backend never had
  the `/api/ai/*` routes deployed, so `@askify` silently did nothing.

## Branded sidebar header + live edit/delete reflection (2026-10)
- **The sidebar `.top` header is now a branded app header, not a personal profile
  block.** `.nx-brand` holds the gradient **logo mark** (`.nx-brand-mark` with
  `.nx-brand-ring` pulse + `.nx-brand-core` "N"), the wordmark `.nx-brand-word`
  ("Nexa" + a pulsing green `.nx-brand-live` dot) and the tagline `.nx-brand-tag`
  ("Connect · Share · Live"). The old `.top-user-area` (your avatar + name +
  "Online") was REMOVED, and the redundant `.nx-brand-mobile` wordmark that used
  to sit inside `.sidebar-tab-switcher` was removed too (the real header shows on
  all widths now). CSS is appended at the end of `dashboard.css` (`.nx-brand*`,
  `@keyframes nxBrandPulse`/`nxBrandLive`, reduced-motion + 480px guards).
- **`#myPic` and `#myName` are KEPT in the DOM but hidden** (`style="display:none;"`)
  inside `.top`. They are read in ~15 places (`renderSettingsProfileCard`, message
  sender-name fallbacks, avatar sync, etc.) - never delete them, just leave them
  hidden. Do NOT re-add a clickable avatar to the sidebar header.
- **Edit now repaints in place.** `renderMessageList()`'s existing-bubble branch
  used to only refresh the timestamp/ticks/reactions, so an edited message kept
  its OLD text until the bubble was rebuilt (i.e. until you left and re-entered the
  chat). It now also swaps `.bubble > .msg-text` when
  `textEl.dataset.renderedText !== msg.text`; `buildMessage` stamps
  `data-rendered-text` on the `.msg-text` div so the comparison is reliable. Use
  the SAME `linkify(msg.text)` render path as build (do NOT add `renderMentionText`
  here). Poll bubbles are unaffected (no direct `.msg-text` child).
- **Delete is optimistic.** `purgeLocalMsg(id)` (app-main.js) splices the id out of
  ALL FOUR arrays (`_msgsA`, `_msgsB`, `_olderMsgsA`, `_olderMsgsB`) and removes the
  on-screen bubble, then `deleteMsg()` re-renders BEFORE firing the Firestore
  delete. Previously it waited on `.delete().then(...)` and only pruned the two
  `_olderMsgs*` arrays, so the message lingered until the chat was re-opened.
  `deleteGroupMsg()` splices `currentGroupMessages` + re-renders optimistically the
  same way. Do NOT revert to post-network pruning.

## Install the app + legal pages (2026-10)
- **The "Install" entry point is the Android APK, NOT a browser PWA install.** The app download lives at `https://nexa-install.onrender.com`. `index.html`'s download button is now an `<a href="https://nexa-install.onrender.com" id="installBtn">` (the old `installPWA()` / `beforeinstallprompt` / `deferredPrompt` flow is GONE — do NOT bring back a PWA-install prompt there). The dashboard adds an **"Install Nexa app"** row in Settings (root list, after Storage & Cache) and an "Install the Nexa app" action inside the About sub-page; both call `openInstallAppPage()` (app-main.js) which opens `NEXA_APP_INSTALL_URL`. Do NOT point these at the PWA/`beforeinstallprompt`.
- **Real legal pages exist**: `privacy.html`, `terms.html`, `cookies.html` (self-contained, dark-themed, matching the app; authored by `/tmp/gen_legal.py`). They are linked from `index.html` footer + FAQ, from `login.html` / `signup.html` footers (`.auth-legal` links), and from the dashboard's Settings → About sub-page via `openLegalPage('privacy'|'terms'|'cookies')` (app-main.js, opens `NEXA_LEGAL_PAGES`). Do NOT go back to `href="#"` placeholders for Privacy/Terms/Cookies. Contact email used on the pages: `neuro_stack@outlook.com`.
- **Firebase Hosting rewrite caveat:** `firebase.json` rewrites `**` → `/index.html`. Static files (`privacy.html`, etc.) are still served because Firebase checks for a matching file BEFORE applying the rewrite, but confirm after deploy that `https://<site>/privacy.html` returns the page and not the landing page.

## Smoothness pass (dashboard.css — "SMOOTH & EASY 2026")
- **The app had 100+ `backdrop-filter` blurs, including on the surfaces that are on screen and scrolling the whole time** (`.sidebar`, `.chat-header`, `.input-area`/`.input-wrap`, `.stories-bar`, `.search-wrap input`, `.mobile-bottom-nav`) and on **every received message bubble** (`.msg.them .bubble`) and reply quote. Each blur re-samples + blurs the page behind that element on every scroll frame — the single biggest cause of heavy/janky scrolling. The appended "SMOOTH & EASY 2026" block in dashboard.css turns the blur OFF on those persistent surfaces and gives them a clean solid surface (`var(--bg-1)`/`var(--bg-2)`) + soft elevation instead. Frosted glass is now reserved for TRANSIENT overlays (modals, sheets, toasts) where it actually reads as glass. Do NOT re-add `backdrop-filter` to the persistent chrome — if you want frost on a new overlay, that's fine, but not on the sidebar/header/composer/bubbles.
- **`.app { padding-bottom: 0 }`** — `.app` had a blanket `padding-bottom: 56px` left over from a legacy bottom nav, so on DESKTOP the composer floated ~56px above the viewport bottom. The real mobile nav is `.mobile-bottom-nav` (62px, inside the 768px media query, with its own reserved space). Verified at 390/1000/1920px: `.input-area` bottom == viewport bottom, no horizontal overflow. Do NOT reintroduce a blanket `.app` bottom padding.
- **Scroll hot paths**: dropped the permanent `will-change` on `.users`/`.messages`/`.user-item`/`.msg` (a no-op that can pin a layer all session), kept `transform: translateZ(0)`, and added `overscroll-behavior: contain` to `.users`/`.messages`/`.settings-scroll-area`/`.connect-view` + the `.tab-pane` scroller. `.user-item:hover` no longer nudges `translateX` (it's a calm tint), and the avatar no longer transitions (repaint on pointer move).
- **Tab switch**: `.tab-pane.active` gets a 220ms `nexaPaneIn` fade/slide (respects the global reduced-motion guard).
- **Reduced motion**: a global `@media (prefers-reduced-motion: reduce)` now neutralises animations/transitions app-wide.
- **Composer**: `#text { max-height: min(22vh, 140px) }` caps the auto-grow so the composer can't balloon on tiny screens.

## Splash boot gating + "new update available" prompt (do NOT regress)
- **The splash cannot reach 100% until the CONNECTIONS snapshot has landed.**
  `NEXA_BOOT_STEPS` has a dedicated `connections: 10` milestone (users/community
  were lowered to 10 to keep the total at 100) fired from `startConnectionsListener`'s
  first snapshot alongside `_connectionsLoaded = true`. Without this the dashboard
  revealed "ready" while `myConnections` was still empty, so `renderUsers()` painted
  "No users found" until the user reopened the app — the exact cold-start bug.
- **"Loading" must never read as "no connections".** `renderUsers()` computes
  `loading = list.length === 0 && !(allUsersData.length > 0 && _connectionsReady())`
  and passes it to `renderUserList(list, loading)`, which renders
  "⏳ Loading your chats…" instead of "👋 No users found" while either the users or
  the connections snapshot is still pending. The self-contact pins the list so the
  empty state usually only shows during a search — that's why the gate lives there.
- `_connectionsReady()` is a TDZ-safe wrapper around `let _connectionsLoaded`
  (a cached `renderUsers()` can run before the listener section executes). Read the
  flag through it, never directly.
- `renderConnectDiscover()` likewise shows "⏳ Loading users…" until `allUsersData`
  is populated, so the Connect tab doesn't flash "No users found" on the directory.
- `saveCachedUsers()` no longer bails on an empty list (the guard now only checks
  `currentUser`) so the inline instant-paint cache survives a momentary empty render.
- **App update prompt (persists until the user CLICKS Update now):**
  `NEXA_LATEST_APP_VERSION` in `app-main.js` (next to `NEXA_APP_VERSION`) is bumped
  on every release. While `isAppUpdatePending()` is true (running build < latest AND
  the user hasn't actioned it) the client keeps a green dot on the **Settings** menu
  item (desktop rail `settingsTabDotDesktop` + mobile `settingsTabDotMobile`,
  `.app-update-dot` in dashboard.css) AND re-shows `#appUpdateModal` on **every app
  open**. The reminder is cleared ONLY by `updateAppNow()` ("Update now"), which
  writes `nexa_update_resolved_<uid>` and opens `NEXA_APP_INSTALL_URL` (the APK
  install page). `dismissAppUpdate()` ("Later"/close) merely hides the modal for the
  current session — it does NOT record anything, so the prompt returns next open.
  There is deliberately **one** persisted key (`nexa_update_resolved_<uid>`); do NOT
  add a "seen/popup" key that hides the prompt indefinitely — the user wants the
  popup to stay until they actually tap Update now.
- Boot call site: `checkAppUpdate()` runs right after `checkReturningUserWelcome()`
  in the ready branch of `auth.onAuthStateChanged`. The modal is `.app-update-overlay`
  (z-index 11000, same band as the welcome modal).
