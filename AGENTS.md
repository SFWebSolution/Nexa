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

## Gotchas
- `firebase.js` and the inline config in `dashboard.html`/`admin.html` duplicate the Firebase config — keep them in sync.
- Firestore security rules must allow the `voice_rooms` / `voice_rooms/{id}/participants` / `voice_invites` / `calls` collections for this to work cross-device.

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

