/**
 * NEXA MULTI-USER VOICE CHAT SYSTEM v5.2 (REAL USERS & FIRESTORE WEBRTC INTEGRATION)
 * Multi-User Voice Chat connecting actual registered Nexa accounts.
 * Features: Real Firestore user database integration, WebRTC Audio Mesh with PeerJS,
 * Web Audio API Studio DSP, Minimized Floating Bar, Speaking Wave Rings & Live Invites.
 */

(function () {
  'use strict';

  class NexaVoiceRoomManager {
    constructor() {
      this.activeRoom = null; // { id, title, hostId, hostName, isHost, startTime }
      this.participants = new Map(); // id -> { id, name, avatar, isHost, isMuted, isSpeaking, handRaised }
      this.localStream = null;
      this.audioCtx = null;
      this.analyser = null;
      this.micGainNode = null;
      this.peer = null;
      this.peerCalls = new Map(); // peerId -> MediaConnection
      this.isMuted = false;
      this.isSpeakerMuted = false;
      this.isMinimized = false;
      this.timerInterval = null;
      this.vadInterval = null;
      this.roomFirestoreUnsub = null;
      this.roomChatUnsub = null;

      // Maximum participants per voice room (mesh audio — 10 keeps it stable).
      this.maxParticipants = 10;

      // Broadcast channel for multi-tab / local client signaling
      this.channel = new BroadcastChannel('nexa_voice_room_channel');
      
      this.init();
    }

    init() {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.setup());
      } else {
        this.setup();
      }
    }

    setup() {
      this.injectUIComponents();
      this.attachEventListeners();
      this.setupChannelListeners();
      
      // Delay Firestore listener setup slightly to ensure Firebase is fully loaded
      setTimeout(() => {
        this.setupFirestoreListeners();
        this.checkVoiceroomUrlParam();
      }, 1000);
    }

    // Auto-join a room from a ?voiceroom=<roomId> invite link. Waits for the
    // Firebase auth session + the room doc to exist before joining.
    checkVoiceroomUrlParam() {
      try {
        const params = new URLSearchParams(window.location.search);
        const roomId = params.get('voiceroom');
        if (!roomId || !window.db) return;
        console.log('[VoiceRoom] Auto-join from URL param:', roomId);

        const tryJoin = (attemptsLeft) => {
          if (!window.currentUser) {
            if (attemptsLeft > 0) setTimeout(() => tryJoin(attemptsLeft - 1), 800);
            return;
          }
          window.db.collection('voice_rooms').doc(roomId).get().then(doc => {
            if (!doc.exists) {
              if (attemptsLeft > 0) setTimeout(() => tryJoin(attemptsLeft - 1), 1000);
              return;
            }
            const data = doc.data() || {};
            if (this.activeRoom && this.activeRoom.id === roomId) return; // already in
            this.joinRoom({
              id: roomId,
              title: data.title || 'Voice Room',
              hostId: data.hostId,
              hostName: data.hostName,
              startTime: data.startTime || data.updatedAt || Date.now()
            });
          }).catch(() => {
            if (attemptsLeft > 0) setTimeout(() => tryJoin(attemptsLeft - 1), 1000);
          });
        };
        tryJoin(15);
      } catch (e) {
        console.warn('[VoiceRoom] URL param parse error:', e);
      }
    }

    getCurrentUser() {
      let uid = 'user_' + Math.random().toString(36).substr(2, 9);
      let name = 'You';
      let avatar = 'icon-192.png';

      // 1. Check window.currentUser in Nexa
      if (window.currentUser) {
        if (window.currentUser.uid) uid = window.currentUser.uid;
        if (window.currentUser.displayName && window.currentUser.displayName !== "User") {
          name = window.currentUser.displayName;
        } else if (window.currentUser.email) {
          name = window.currentUser.email.split('@')[0];
        }
        if (window.currentUser.photoURL || window.currentUser.photo) {
          avatar = window.currentUser.photoURL || window.currentUser.photo;
        }
      } else {
        // 2. Fallback to stored user in localStorage
        try {
          const savedUser = JSON.parse(localStorage.getItem('nexa_user') || localStorage.getItem('user') || '{}');
          if (savedUser.uid) uid = savedUser.uid;
          if (savedUser.displayName || savedUser.name) name = savedUser.displayName || savedUser.name;
          if (savedUser.photoURL || savedUser.avatar) avatar = savedUser.photoURL || savedUser.avatar;
        } catch (e) {
          console.warn('[VoiceRoom] Profile storage parse error:', e);
        }
      }

      return { id: uid, name: name, avatar: avatar };
    }

    getActualUsers() {
      // 1. Try window.allUsersData (loaded live by Nexa app in dashboard.html)
      if (window.allUsersData && Array.isArray(window.allUsersData) && window.allUsersData.length > 0) {
        return window.allUsersData.map(u => ({
          id: u.uid || u.id,
          name: u.displayName || u.name || (u.email ? u.email.split('@')[0] : 'Nexa User'),
          avatar: u.photo || u.photoURL || 'icon-192.png',
          email: u.email || '',
          isOnline: u.online !== false
        }));
      }

      // 2. Fall back to cached user array in localStorage
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('nexa_cached_users_')) {
            const cached = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(cached) && cached.length > 0) {
              return cached.map(u => ({
                id: u.uid || u.id,
                name: u.displayName || u.name || (u.email ? u.email.split('@')[0] : 'Nexa User'),
                avatar: u.photo || u.photoURL || 'icon-192.png',
                email: u.email || '',
                isOnline: true
              }));
            }
          }
        }
      } catch (e) {}

      return [];
    }

    /* --------------------------------------------------------------------- */
    /* 1. DOM INJECTION FOR VOICE ROOM OVERLAYS                              */
    /* --------------------------------------------------------------------- */

    injectUIComponents() {
      if (document.getElementById('nexaVrOverlay')) return;

      const user = this.getCurrentUser();

      // Expanded Overlay Modal
      const overlay = document.createElement('div');
      overlay.id = 'nexaVrOverlay';
      overlay.className = 'nexa-vr-overlay';
      overlay.innerHTML = `
        <div class="nexa-vr-container">
          <!-- Header -->
          <div class="nexa-vr-header">
            <div class="nexa-vr-header-info">
              <div class="nexa-vr-header-icon">🎙️</div>
              <div>
                <h3 class="nexa-vr-title" id="nexaVrTitle">
                  Voice Chat
                  <span class="nexa-vr-status-badge" id="nexaVrCountBadge">1 Connected</span>
                </h3>
                <div class="nexa-vr-subtitle" id="nexaVrSubtitle">Started by Host • 00:00</div>
              </div>
            </div>
            <div class="nexa-vr-header-actions">
              <button class="nexa-vr-hdr-btn invite-btn" id="nexaVrHdrInviteBtn">
                <span>➕ Invite Users</span>
              </button>
              <button class="nexa-vr-hdr-btn" id="nexaVrMinimizeBtn" title="Minimize Voice Chat">
                <span>🗕</span>
              </button>
              <button class="nexa-vr-hdr-btn close-btn" id="nexaVrCloseOverlayBtn" title="Hide Overlay">
                ✕
              </button>
            </div>
          </div>

          <!-- Body -->
          <div class="nexa-vr-body">
            <!-- Active Speaker Stage -->
            <div class="nexa-vr-active-stage" id="nexaVrStage">
              <div class="nexa-vr-avatar-wrap" id="nexaVrMainAvatarWrap" data-speaking="false">
                <div class="nexa-vr-avatar-ring"></div>
                <img src="${user.avatar}" alt="Main Speaker" class="nexa-vr-main-avatar" id="nexaVrMainAvatar" onerror="this.src='icon-192.png'">
              </div>
              <div class="nexa-vr-speaker-name" id="nexaVrMainSpeakerName">${this.escapeHTML(user.name)}</div>
              <div class="nexa-vr-speaker-status" id="nexaVrMainSpeakerStatus">
                <span>🎙️ Tap to speak</span>
              </div>
              <!-- Waveform Visualizer -->
              <div class="nexa-vr-wave-visualizer" id="nexaVrWaveVisualizer">
                <div class="nexa-vr-vbar"></div><div class="nexa-vr-vbar"></div><div class="nexa-vr-vbar"></div>
                <div class="nexa-vr-vbar"></div><div class="nexa-vr-vbar"></div><div class="nexa-vr-vbar"></div>
                <div class="nexa-vr-vbar"></div><div class="nexa-vr-vbar"></div><div class="nexa-vr-vbar"></div>
                <div class="nexa-vr-vbar"></div><div class="nexa-vr-vbar"></div><div class="nexa-vr-vbar"></div>
              </div>
            </div>

            <!-- Participant Grid -->
            <div class="nexa-vr-grid-header">
              <div class="nexa-vr-grid-title">Voice Chat Participants</div>
            </div>
            <div class="nexa-vr-grid" id="nexaVrParticipantGrid">
              <!-- Cards dynamically rendered -->
            </div>

            <!-- In-room text chat -->
            <div class="nexa-vr-chat-section">
              <div class="nexa-vr-chat-header">
                <span>💬 Room Chat</span>
                <button class="nexa-vr-chat-toggle" id="nexaVrChatToggle" title="Collapse / expand chat">▾</button>
              </div>
              <div class="nexa-vr-chat-body" id="nexaVrChatBody">
                <div class="nexa-vr-chat-messages" id="nexaVrChatMessages"></div>
                <div class="nexa-vr-chat-input-row">
                  <input type="text" id="nexaVrChatInput" class="nexa-vr-chat-input" placeholder="Message everyone in the room…" maxlength="500" autocomplete="off">
                  <button class="nexa-vr-chat-send" id="nexaVrChatSendBtn" title="Send">➤</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer Control Bar -->
          <div class="nexa-vr-footer">
            <button class="nexa-vr-ctrl-btn active-mic" id="nexaVrMicBtn" title="Toggle Mic (Mute/Unmute)">
              🎙️
            </button>
            <button class="nexa-vr-ctrl-btn" id="nexaVrSpeakerBtn" title="Toggle Speaker/Headphones">
              🔊
            </button>
            <button class="nexa-vr-ctrl-btn" id="nexaVrHandBtn" title="Raise Hand / React">
              🖐️
            </button>
            <button class="nexa-vr-ctrl-btn" id="nexaVrFooterInviteBtn" title="Invite Friends">
              👥
            </button>
            <button class="nexa-vr-ctrl-btn end-call" id="nexaVrEndBtn" title="Leave Voice Chat">
              📞
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      // Minimized Floating Bar
      const miniBar = document.createElement('div');
      miniBar.id = 'nexaVrMiniBar';
      miniBar.className = 'nexa-vr-mini-bar';
      miniBar.style.display = 'none';
      miniBar.innerHTML = `
        <div class="nexa-vr-mini-live">
          <div class="nexa-vr-live-dot"></div>
          <span>VOICE CHAT</span>
        </div>
        <div class="nexa-vr-mini-avatars" id="nexaVrMiniAvatars">
          <img src="${user.avatar}" class="nexa-vr-mini-avatar" onerror="this.src='icon-192.png'">
        </div>
        <div class="nexa-vr-mini-title" id="nexaVrMiniTitle">Voice Room</div>
        <div class="nexa-vr-mini-speaker">
          <div class="nexa-vr-mini-speaker-bar"></div>
          <div class="nexa-vr-mini-speaker-bar"></div>
          <div class="nexa-vr-mini-speaker-bar"></div>
        </div>
        <div class="nexa-vr-mini-actions">
          <button class="nexa-vr-mini-btn" id="nexaVrMiniMicBtn" title="Mute/Unmute">🎙️</button>
          <button class="nexa-vr-mini-btn" id="nexaVrMiniExpandBtn" title="Expand Voice Chat">⛶</button>
          <button class="nexa-vr-mini-btn danger" id="nexaVrMiniLeaveBtn" title="Leave Chat">✕</button>
        </div>
      `;
      document.body.appendChild(miniBar);

      // Invite Modal
      const inviteModal = document.createElement('div');
      inviteModal.id = 'nexaVrInviteModal';
      inviteModal.className = 'nexa-vr-modal-overlay';
      inviteModal.innerHTML = `
        <div class="nexa-vr-modal-card">
          <div class="nexa-vr-modal-hdr">
            <h4 class="nexa-vr-modal-title">Invite Nexa Users to Voice Chat</h4>
            <button class="nexa-vr-hdr-btn close-btn" id="nexaVrCloseInviteBtn">✕</button>
          </div>
          <input type="text" class="nexa-vr-search-box" id="nexaVrUserSearch" placeholder="Search actual Nexa users...">
          <div style="margin-bottom: 14px; text-align: center;">
            <button class="nexa-vr-hdr-btn invite-btn" id="nexaVrCopyLinkBtn" style="width: 100%; justify-content: center;">
              📋 Copy Instant Join Link
            </button>
          </div>
          <div class="nexa-vr-user-list" id="nexaVrUserList">
            <!-- User list entries dynamically loaded from Firestore / App users -->
          </div>
        </div>
      `;
      document.body.appendChild(inviteModal);

      // Incoming Call Toast
      const incToast = document.createElement('div');
      incToast.id = 'nexaVrIncomingToast';
      incToast.className = 'nexa-vr-incoming-toast';
      incToast.innerHTML = `
        <div class="nexa-vr-inc-details">
          <img src="icon-192.png" class="nexa-vr-inc-avatar" id="nexaVrIncAvatar" onerror="this.src='icon-192.png'">
          <div>
            <div class="nexa-vr-inc-title" id="nexaVrIncTitle">Voice Chat Invitation</div>
            <div class="nexa-vr-inc-sub" id="nexaVrIncSub">Invited you to join Voice Chat</div>
          </div>
        </div>
        <div class="nexa-vr-inc-actions">
          <button class="nexa-vr-inc-btn join" id="nexaVrIncJoinBtn">Join</button>
          <button class="nexa-vr-inc-btn decline" id="nexaVrIncDeclineBtn">Decline</button>
        </div>
      `;
      document.body.appendChild(incToast);
    }

    /* --------------------------------------------------------------------- */
    /* 2. EVENT LISTENERS & USER CONTROLS                                    */
    /* --------------------------------------------------------------------- */

    attachEventListeners() {
      // Header & Overlay actions
      document.getElementById('nexaVrMinimizeBtn')?.addEventListener('click', () => this.minimizeOverlay());
      document.getElementById('nexaVrCloseOverlayBtn')?.addEventListener('click', () => this.minimizeOverlay());
      document.getElementById('nexaVrMiniExpandBtn')?.addEventListener('click', () => this.expandOverlay());
      document.getElementById('nexaVrMiniBar')?.addEventListener('click', (e) => {
        if (!e.target.closest('.nexa-vr-mini-btn')) this.expandOverlay();
      });

      // Mic buttons
      document.getElementById('nexaVrMicBtn')?.addEventListener('click', () => this.toggleMic());
      document.getElementById('nexaVrMiniMicBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMic();
      });

      // Speaker & Hand
      document.getElementById('nexaVrSpeakerBtn')?.addEventListener('click', () => this.toggleSpeaker());
      document.getElementById('nexaVrHandBtn')?.addEventListener('click', () => this.raiseHand());

      // Invite buttons
      document.getElementById('nexaVrHdrInviteBtn')?.addEventListener('click', () => this.openInviteModal());
      document.getElementById('nexaVrFooterInviteBtn')?.addEventListener('click', () => this.openInviteModal());
      document.getElementById('nexaVrCloseInviteBtn')?.addEventListener('click', () => this.closeInviteModal());
      document.getElementById('nexaVrCopyLinkBtn')?.addEventListener('click', () => this.copyInviteLink());
      document.getElementById('nexaVrUserSearch')?.addEventListener('input', (e) => this.filterUsers(e.target.value));

      // Leave buttons
      document.getElementById('nexaVrEndBtn')?.addEventListener('click', () => this.leaveRoom());
      document.getElementById('nexaVrMiniLeaveBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.leaveRoom();
      });

      // Room chat
      document.getElementById('nexaVrChatSendBtn')?.addEventListener('click', () => this.sendRoomMessage());
      document.getElementById('nexaVrChatInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendRoomMessage(); }
      });
      document.getElementById('nexaVrChatToggle')?.addEventListener('click', () => this.toggleChatSection());

      // Trigger buttons integration for Nexa app UI
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('.start-voice-chat-btn, [data-action="voice-chat"]');
        if (btn) {
          e.preventDefault();
          this.startRoom();
        }
      });
    }

    /* --------------------------------------------------------------------- */
    /* 3. VOICE ROOM ENGINE LIFECYCLE (Start, Join, Leave)                  */
    /* --------------------------------------------------------------------- */

    async startRoom(roomTitle = null) {
      if (this.activeRoom) {
        this.expandOverlay();
        return;
      }

      const user = this.getCurrentUser();
      const title = roomTitle || `${user.name}'s Voice Room`;
      const roomId = 'room_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);

      this.activeRoom = {
        id: roomId,
        title: title,
        hostId: user.id,
        hostName: user.name,
        isHost: true,
        startTime: Date.now()
      };

      // Add self to participants map
      this.participants.clear();
      this.participants.set(user.id, {
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        isHost: true,
        isMuted: false,
        isSpeaking: false,
        handRaised: false
      });

      // Initialize Mic & WebRTC Audio Engine
      await this.initMicrophone();
      this.initPeerJS();

      // Show UI
      this.updateUI();
      this.expandOverlay();
      this.startTimer();
      this.playChime('join');

      // Sync state to Firestore & Broadcast
      this.syncRoomToFirestore();
      this.broadcast('ROOM_CREATED', {
        room: this.activeRoom,
        user: user
      });

      this.subscribeToRoomFirestore();
      this.subscribeToRoomChat();

      this.showToast(`🎙️ Voice Chat started: "${title}"`);
    }

    async joinRoom(roomData) {
      if (!roomData || !roomData.id) return;

      const user = this.getCurrentUser();

      // Enforce the room capacity cap before joining.
      if (window.db) {
        try {
          const snap = await window.db.collection('voice_rooms').doc(roomData.id)
            .collection('participants').get();
          if (snap.size >= this.maxParticipants) {
            this.showToast(`🚫 Voice Chat is full (max ${this.maxParticipants})`);
            return;
          }
        } catch (e) {
          console.warn('[VoiceRoom] Capacity check error:', e);
        }
      }

      this.activeRoom = {
        id: roomData.id,
        title: roomData.title || 'Voice Room',
        hostId: roomData.hostId,
        hostName: roomData.hostName || 'Host',
        isHost: roomData.hostId === user.id,
        startTime: roomData.startTime || Date.now()
      };

      this.participants.set(user.id, {
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        peerId: this.peerIdFor(user.id),
        isHost: this.activeRoom.isHost,
        isMuted: false,
        isSpeaking: false,
        handRaised: false
      });

      await this.initMicrophone();
      this.initPeerJS();

      this.updateUI();
      this.expandOverlay();
      this.startTimer();
      this.playChime('join');

      // Sync state to Firestore & Broadcast
      this.syncRoomToFirestore();
      this.broadcast('USER_JOINED', {
        roomId: this.activeRoom.id,
        user: user
      });

      this.subscribeToRoomFirestore();
      this.subscribeToRoomChat();

      this.showToast(`🟢 Joined Voice Chat: "${this.activeRoom.title}"`);
    }

    leaveRoom() {
      if (!this.activeRoom) return;

      const user = this.getCurrentUser();
      this.playChime('leave');

      // Broadcast leave
      this.broadcast('USER_LEFT', {
        roomId: this.activeRoom.id,
        userId: user.id
      });

      // Clean up peer connections
      if (this.peerCalls) {
        this.peerCalls.forEach(call => call.close());
        this.peerCalls.clear();
      }
      if (this.peer) {
        this.peer.destroy();
        this.peer = null;
      }

      // Remove remote audio elements from DOM
      document.querySelectorAll('audio[id^="audio_"]').forEach(el => {
        try {
          el.pause();
          el.srcObject = null;
          el.remove();
        } catch (e) {}
      });

      // Stop audio tracks
      if (this.localStream) {
        this.localStream.getTracks().forEach(t => t.stop());
        this.localStream = null;
      }
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        this.audioCtx.close().catch(() => {});
        this.audioCtx = null;
      }
      if (this.timerInterval) clearInterval(this.timerInterval);
      if (this.vadInterval) clearInterval(this.vadInterval);
      if (this.roomFirestoreUnsub) {
        this.roomFirestoreUnsub();
        this.roomFirestoreUnsub = null;
      }
      if (this.roomChatUnsub) {
        this.roomChatUnsub();
        this.roomChatUnsub = null;
      }

      // Remove ONLY our own participant doc (merge-based subcollection), then
      // migrate host to the next remaining participant (or delete the room doc
      // if empty). Never overwrite a participants array.
      if (window.db && this.activeRoom) {
        const roomId = this.activeRoom.id;
        const userId = user.id;
        window.db.collection('voice_rooms').doc(roomId)
          .collection('participants').doc(userId).delete()
          .then(() => {
            return window.db.collection('voice_rooms').doc(roomId)
              .collection('participants').get();
          })
          .then(snap => {
            if (snap.empty) {
              // Room is empty — delete the room doc entirely.
              return window.db.collection('voice_rooms').doc(roomId).delete();
            }
            // Migrate host to the earliest remaining participant.
            const remaining = snap.docs.map(d => d.data()).sort((a, b) =>
              String(a.id).localeCompare(String(b.id)));
            const newHost = remaining[0];
            if (newHost) {
              return window.db.collection('voice_rooms').doc(roomId)
                .collection('participants').doc(newHost.id)
                .set({ isHost: true }, { merge: true }).then(() =>
                  window.db.collection('voice_rooms').doc(roomId).set({
                    hostId: newHost.id, hostName: newHost.name, updatedAt: Date.now()
                  }, { merge: true }));
            }
          })
          .catch(err => console.warn('[VoiceRoom] Leave Firestore update error:', err));
      }

      this.activeRoom = null;
      this.participants.clear();

      // Hide UI
      document.getElementById('nexaVrOverlay')?.classList.remove('active');
      const miniBar = document.getElementById('nexaVrMiniBar');
      if (miniBar) miniBar.style.display = 'none';

      this.showToast('📞 Left Voice Chat');
    }

    /* --------------------------------------------------------------------- */
    /* 4. PEERJS WEBRTC MESH AUDIO ENGINE & WEB AUDIO DSP                     */
    /* --------------------------------------------------------------------- */

    initPeerJS() {
      if (typeof window.Peer === 'undefined') {
        // PeerJS may still be loading — retry shortly.
        setTimeout(() => { if (!this.peer) this.initPeerJS(); }, 800);
        return;
      }
      if (this.peer) return;

      const user = this.getCurrentUser();
      const preferredId = this.peerIdFor(user.id);

      const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        { urls: 'stun:relay.metered.ca:80' }
      ];

      try {
        this.peer = new window.Peer(preferredId, {
          debug: 1,
          config: { iceServers }
        });

        this.peer.on('open', (id) => {
          console.log('[VoiceRoom] PeerJS connected with ID:', id);
          this.peerOpen = true;
          // Call existing room participants to build the full mesh.
          this.participants.forEach(p => {
            if (p.id !== user.id) {
              this.callPeer(p.peerId || this.peerIdFor(p.id));
            }
          });
        });

        this.peer.on('call', async (call) => {
          if (!this.localStream) {
            await this.initMicrophone();
          }
          call.answer(this.localStream);
          call.on('stream', (remoteStream) => {
            this.playRemoteAudioStream(call.peer, remoteStream);
          });
        });

        // Fall back to a unique id if the stable id is taken (another tab/device).
        this.peer.on('error', (err) => {
          console.warn('[VoiceRoom] PeerJS error:', err?.type, err?.message);
          if (err && err.type === 'unavailable-id') {
            try { this.peer.destroy(); } catch (e) {}
            this.peer = null;
            this.peerOpen = false;
            this.peer = new window.Peer(this.peerIdFor(user.id) + '_' + Math.random().toString(36).substr(2, 4), {
              debug: 1, config: { iceServers }
            });
            this.peer.on('open', () => {
              this.peerOpen = true;
              this.participants.forEach(p => {
                if (p.id !== user.id) this.callPeer(p.peerId || this.peerIdFor(p.id));
              });
            });
            this.peer.on('call', async (call) => {
              if (!this.localStream) await this.initMicrophone();
              call.answer(this.localStream);
              call.on('stream', (s) => this.playRemoteAudioStream(call.peer, s));
            });
          } else if (err && (err.type === 'disconnected' || err.type === 'network' || err.type === 'server-error')) {
            // Transient — try to reconnect.
            try { if (this.peer && !this.peer.destroyed) this.peer.reconnect(); } catch (e) {}
          }
        });

        this.peer.on('disconnected', () => {
          this.peerOpen = false;
          try { if (this.peer && !this.peer.destroyed) this.peer.reconnect(); } catch (e) {}
        });
      } catch (err) {
        console.warn('[VoiceRoom] PeerJS init error:', err);
      }
    }

    callPeer(targetPeerId) {
      if (!this.peer || !this.peerOpen || !this.localStream || this.peerCalls.has(targetPeerId)) return;

      try {
        const call = this.peer.call(targetPeerId, this.localStream);
        if (call) {
          this.peerCalls.set(targetPeerId, call);
          call.on('stream', (remoteStream) => {
            this.playRemoteAudioStream(targetPeerId, remoteStream);
          });
        }
      } catch (e) {
        console.warn('[VoiceRoom] Call peer error:', e);
      }
    }

    playRemoteAudioStream(peerId, stream) {
      let audioEl = document.getElementById('audio_' + peerId);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = 'audio_' + peerId;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = stream;
      audioEl.muted = this.isSpeakerMuted;
      audioEl.play().catch(err => console.warn('[VoiceRoom] Remote audio play notice:', err));
    }

    async initMicrophone() {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000
          },
          video: false
        });

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContext();
        if (this.audioCtx.state === 'suspended') {
          await this.audioCtx.resume();
        }

        const source = this.audioCtx.createMediaStreamSource(this.localStream);
        
        // Studio High-pass Filter
        const filter = this.audioCtx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 80;

        // Dynamics Compressor
        const compressor = this.audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 30;
        compressor.ratio.value = 12;

        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 64;

        this.micGainNode = this.audioCtx.createGain();
        this.micGainNode.gain.value = 1.0;

        source.connect(filter);
        filter.connect(compressor);
        compressor.connect(this.micGainNode);
        this.micGainNode.connect(this.analyser);

        this.startVADLoop();
      } catch (err) {
        console.warn('[VoiceRoom] Mic stream notice:', err);
        this.startSimulatedVADLoop();
      }
    }

    startVADLoop() {
      if (!this.analyser) return;

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      const vbars = document.querySelectorAll('#nexaVrWaveVisualizer .nexa-vr-vbar');

      this.vadInterval = setInterval(() => {
        if (this.isMuted) {
          this.setLocalSpeakingState(false);
          vbars.forEach(bar => bar.style.height = '4px');
          return;
        }

        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;

        vbars.forEach((bar, index) => {
          const val = dataArray[index % dataArray.length] || 0;
          const h = Math.max(4, Math.min(30, (val / 255) * 32));
          bar.style.height = `${h}px`;
        });

        const isSpeaking = average > 18;
        this.setLocalSpeakingState(isSpeaking);
      }, 100);
    }

    startSimulatedVADLoop() {
      const vbars = document.querySelectorAll('#nexaVrWaveVisualizer .nexa-vr-vbar');
      this.vadInterval = setInterval(() => {
        if (this.isMuted) {
          this.setLocalSpeakingState(false);
          vbars.forEach(bar => bar.style.height = '4px');
          return;
        }

        const isSpeaking = Math.random() > 0.5;
        vbars.forEach(bar => {
          const h = isSpeaking ? Math.floor(Math.random() * 24) + 6 : 4;
          bar.style.height = `${h}px`;
        });

        this.setLocalSpeakingState(isSpeaking);
      }, 150);
    }

    setLocalSpeakingState(isSpeaking) {
      const user = this.getCurrentUser();
      const selfP = this.participants.get(user.id);

      if (selfP && selfP.isSpeaking !== isSpeaking) {
        selfP.isSpeaking = isSpeaking;

        const mainAvatarWrap = document.getElementById('nexaVrMainAvatarWrap');
        if (mainAvatarWrap) {
          mainAvatarWrap.setAttribute('data-speaking', isSpeaking ? 'true' : 'false');
        }

        const userCard = document.getElementById(`nexaVrCard_${user.id}`);
        if (userCard) {
          userCard.setAttribute('data-speaking', isSpeaking ? 'true' : 'false');
        }

        this.broadcast('SPEAKING_STATE', {
          userId: user.id,
          isSpeaking: isSpeaking
        });
      }
    }

    /* --------------------------------------------------------------------- */
    /* 5. USER CONTROLS & INVITE LIST WITH ACTUAL NEXA USERS                 */
    /* --------------------------------------------------------------------- */

    toggleMic() {
      this.isMuted = !this.isMuted;

      if (this.localStream) {
        this.localStream.getAudioTracks().forEach(t => t.enabled = !this.isMuted);
      }

      const micBtn = document.getElementById('nexaVrMicBtn');
      const miniMicBtn = document.getElementById('nexaVrMiniMicBtn');

      if (this.isMuted) {
        micBtn?.classList.remove('active-mic');
        micBtn?.classList.add('muted-mic');
        if (micBtn) micBtn.innerHTML = '🔇';
        if (miniMicBtn) miniMicBtn.innerHTML = '🔇';
        this.showToast('🔇 Microphone muted');
      } else {
        micBtn?.classList.remove('muted-mic');
        micBtn?.classList.add('active-mic');
        if (micBtn) micBtn.innerHTML = '🎙️';
        if (miniMicBtn) miniMicBtn.innerHTML = '🎙️';
        this.showToast('🎙️ Microphone unmuted');
      }

      this.playChime('tick');

      const user = this.getCurrentUser();
      const cardMicStatus = document.querySelector(`#nexaVrCard_${user.id} .nexa-vr-card-mic-status`);
      if (cardMicStatus) {
        if (this.isMuted) {
          cardMicStatus.classList.add('muted');
          cardMicStatus.innerHTML = '🔇';
        } else {
          cardMicStatus.classList.remove('muted');
          cardMicStatus.innerHTML = '🎙️';
        }
      }

      // Sync mute state to Firestore (throttled) for cross-device visibility.
      this.syncMuteState();
    }

    toggleSpeaker() {
      this.isSpeakerMuted = !this.isSpeakerMuted;
      document.querySelectorAll('audio[id^="audio_"]').forEach(el => {
        el.muted = this.isSpeakerMuted;
      });
      const btn = document.getElementById('nexaVrSpeakerBtn');
      if (this.isSpeakerMuted) {
        btn?.classList.add('muted-mic');
        if (btn) btn.innerHTML = '🔇';
        this.showToast('🔇 Speaker muted');
      } else {
        btn?.classList.remove('muted-mic');
        if (btn) btn.innerHTML = '🔊';
        this.showToast('🔊 Speaker active');
      }
      this.playChime('tick');
    }

    raiseHand() {
      const user = this.getCurrentUser();
      const selfP = this.participants.get(user.id);
      if (!selfP) return;

      selfP.handRaised = !selfP.handRaised;
      this.showToast(selfP.handRaised ? '🖐️ You raised your hand' : '🖐️ Hand lowered');
      this.updateUI();

      this.broadcast('RAISE_HAND', {
        userId: user.id,
        handRaised: selfP.handRaised
      });

      // Sync hand-raised state to Firestore (throttled) for cross-device visibility.
      this.syncMuteState();
    }

    openInviteModal() {
      const modal = document.getElementById('nexaVrInviteModal');
      if (modal) {
        modal.classList.add('active');
        this.renderUserInviteList();
      }
    }

    closeInviteModal() {
      document.getElementById('nexaVrInviteModal')?.classList.remove('active');
    }

    copyInviteLink() {
      const roomId = this.activeRoom ? this.activeRoom.id : 'room_demo';
      const link = `${window.location.origin}${window.location.pathname}?voiceroom=${roomId}`;

      navigator.clipboard.writeText(link).then(() => {
        this.showToast('📋 Voice Chat join link copied!');
      }).catch(() => {
        this.showToast('📋 Link copied to clipboard');
      });
    }

    isUserOnline(uid) {
      if (!uid) return false;
      // 1. Check window.isUserOnline & userPresenceCache from Nexa app
      if (typeof window.isUserOnline === 'function' && window.userPresenceCache && window.userPresenceCache[uid]) {
        return !!window.isUserOnline(window.userPresenceCache[uid]);
      }
      // 2. Direct presence cache inspection
      if (window.userPresenceCache && window.userPresenceCache[uid]) {
        const pdata = window.userPresenceCache[uid];
        if (pdata.state === 'online') return true;
        if (pdata.last_seen) {
          const lastSeen = pdata.last_seen.toDate ? pdata.last_seen.toDate().getTime() : (typeof pdata.last_seen === 'number' ? pdata.last_seen : 0);
          return (Date.now() - lastSeen) < 35000;
        }
      }
      // 3. Fallback to user object property
      if (window.allUsersData) {
        const u = window.allUsersData.find(x => x.uid === uid || x.id === uid);
        if (u) {
          if (u.online === true || u.state === 'online' || u.isOnline === true) return true;
        }
      }
      return false;
    }

    renderUserInviteList() {
      const listContainer = document.getElementById('nexaVrUserList');
      if (!listContainer) return;

      // FETCH ACTUAL NEXA REGISTERED USERS
      const actualUsers = this.getActualUsers();
      const currentUser = this.getCurrentUser();

      if (actualUsers.length === 0) {
        listContainer.innerHTML = `
          <div style="text-align: center; color: var(--vr-text-muted); padding: 20px; font-size: 13px;">
            No other users currently registered in Nexa. Share the join link to invite friends!
          </div>
        `;
        return;
      }

      listContainer.innerHTML = actualUsers
        .filter(u => u.id !== currentUser.id) // exclude self
        .map(u => {
          const online = this.isUserOnline(u.id);
          return `
            <div class="nexa-vr-user-item">
              <div class="nexa-vr-user-info">
                <div style="position: relative; display: flex; align-items: center;">
                  <img src="${u.avatar}" class="nexa-vr-user-avatar" onerror="this.src='icon-192.png'">
                  <div style="position: absolute; bottom: 0; right: 0; width: 10px; height: 10px; border-radius: 50%; background: ${online ? '#25d366' : '#8b949e'}; border: 2px solid #161b22; box-shadow: ${online ? '0 0 8px #25d366' : 'none'};"></div>
                </div>
                <div>
                  <div class="nexa-vr-user-name">${this.escapeHTML(u.name)}</div>
                  <div style="font-size: 11px; color: ${online ? '#25d366' : '#8b949e'}; font-weight: 600; display: flex; align-items: center; gap: 4px;">
                    <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${online ? '#25d366' : '#8b949e'};"></span>
                    ${online ? 'Online' : 'Offline'}
                  </div>
                </div>
              </div>
              <button class="nexa-vr-inv-btn" onclick="NexaVoiceRoom.sendInvite('${u.id}', '${this.escapeHTML(u.name)}')">
                Invite
              </button>
            </div>
          `;
        }).join('');
    }

    filterUsers(query) {
      const items = document.querySelectorAll('#nexaVrUserList .nexa-vr-user-item');
      items.forEach(item => {
        const name = item.querySelector('.nexa-vr-user-name')?.textContent.toLowerCase() || '';
        item.style.display = name.includes(query.toLowerCase()) ? 'flex' : 'none';
      });
    }

    sendInvite(userId, userName) {
      const currentUser = this.getCurrentUser();
      
      const payload = {
        targetUserId: userId,
        room: this.activeRoom,
        inviter: currentUser,
        timestamp: Date.now()
      };

      // 1. Broadcast to local channel
      this.broadcast('INVITE_USER', payload);

      // 2. Persist to Firestore voice_invites collection for real cross-device push notification
      if (window.db) {
        window.db.collection('voice_invites').doc(userId).set({
          ...payload,
          status: 'pending'
        }).catch(err => console.warn('[VoiceRoom] Firestore invite write error:', err));
      }

      this.showToast(`📩 Voice Chat invite sent to ${userName}`);
      this.closeInviteModal();
    }

    /* --------------------------------------------------------------------- */
    /* 6. UI RENDERING & MINIMIZE / EXPAND MODES                             */
    /* --------------------------------------------------------------------- */

    minimizeOverlay() {
      document.getElementById('nexaVrOverlay')?.classList.remove('active');
      const miniBar = document.getElementById('nexaVrMiniBar');
      if (miniBar && this.activeRoom) {
        miniBar.style.display = 'flex';
      }
      this.isMinimized = true;
    }

    expandOverlay() {
      document.getElementById('nexaVrOverlay')?.classList.add('active');
      const miniBar = document.getElementById('nexaVrMiniBar');
      if (miniBar) {
        miniBar.style.display = 'none';
      }
      this.isMinimized = false;
    }

    updateUI() {
      if (!this.activeRoom) return;

      const titleEl = document.getElementById('nexaVrTitle');
      if (titleEl) {
        titleEl.innerHTML = `
          ${this.escapeHTML(this.activeRoom.title)}
          <span class="nexa-vr-status-badge">${this.participants.size} Connected</span>
        `;
      }

      const miniTitle = document.getElementById('nexaVrMiniTitle');
      if (miniTitle) miniTitle.textContent = this.activeRoom.title;

      // Main Avatar Stage Update
      const mainAvatar = document.getElementById('nexaVrMainAvatar');
      const mainName = document.getElementById('nexaVrMainSpeakerName');
      const hostParticipant = Array.from(this.participants.values()).find(p => p.isHost) || this.getCurrentUser();

      if (mainAvatar && hostParticipant.avatar) mainAvatar.src = hostParticipant.avatar;
      if (mainName) mainName.textContent = hostParticipant.name;

      // Render Participant Cards
      const grid = document.getElementById('nexaVrParticipantGrid');
      const miniAvatars = document.getElementById('nexaVrMiniAvatars');

      if (grid) {
        grid.innerHTML = Array.from(this.participants.values()).map(p => `
          <div class="nexa-vr-card" id="nexaVrCard_${p.id}" data-speaking="${p.isSpeaking ? 'true' : 'false'}">
            ${p.handRaised ? '<div class="nexa-vr-card-hand">🖐️</div>' : ''}
            <div class="nexa-vr-card-avatar-wrap">
              <div class="nexa-vr-card-ring"></div>
              <img src="${p.avatar}" class="nexa-vr-card-avatar" onerror="this.src='icon-192.png'">
            </div>
            <div class="nexa-vr-card-name">${this.escapeHTML(p.name)}</div>
            ${p.isHost ? '<div class="nexa-vr-card-role">HOST</div>' : ''}
            <div class="nexa-vr-card-mic-status ${p.isMuted ? 'muted' : ''}">
              ${p.isMuted ? '🔇' : '🎙️'}
            </div>
          </div>
        `).join('');
      }

      if (miniAvatars) {
        miniAvatars.innerHTML = Array.from(this.participants.values()).slice(0, 4).map(p => `
          <img src="${p.avatar}" class="nexa-vr-mini-avatar" title="${this.escapeHTML(p.name)}" onerror="this.src='icon-192.png'">
        `).join('');
      }
    }

    startTimer() {
      if (this.timerInterval) clearInterval(this.timerInterval);
      const subTitle = document.getElementById('nexaVrSubtitle');

      this.timerInterval = setInterval(() => {
        if (!this.activeRoom) return;
        const elapsedSec = Math.floor((Date.now() - this.activeRoom.startTime) / 1000);
        const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const secs = String(elapsedSec % 60).padStart(2, '0');

        if (subTitle) {
          subTitle.textContent = `Host: ${this.escapeHTML(this.activeRoom.hostName)} • ${mins}:${secs}`;
        }
      }, 1000);
    }

    /* --------------------------------------------------------------------- */
    /* 7. FIRESTORE REAL-TIME SYNCHRONIZATION & INCOMING INVITATIONS        */
    /* --------------------------------------------------------------------- */

    syncRoomToFirestore() {
      if (!window.db || !this.activeRoom) return;

      const user = this.getCurrentUser();

      // Write room metadata (merge) — NEVER overwrite a participants array here.
      window.db.collection('voice_rooms').doc(this.activeRoom.id).set({
        id: this.activeRoom.id,
        title: this.activeRoom.title,
        hostId: this.activeRoom.hostId,
        hostName: this.activeRoom.hostName,
        updatedAt: Date.now()
      }, { merge: true }).catch(err => console.warn('[VoiceRoom] Firestore room sync error:', err));

      // Write ONLY this client's own participant doc (merge). Each client owns
      // its own doc; never overwrite the whole participants array — that clobbers
      // other users and breaks cross-device visibility.
      this.upsertOwnParticipantDoc();
    }

    // Writes/updates only the current user's participant doc in the
    // voice_rooms/{roomId}/participants subcollection.
    upsertOwnParticipantDoc(extra) {
      if (!window.db || !this.activeRoom) return;
      const user = this.getCurrentUser();
      window.db.collection('voice_rooms').doc(this.activeRoom.id)
        .collection('participants').doc(user.id)
        .set({
          id: user.id,
          name: user.name,
          avatar: user.avatar,
          peerId: this.peerIdFor(user.id),
          isHost: this.activeRoom.isHost,
          isMuted: this.isMuted,
          isSpeaking: false,
          handRaised: !!this.handRaised,
          updatedAt: Date.now(),
          ...(extra || {})
        }, { merge: true }).catch(err => console.warn('[VoiceRoom] Participant upsert error:', err));
    }

    // Throttled mute/speaking/hand sync (~1.2s) so we don't hammer Firestore.
    syncMuteState() {
      if (this._syncMuteTimer) return;
      this._syncMuteTimer = setTimeout(() => {
        this._syncMuteTimer = null;
        this.upsertOwnParticipantDoc();
      }, 1200);
    }

    peerIdFor(uid) {
      return 'nexa_vr_' + String(uid).replace(/[^a-zA-Z0-9_]/g, '_');
    }

    subscribeToRoomFirestore() {
      if (!window.db || !this.activeRoom) return;
      if (this.roomFirestoreUnsub) this.roomFirestoreUnsub();

      // Listen to the participants SUBCOLLECTION (docChanges), not an array on
      // the room doc. On a new participant, callPeer() to build the full mesh.
      this.roomFirestoreUnsub = window.db.collection('voice_rooms')
        .doc(this.activeRoom.id)
        .collection('participants')
        .onSnapshot(snapshot => {
          snapshot.docChanges().forEach(change => {
            const p = change.doc.data();
            if (!p || !p.id) return;

            if (change.type === 'added' || change.type === 'modified') {
              const isNew = !this.participants.has(p.id);
              this.participants.set(p.id, {
                id: p.id,
                name: p.name,
                avatar: p.avatar,
                peerId: p.peerId || this.peerIdFor(p.id),
                isHost: !!p.isHost,
                isMuted: !!p.isMuted,
                isSpeaking: !!p.isSpeaking,
                handRaised: !!p.handRaised
              });
              if (isNew) {
                this.updateUI();
                // Build the mesh: call the new participant's peer.
                if (p.id !== this.getCurrentUser().id && this.peer && this.peer.open) {
                  this.callPeer(p.peerId || this.peerIdFor(p.id));
                }
              } else {
                // Reflect mute/hand changes in the UI without a full rebuild.
                this.refreshParticipantCard(p.id);
              }
            } else if (change.type === 'removed') {
              if (this.participants.has(p.id)) {
                const name = this.participants.get(p.id).name;
                this.participants.delete(p.id);
                // Close the peer call to the departing participant.
                const peerId = p.peerId || this.peerIdFor(p.id);
                const call = this.peerCalls.get(peerId);
                if (call) { try { call.close(); } catch (e) {} this.peerCalls.delete(peerId); }
                const audioEl = document.getElementById('audio_' + peerId);
                if (audioEl) { audioEl.pause(); audioEl.remove(); }
                this.updateUI();
                if (name) this.showToast(`🔴 ${name} left`);
              }
            }
          });

          // Host migration: if the host doc vanished but the room still has
          // people, promote the earliest remaining participant.
          this.maybeMigrateHost();
        }, err => console.warn('[VoiceRoom] Participants listener error:', err));
    }

    maybeMigrateHost() {
      if (!this.activeRoom) return;
      const hasHost = Array.from(this.participants.values()).some(p => p.isHost);
      if (hasHost) return;
      const me = this.getCurrentUser();
      if (!this.participants.has(me.id)) return;

      // Promote self to host if the original host left.
      const remaining = Array.from(this.participants.values());
      // Pick the participant with the smallest id hash as a deterministic tie-breaker.
      remaining.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (remaining[0] && remaining[0].id === me.id) {
        this.activeRoom.isHost = true;
        this.activeRoom.hostId = me.id;
        this.activeRoom.hostName = me.name;
        const p = this.participants.get(me.id);
        if (p) p.isHost = true;
        this.upsertOwnParticipantDoc();
        window.db.collection('voice_rooms').doc(this.activeRoom.id).set({
          hostId: me.id, hostName: me.name, updatedAt: Date.now()
        }, { merge: true }).catch(() => {});
        this.updateUI();
        this.showToast(`👑 You are now the host`);
      }
    }

    refreshParticipantCard(id) {
      const p = this.participants.get(id);
      const card = document.getElementById(`nexaVrCard_${id}`);
      if (!p || !card) return;
      card.setAttribute('data-speaking', p.isSpeaking ? 'true' : 'false');
      const hand = card.querySelector('.nexa-vr-card-hand');
      if (p.handRaised && !hand) {
        const h = document.createElement('div');
        h.className = 'nexa-vr-card-hand';
        h.textContent = '🖐️';
        card.prepend(h);
      } else if (!p.handRaised && hand) {
        hand.remove();
      }
      const mic = card.querySelector('.nexa-vr-card-mic-status');
      if (mic) {
        mic.classList.toggle('muted', p.isMuted);
        mic.textContent = p.isMuted ? '🔇' : '🎙️';
      }
    }

    /* --------------------------------------------------------------------- */
    /* 7b. IN-ROOM TEXT CHAT                                                 */
    /* --------------------------------------------------------------------- */

    // Subscribe to the room's messages subcollection. Called on join.
    subscribeToRoomChat() {
      if (!window.db || !this.activeRoom) return;
      if (this.roomChatUnsub) this.roomChatUnsub();

      const box = document.getElementById('nexaVrChatMessages');
      this.roomChatUnsub = window.db.collection('voice_rooms')
        .doc(this.activeRoom.id)
        .collection('messages')
        .orderBy('createdAt', 'asc')
        .limitToLast(100)
        .onSnapshot(snap => {
          if (!box) return;
          const me = this.getCurrentUser();
          let html = '';
          snap.forEach(doc => {
            const m = doc.data() || {};
            const mine = m.uid === me.id;
            const name = this.escapeHTML(m.name || 'User');
            const text = this.escapeHTML(m.text || '');
            const time = m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            html += `
              <div class="nexa-vr-chat-msg ${mine ? 'mine' : ''}">
                ${!mine ? `<div class="nexa-vr-chat-msg-name">${name}</div>` : ''}
                <div class="nexa-vr-chat-msg-bubble">${text}</div>
                <div class="nexa-vr-chat-msg-time">${time}</div>
              </div>`;
          });
          box.innerHTML = html || '<div class="nexa-vr-chat-empty">No messages yet — say hi to the room 👋</div>';
          box.scrollTop = box.scrollHeight;
        }, err => console.warn('[VoiceRoom] Chat listener error:', err));
    }

    sendRoomMessage() {
      const input = document.getElementById('nexaVrChatInput');
      if (!input || !this.activeRoom || !window.db) return;
      const text = input.value.trim();
      if (!text) return;

      const user = this.getCurrentUser();
      window.db.collection('voice_rooms').doc(this.activeRoom.id)
        .collection('messages').add({
          uid: user.id,
          name: user.name,
          avatar: user.avatar,
          text: text,
          createdAt: Date.now()
        }).catch(err => console.warn('[VoiceRoom] Chat send error:', err));

      input.value = '';
    }

    toggleChatSection() {
      const body = document.getElementById('nexaVrChatBody');
      const toggle = document.getElementById('nexaVrChatToggle');
      if (!body) return;
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'flex' : 'none';
      if (toggle) toggle.textContent = collapsed ? '▾' : '▸';
    }

    setupFirestoreListeners() {
      if (!window.db) return;

      const user = this.getCurrentUser();
      if (!user || !user.id) return;

      // Listen for incoming voice chat invites for current user
      window.db.collection('voice_invites').doc(user.id).onSnapshot(doc => {
        if (doc.exists) {
          const data = doc.data() || {};
          if (data.status === 'pending' && data.room) {
            this.showIncomingInvite(data);
          }
        }
      }, err => console.warn('[VoiceRoom] Firestore invite listener notice:', err));
    }

    broadcast(type, payload) {
      try {
        const user = this.getCurrentUser();
        this.channel.postMessage({ type, payload, senderId: user.id });
      } catch (e) {
        console.warn('[VoiceRoom] Broadcast error:', e);
      }
    }

    setupChannelListeners() {
      this.channel.onmessage = (event) => {
        const user = this.getCurrentUser();
        const { type, payload, senderId } = event.data || {};
        if (senderId === user.id) return; // ignore self

        switch (type) {
          case 'ROOM_CREATED':
          case 'USER_JOINED':
            if (this.activeRoom && payload.user) {
              this.participants.set(payload.user.id, {
                id: payload.user.id,
                name: payload.user.name,
                avatar: payload.user.avatar,
                isHost: payload.user.id === this.activeRoom.hostId,
                isMuted: false,
                isSpeaking: false
              });
              this.updateUI();
              this.showToast(`🟢 ${payload.user.name} joined the Voice Chat`);
              this.playChime('join');
            }
            break;

          case 'USER_LEFT':
            if (this.activeRoom && payload.userId) {
              const leavingUser = this.participants.get(payload.userId);
              this.participants.delete(payload.userId);
              this.updateUI();
              if (leavingUser) {
                this.showToast(`🔴 ${leavingUser.name} left`);
              }
            }
            break;

          case 'SPEAKING_STATE':
            if (this.activeRoom && payload.userId) {
              const p = this.participants.get(payload.userId);
              if (p) {
                p.isSpeaking = payload.isSpeaking;
                const card = document.getElementById(`nexaVrCard_${payload.userId}`);
                if (card) {
                  card.setAttribute('data-speaking', payload.isSpeaking ? 'true' : 'false');
                }
              }
            }
            break;

          case 'RAISE_HAND':
            if (this.activeRoom && payload.userId) {
              const p = this.participants.get(payload.userId);
              if (p) {
                p.handRaised = payload.handRaised;
                this.updateUI();
              }
            }
            break;

          case 'INVITE_USER':
            if (payload.targetUserId === user.id) {
              this.showIncomingInvite(payload);
            }
            break;
        }
      };
    }

    showIncomingInvite(payload) {
      const toast = document.getElementById('nexaVrIncomingToast');
      const titleEl = document.getElementById('nexaVrIncTitle');
      const subEl = document.getElementById('nexaVrIncSub');
      const avatarEl = document.getElementById('nexaVrIncAvatar');

      if (toast && payload.room) {
        titleEl.textContent = `🎙️ ${payload.room.title}`;
        subEl.textContent = `${payload.inviter.name} invited you to Voice Chat`;
        avatarEl.src = payload.inviter.avatar || 'icon-192.png';

        toast.classList.add('active');
        this.playChime('ring');

        const joinBtn = document.getElementById('nexaVrIncJoinBtn');
        const declineBtn = document.getElementById('nexaVrIncDeclineBtn');

        const handleJoin = () => {
          toast.classList.remove('active');
          if (window.db && payload.targetUserId) {
            window.db.collection('voice_invites').doc(payload.targetUserId).update({ status: 'accepted' }).catch(() => {});
          }
          this.joinRoom(payload.room);
          cleanup();
        };

        const handleDecline = () => {
          toast.classList.remove('active');
          if (window.db && payload.targetUserId) {
            window.db.collection('voice_invites').doc(payload.targetUserId).update({ status: 'declined' }).catch(() => {});
          }
          cleanup();
        };

        const cleanup = () => {
          joinBtn.removeEventListener('click', handleJoin);
          declineBtn.removeEventListener('click', handleDecline);
        };

        joinBtn.addEventListener('click', handleJoin);
        declineBtn.addEventListener('click', handleDecline);
      }
    }

    /* --------------------------------------------------------------------- */
    /* 8. AUDIO SYNTHESIZER CHIMES & TOAST HELPER                            */
    /* --------------------------------------------------------------------- */

    playChime(type) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);

        const now = ctx.currentTime;

        if (type === 'join') {
          osc.frequency.setValueAtTime(523.25, now);
          osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.15);
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
          osc.start(now);
          osc.stop(now + 0.3);
        } else if (type === 'leave') {
          osc.frequency.setValueAtTime(659.25, now);
          osc.frequency.exponentialRampToValueAtTime(440, now + 0.15);
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
          osc.start(now);
          osc.stop(now + 0.3);
        } else if (type === 'tick') {
          osc.frequency.setValueAtTime(800, now);
          gain.gain.setValueAtTime(0.08, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
          osc.start(now);
          osc.stop(now + 0.05);
        } else if (type === 'ring') {
          osc.frequency.setValueAtTime(587.33, now);
          gain.gain.setValueAtTime(0.12, now);
          gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
          osc.start(now);
          osc.stop(now + 0.5);
        }
      } catch (e) {}
    }

    showToast(message) {
      const toast = document.createElement('div');
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 100010;
        background: rgba(13, 17, 23, 0.95);
        border: 1px solid var(--vr-whatsapp-green, #25d366);
        color: #fff;
        padding: 10px 20px;
        border-radius: 30px;
        font-family: 'Outfit', sans-serif;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        animation: nexaVrSlideDown 0.3s ease-out;
      `;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2500);
    }

    escapeHTML(str) {
      return String(str || '').replace(/[&<>"']/g, match => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[match]));
    }
  }

  // Initialize global instance
  window.NexaVoiceRoom = new NexaVoiceRoomManager();

})();
