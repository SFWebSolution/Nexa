/**
 * NEXA VIDEOS — short-video feed for the Moments tab.
 *
 * Model:
 *  - PUBLIC feed: any signed-in user can watch. NOT connection-gated.
 *  - PUSH is connection-only: when you post, only your ACCEPTED connections
 *    get a notification. Everyone else still sees the video in the feed.
 *  - Likes are a per-video subcollection (videos/{id}/likes/{uid}) so no doc
 *    ever grows an unbounded array; the parent keeps a denormalised `likes`
 *    count for cheap rendering.
 *
 * Firestore:
 *   videos/{id}                      { uid, authorName, authorPhoto, videoUrl,
 *                                      thumbUrl, caption, duration,
 *                                      createdAt (ms int), views, likes,
 *                                      commentsCount, shares, saves, visibility }
 *   videos/{id}/likes/{uid}          { at }
 *   users/{me}/liked_videos/{vid}    { videoId, uid, caption, thumbUrl,
 *                                      videoUrl, at }  ← mirror written
 *                                      by doLike so a profile's "Liked" grid
 *                                      is a cheap per-user read
 *   videos/{id}/comments/{cid}       { uid, name, photo, text, createdAt, likes }
 *
 * Depends on globals exposed by app-main.js: window.db, window.db.fieldValue,
 * window.nexaCurrentUser, window.nexaMyConnections, window.uploadFile,
 * window.sendPushNotification, window.escapeHtml, window.safeMediaUrl,
 * window.showNotifToast.
 */
(function () {
  'use strict';

  const PAGE = 6;          // feed page size (newest N, then older chunks)
  const COMMENTS_PAGE = 60; // comments fetched per video
  const DOUBLE_TAP_MS = 260;
  // Upload caps. BOTH are hard client caps (raise the constant + the picker
  // hint together). MAX_VIDEO_MB matches the Cloudinary plan ceiling: Free is
  // 100 MB/file, Plus is 2 GB, Advanced 4 GB. Anything over the ceiling is
  // rejected here with a clear message instead of failing mid-upload.
  const MAX_VIDEO_MIN = 20;
  const MAX_VIDEO_MS = MAX_VIDEO_MIN * 60 * 1000;
  const MAX_VIDEO_MB = 100;
  const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024;
  // Public share links must resolve from ANY device (not just the one that
  // shared), so they point at the canonical web host rather than this origin.
  const SHARE_ORIGIN = 'https://nexa-qydr.onrender.com';
  const SEEK_STEP = 10; // seconds moved by a double-tap on the left/right zone

  const state = {
    started: false,
    videos: [],
    unsub: null,
    oldestCreatedAt: null,
    exhausted: false,
    loadingOlder: false,
    activeId: null,
    viewed: new Set(),      // video ids whose `views` we already bumped this session
    likedMine: {},          // videoId -> true/false (did *I* like it)
    followOverride: {},     // uid -> bool, our own follow action the listener hasn't confirmed yet
    followBusy: {},         // uid -> a follow write is in flight (blocks a double tap)
    sharesExact: {},        // videoId -> exact share count (the badge label is rounded)
    sharing: {},            // videoId -> a share is in flight (blocks a double tap)
    pendingFile: null,      // File chosen in the composer
    previewObjectUrl: null, // blob URL backing the composer preview
    pendingDuration: 0,     // seconds (from the preview metadata)
    posting: false,
    commentsUnsub: null,
    commentsVideoId: null,
    commentItems: [],       // last snapshot of the open video's comments
    likedComments: {},      // commentId -> did *I* like it
    checkedCommentLikes: {}, // commentId -> marker already resolved this open
    commentReplyTo: null,   // { id, name } while composing a reply
    expandedThreads: {},    // commentId -> true when its replies are shown
    lastTapAt: 0,
    lastTapId: null,
    pendingDurationMs: 0,
    pendingTooLong: false,
    pendingTooBig: false,
    editVideoId: null,
    myVideos: [],
    myUnsub: null,
    lastTapZone: 'c',      // 'l' | 'c' | 'r' — which third of the card was tapped
    focusVideoId: null,    // ?video=<id> deep-link target
    focusFetching: false,
    soundOn: (function () { try { var s = localStorage.getItem('nexa_videos_sound'); return s === null ? true : s === '1'; } catch (e) { return true; } })()
  };

  // ── small helpers ────────────────────────────────────────────────────────
  function cu() { return window.nexaCurrentUser || window.currentUser || null; }
  function myUid() { const u = cu(); return u ? u.uid : null; }
  function myName() {
    const u = cu();
    return ((document.getElementById('myName') || {}).textContent || (u && u.displayName) || 'Someone').trim();
  }
  function myPhoto() {
    const img = document.getElementById('myPic');
    return (img && img.src) || (cu() && cu().photoURL) || 'https://i.imgur.com/HeIi0wU.png';
  }
  function esc(v) { return window.escapeHtml ? window.escapeHtml(v) : String(v == null ? '' : v); }
  function safeUrl(u) { return window.safeMediaUrl ? window.safeMediaUrl(u) : u; }
  function el(id) { return document.getElementById(id); }
  function whoAmI() { return myUid(); }
  // Follow state for a uid. Prefers our OWN recent action (state.followOverride)
  // until the follows listener catches up, so the button doesn't flicker back.
  // The override self-clears the moment the underlying map agrees.
  function relationshipWith(uid) {
    const base = (typeof window.nexaRelationshipWith === 'function')
      ? window.nexaRelationshipWith(uid)
      : { following: null, followsMe: false };
    if (Object.prototype.hasOwnProperty.call(state.followOverride, uid)) {
      const ov = !!state.followOverride[uid];
      if ((base.following === 'accepted') === ov) delete state.followOverride[uid];
      else return { following: ov ? 'accepted' : null, followsMe: base.followsMe };
    }
    return base;
  }
  function toast(m, t) { try { window.showNotifToast && window.showNotifToast(m, t || 'info'); } catch (e) {} }
  function fv() { return (window.db && window.db.fieldValue) || null; }

  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 >= 1e5 ? 1 : 0) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 >= 100 ? 1 : 0) + 'K';
    return String(n);
  }
  // Doc ids go inside inline onclick handlers, so strip anything that could
  // break out of the quoted attribute.
  function sid(id) { return String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, ''); }

  function fmtDur(ms) {
    const total = Math.round((Number(ms) || 0) / 1000);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return m + ':' + String(sec).padStart(2, '0');
  }

  function timeAgo(ms) {
    if (!ms) return '';
    const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    const d = Math.floor(h / 24);
    if (d < 7) return d + 'd';
    const w = Math.floor(d / 7);
    if (w < 5) return w + 'w';
    const mo = Math.floor(d / 30);
    if (mo < 12) return mo + 'mo';
    return Math.floor(d / 365) + 'y';
  }

  // Cloudinary can render a still frame from a video by injecting a transform.
  // Best-effort: a non-Cloudinary URL just gets no poster.
  function cloudThumb(url) {
    if (!url || String(url).indexOf('res.cloudinary.com') === -1) return '';
    return String(url)
      .replace('/video/upload/', '/video/upload/so_0,w_540/')
      .replace(/\.(mp4|webm|mov|m4v|avi|ogv)(\?.*)?$/i, '.jpg$2');
  }

  // ── feed: subscribe / page ───────────────────────────────────────────────
  function open(focusVideoId) {
    if (!window.db || !myUid()) return;
    if (focusVideoId) state.focusVideoId = focusVideoId;
    renderShell();
    if (!state.started) start();
    else if (state.focusVideoId) focusPendingVideo();
  }

  function start() {
    state.started = true;
    state.exhausted = false;
    state.oldestCreatedAt = null;
    state.videos = [];
    try {
      state.unsub = window.db.collection('videos')
        .orderBy('createdAt', 'desc')
        .limit(PAGE)
        .onSnapshot(snap => {
          const fresh = [];
          snap.forEach(d => { fresh.push(Object.assign({ id: d.id }, d.data())); });
          // Merge with any older pages already loaded (dedupe by id, keep order).
          const older = state.videos.filter(v => {
            const t = Number(v.createdAt) || 0;
            const minFresh = fresh.length ? (Number(fresh[fresh.length - 1].createdAt) || 0) : Infinity;
            return t < minFresh;
          });
          state.videos = fresh.concat(older);
          if (fresh.length) state.oldestCreatedAt = Number(fresh[fresh.length - 1].createdAt) || state.oldestCreatedAt;
          renderFeed();
        }, err => {
          console.warn('videos listener error', err && err.message);
          if (window.nexaNoteQuotaError) window.nexaNoteQuotaError(err);
          renderEmpty('Could not load videos right now.');
        });
    } catch (e) {
      console.warn('videos subscribe failed', e);
    }
  }

  function stop() {
    if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; }
    // Leaving the tab must silence the clip, not just drop the listener.
    const feed = el('nvFeed');
    if (feed) feed.querySelectorAll('.nv-video').forEach(v => { try { v.pause(); } catch (e) {} });
    state.started = false;
  }

  function loadOlder() {
    if (state.loadingOlder || state.exhausted || !state.oldestCreatedAt) return;
    state.loadingOlder = true;
    const pill = el('nvLoadOlder');
    if (pill) pill.style.display = 'block';
    window.db.collection('videos')
      .orderBy('createdAt', 'desc')
      .startAfter(state.oldestCreatedAt)
      .limit(PAGE)
      .get()
      .then(snap => {
        const add = [];
        snap.forEach(d => {
          const v = Object.assign({ id: d.id }, d.data());
          if (!state.videos.some(x => x.id === v.id)) add.push(v);
        });
        if (!add.length) { state.exhausted = true; }
        else {
          state.videos = state.videos.concat(add);
          state.oldestCreatedAt = Number(add[add.length - 1].createdAt) || state.oldestCreatedAt;
          appendCards(add);
        }
        if (add.length < PAGE) state.exhausted = true;
      })
      .catch(err => { console.warn('loadOlder failed', err && err.message); if (window.nexaNoteQuotaError) window.nexaNoteQuotaError(err); })
      .finally(() => { state.loadingOlder = false; if (pill) pill.style.display = 'none'; });
  }

  // ── render ───────────────────────────────────────────────────────────────
  function renderShell() {
    const host = el('nexaVideosRoot');
    if (!host) return;
    if (!host.dataset.built) {
      host.dataset.built = '1';
      host.innerHTML =
        '<div class="nv-feed" id="nvFeed" tabindex="0"></div>' +
        '<button class="nv-sound" id="nvSoundBtn" onclick="nexaVideosToggleSound()" aria-label="Toggle sound">' +
          '<i data-lucide="volume-x" style="width:20px;height:20px;"></i></button>' +
        '<div class="nv-load-older" id="nvLoadOlder" style="display:none;">Loading…</div>';
      const feed = el('nvFeed');
      feed.addEventListener('click', onFeedClick);
      feed.addEventListener('pointerdown', onFeedPointerDown);
      feed.addEventListener('pointerup', onFeedPointerUp);
      feed.addEventListener('pointercancel', clearLongPress);
      feed.addEventListener('scroll', onFeedScroll, { passive: true });
      setupObserver();
      if (window.lucide) window.lucide.createIcons();
      applySound();
    }
  }

  // The feed used to do `feed.innerHTML = …` on every snapshot, which recreated
  // every <video> element — so any like/comment/share from anyone restarted the
  // clip you were watching. It now diffs: existing cards are REUSED (their
  // <video> is never touched) and only the changed numbers/meta are patched;
  // new cards are inserted, deleted ones removed, order fixed.
  function renderFeed() {
    const feed = el('nvFeed');
    if (!feed) return;
    if (!state.videos.length) {
      renderEmpty('No videos yet. Be the first to post one!');
      return;
    }
    const empty = feed.querySelector('.nv-empty');
    if (empty) empty.remove();

    const existing = {};
    feed.querySelectorAll('.nv-card').forEach(c => { existing[c.getAttribute('data-id')] = c; });

    const wanted = {};
    state.videos.forEach(v => { wanted[v.id] = true; });
    Object.keys(existing).forEach(id => { if (!wanted[id]) existing[id].remove(); });

    let prev = null;
    state.videos.forEach(v => {
      let card = existing[v.id];
      if (!card) {
        const t = document.createElement('div');
        t.innerHTML = cardHtml(v);
        card = t.firstElementChild;
        existing[v.id] = card;
      } else {
        patchCard(card, v);
      }
      const shouldBe = prev ? prev.nextSibling : feed.firstChild;
      if (card !== shouldBe) feed.insertBefore(card, shouldBe);
      prev = card;
    });

    applySound();
    syncFollowButtons();
    if (window.lucide) window.lucide.createIcons();
    setupObserver();
    if (!feed.querySelector('.nv-card.nv-visible')) {
      const first = feed.querySelector('.nv-card');
      if (first) first.classList.add('nv-visible');
    }
    if (state.focusVideoId) focusPendingVideo();
  }

  // Patch the volatile bits of a card WITHOUT touching its <video>.
  function metaSig(v) { return (v.caption || ''); }

  // Light-touch follow-button sync (no meta rebuild, so the <video> is safe).
  function syncFollowButtons() {
    const me = whoAmI();
    const feed = el('nvFeed');
    if (!feed) return;
    feed.querySelectorAll('.nv-card').forEach(card => {
      const uid = card.getAttribute('data-uid') || '';
      const btn = card.querySelector('.nv-follow-btn');
      if (!btn) return;
      if (!uid || uid === me) { btn.style.display = 'none'; return; }
      const following = relationshipWith(uid).following === 'accepted';
      btn.style.display = '';
      btn.classList.toggle('following', following);
      if (btn.textContent !== (following ? 'Following' : 'Follow')) btn.textContent = following ? 'Following' : 'Follow';
    });
  }

  function patchCard(card, v) {
    const set = (sel, text) => {
      const n = card.querySelector(sel);
      if (n && n.textContent !== text) n.textContent = text;
    };
    set('.nv-rail-like .nv-rail-count', fmtCount(v.likes));
    set('[data-act="comment"] .nv-rail-count', fmtCount(v.commentsCount));
    // Shares: adopt the server number only when it has moved FORWARD. A
    // snapshot that lands before our increment write commits carries the OLD
    // value; taking it blindly would wipe the count we just painted and make
    // the share look like it didn't register.
    const serverShares = Number(v.shares) || 0;
    if (state.sharesExact[v.id] === undefined || serverShares > state.sharesExact[v.id]) {
      state.sharesExact[v.id] = serverShares;
    }
    set('[data-act="share"] .nv-rail-count', fmtCount(state.sharesExact[v.id]));
    set('.nv-dur', v.duration ? fmtDur(Number(v.duration) * 1000) : '');
    const likeBtn = card.querySelector('.nv-rail-like');
    if (likeBtn) likeBtn.classList.toggle('liked', !!state.likedMine[v.id]);
    const meta = card.querySelector('.nv-meta');
    if (meta && meta.getAttribute('data-sig') !== metaSig(v)) meta.outerHTML = metaHtml(v);
  }

  // Scroll to + play the ?video=<id> deep-link target, fetching it directly if
  // it is not in the first page of the feed.
  function focusPendingVideo() {
    const id = state.focusVideoId;
    if (!id) return;
    const feed = el('nvFeed');
    if (!feed) return;
    const jump = () => {
      const card = feed.querySelector('.nv-card[data-id="' + id.replace(/["'\\]/g, '') + '"]');
      if (!card) return false;
      card.scrollIntoView({ block: 'start' });
      card.classList.add('nv-visible');
      const video = card.querySelector('.nv-video');
      if (video) tryPlay(video);
      state.focusVideoId = null;
      return true;
    };
    if (jump()) return;
    if (state.focusFetching) return;
    state.focusFetching = true;
    window.db.collection('videos').doc(id).get().then(d => {
      state.focusFetching = false;
      if (!d.exists) { state.focusVideoId = null; return; }
      if (!state.videos.some(v => v.id === id)) {
        state.videos = [Object.assign({ id: d.id }, d.data())].concat(state.videos);
        renderFeed();
      }
      requestAnimationFrame(() => { if (state.focusVideoId) focusPendingVideo(); });
    }).catch(() => { state.focusFetching = false; state.focusVideoId = null; });
  }

  function appendCards(list) {
    const feed = el('nvFeed');
    if (!feed) return;
    const empty = feed.querySelector('.nv-empty');
    if (empty) empty.remove();
    feed.insertAdjacentHTML('beforeend', list.map(cardHtml).join(''));
    applySound();
    if (window.lucide) window.lucide.createIcons();
    setupObserver();
  }

  function renderEmpty(msg) {
    const feed = el('nvFeed');
    if (!feed) return;
    feed.innerHTML = '<div class="nv-empty">' +
      '<div class="nv-empty-ic"><i data-lucide="clapperboard" style="width:38px;height:38px;"></i></div>' +
      '<div class="nv-empty-title">Videos</div>' +
      '<div class="nv-empty-text">' + esc(msg) + '</div>' +
      '<button class="nv-empty-btn" onclick="nexaVideosOpenComposer()">Upload a video</button>' +
      '</div>';
    if (window.lucide) window.lucide.createIcons();
  }

  // Follow / Following button for the author row. Hidden on our own videos.
  function followBtnHtml(v) {
    const uid = v.uid || '';
    if (!uid || uid === whoAmI()) return '';
    const following = relationshipWith(uid).following === 'accepted';
    return '<button class="nv-follow-btn' + (following ? ' following' : '') +
      '" data-follow="' + esc(uid) + '" data-act="follow" data-id="' + esc(v.id) + '" aria-label="Follow">' +
      (following ? 'Following' : 'Follow') + '</button>';
  }

  function metaHtml(v) {
    return '' +
      '<div class="nv-meta" data-sig="' + esc(metaSig(v)) + '">' +
        '<div class="nv-author-row">' +
          '<div class="nv-author nv-author-tap" onclick="event.stopPropagation();nexaProfileOpen(\'' + esc(v.uid || '') + '\')" title="View profile">' +
            '<img class="nv-author-pic" src="' + esc(safeUrl(v.authorPhoto || 'https://i.imgur.com/HeIi0wU.png')) + '" alt="">' +
            '<span class="nv-author-name">@' + esc(v.authorName || 'user') + '</span>' +
            '<span class="nv-dot">·</span>' +
            '<span class="nv-time">' + esc(timeAgo(Number(v.createdAt))) + '</span>' +
          '</div>' +
          followBtnHtml(v) +
        '</div>' +
        (v.caption ? '<div class="nv-caption">' + esc(v.caption) + '</div>' : '') +
      '</div>';
  }

  function cardHtml(v) {
    const thumb = v.thumbUrl || cloudThumb(v.videoUrl);
    const poster = thumb ? ' poster="' + esc(safeUrl(thumb)) + '"' : '';
    const liked = !!state.likedMine[v.id];
    return '' +
      '<div class="nv-card" data-id="' + esc(v.id) + '" data-uid="' + esc(v.uid || '') + '">' +
        '<video class="nv-video" src="' + esc(safeUrl(v.videoUrl)) + '"' + poster +
          ' playsinline webkit-playsinline loop preload="metadata"></video>' +
        '<div class="nv-shade"></div>' +
        '<div class="nv-heart" id="nvHeart-' + esc(v.id) + '">' +
          '<i data-lucide="heart" style="width:84px;height:84px;"></i></div>' +
        '<div class="nv-play-hint" aria-hidden="true">' +
          '<i data-lucide="play" style="width:30px;height:30px;"></i></div>' +
        '<div class="nv-dur">' + (v.duration ? fmtDur(Number(v.duration) * 1000) : '') + '</div>' +
        metaHtml(v) +
        '<div class="nv-rail">' +
          '<button class="nv-rail-btn nv-rail-like' + (liked ? ' liked' : '') + '" data-act="like" data-id="' + esc(v.id) + '" aria-label="Like">' +
            '<i data-lucide="heart" style="width:26px;height:26px;"></i>' +
            '<span class="nv-rail-count" id="nvLikeCount-' + esc(v.id) + '">' + fmtCount(v.likes) + '</span></button>' +
          '<button class="nv-rail-btn" data-act="comment" data-id="' + esc(v.id) + '" aria-label="Comments">' +
            '<i data-lucide="message-circle" style="width:26px;height:26px;"></i>' +
            '<span class="nv-rail-count" id="nvCommentCount-' + esc(v.id) + '">' + fmtCount(v.commentsCount) + '</span></button>' +
          '<button class="nv-rail-btn" data-act="share" data-id="' + esc(v.id) + '" aria-label="Share">' +
            '<i data-lucide="share-2" style="width:25px;height:25px;"></i>' +
            '<span class="nv-rail-count" id="nvShareCount-' + esc(v.id) + '">' + fmtCount(v.shares) + '</span></button>' +
          '<button class="nv-rail-btn" data-act="save" data-id="' + esc(v.id) + '" aria-label="Save">' +
            '<i data-lucide="bookmark" style="width:25px;height:25px;"></i></button>' +
        '</div>' +
        '<div class="nv-progress"><i id="nvProg-' + esc(v.id) + '"></i></div>' +
      '</div>';
  }

  // ── visibility / autoplay ────────────────────────────────────────────────
  let _observer = null;
  function setupObserver() {
    const feed = el('nvFeed');
    if (!feed) return;
    if (_observer) { _observer.disconnect(); }
    _observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const card = entry.target;
        const video = card.querySelector('.nv-video');
        const id = card.getAttribute('data-id');
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          card.classList.add('nv-visible');
          state.activeId = id;
          attachVideoTime(card, video);
          tryPlay(video);
          bumpView(id, card.getAttribute('data-uid'));
          ensureLikedState(id, card);
        } else {
          card.classList.remove('nv-visible');
          if (video && !video.paused) { try { video.pause(); } catch (e) {} }
        }
      });
    }, { root: feed, threshold: [0, 0.6, 0.95] });
    feed.querySelectorAll('.nv-card').forEach(c => _observer.observe(c));
  }

  // Drives the progress bar + duration badge from the real media clock.
  function attachVideoTime(card, video) {
    if (!video || video._nvTime) return;
    video._nvTime = true;
    const prog = card.querySelector('.nv-progress > i');
    const durEl = card.querySelector('.nv-dur');
    const paint = () => {
      const d = video.duration;
      if (durEl && isFinite(d) && d > 0) durEl.textContent = fmtDur(d * 1000);
      if (prog && isFinite(d) && d > 0) {
        prog.style.width = Math.min(100, (video.currentTime / d) * 100) + '%';
      }
    };
    video.addEventListener('timeupdate', paint);
    video.addEventListener('loadedmetadata', paint);
    video.addEventListener('durationchange', paint);
    paint();
  }

  // Double-tap on the left/right third: jump SEEK_STEP seconds back/forward.
  function seekBy(card, delta) {
    const video = card.querySelector('.nv-video');
    if (!video) return;
    const d = video.duration;
    if (!isFinite(d) || d <= 0) return;
    video.currentTime = Math.max(0, Math.min(d - 0.05, (video.currentTime || 0) + delta));
    const prog = card.querySelector('.nv-progress > i');
    if (prog) prog.style.width = Math.min(100, (video.currentTime / d) * 100) + '%';
    showSeekPill(card, delta);
  }

  function showSeekPill(card, delta) {
    let pill = card.querySelector('.nv-seek-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'nv-seek-pill';
      card.appendChild(pill);
    }
    pill.textContent = delta < 0 ? '⏪ ' + Math.abs(delta) + 's' : delta + 's ⏩';
    pill.classList.toggle('nv-seek-pill-l', delta < 0);
    pill.classList.add('show');
    clearTimeout(pill._t);
    pill._t = setTimeout(() => pill.classList.remove('show'), 700);
  }

  // Drag the bottom bar to scrub (pointer capture on the document so the drag
  // survives leaving the 3px track).
  function startScrub(e) {
    const bar = e.target.closest && e.target.closest('.nv-progress');
    const card = cardAt(e.target);
    if (!bar || !card) return false;
    const video = card.querySelector('.nv-video');
    if (!video || !isFinite(video.duration) || video.duration <= 0) return false;
    clearLongPress();
    try { e.preventDefault(); } catch (err) {}
    card.classList.add('nv-scrubbing');
    const rect = bar.getBoundingClientRect();
    const prog = bar.querySelector('i');
    const apply = (clientX) => {
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / (rect.width || 1)));
      try { video.currentTime = ratio * video.duration; } catch (err) {}
      if (prog) prog.style.width = (ratio * 100) + '%';
    };
    apply(e.clientX);
    const move = ev => apply(ev.clientX);
    const up = () => {
      card.classList.remove('nv-scrubbing');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    return true;
  }

  function tryPlay(video) {
    if (!video) return;
    video.muted = !state.soundOn;
    const p = video.play();
    if (p && p.catch) {
      p.catch(() => {
        // Audible autoplay blocked (no gesture yet): start muted instead of
        // failing, and reflect it — the user's next tap turns sound back on.
        if (!video.muted) {
          video.muted = true;
          if (state.soundOn) { state.soundOn = false; syncSoundButton(); }
          try { video.play().catch(() => {}); } catch (e) {}
        }
      });
    }
  }

  function syncSoundButton() {
    const on = !!state.soundOn;
    const btn = el('nvSoundBtn');
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-label', on ? 'Mute' : 'Unmute');
    btn.innerHTML = '<i data-lucide="' + (on ? 'volume-2' : 'volume-x') + '" style="width:20px;height:20px;"></i>';
    if (window.lucide) window.lucide.createIcons();
  }

  // Sound is ON by default. If the browser blocks audible autoplay before the
  // first gesture, tryPlay falls back to muted and flips the button; one tap on
  // it re-enables audio for the whole feed (and it sticks for next time).
  function applySound() {
    const on = !!state.soundOn;
    syncSoundButton();
    document.querySelectorAll('.nv-video').forEach(v => { v.muted = !on; });
    if (on) {
      const feed = el('nvFeed');
      const cur = feed && feed.querySelector('.nv-card.nv-visible .nv-video');
      if (cur && cur.paused) tryPlay(cur);
    }
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    try { localStorage.setItem('nexa_videos_sound', state.soundOn ? '1' : '0'); } catch (e) {}
    applySound();
  }

  // Bump a view ONCE per session per video (protects the write quota — scrolling
  // back and forth must not write on every pass).
  function bumpView(id, uid) {
    if (!id || state.viewed.has(id)) return;
    if (uid && uid === myUid()) return; // don't count your own view
    state.viewed.add(id);
    try {
      window.db.collection('videos').doc(id).update({ views: fv().increment(1) }).catch(() => {});
    } catch (e) {}
  }

  function ensureLikedState(id, card) {
    if (state.likedMine[id] !== undefined) return;
    state.likedMine[id] = false;
    window.db.collection('videos').doc(id).collection('likes').doc(myUid()).get()
      .then(d => {
        state.likedMine[id] = d.exists;
        const btn = card.querySelector('.nv-rail-like');
        if (btn) btn.classList.toggle('liked', d.exists);
      })
      .catch(() => {});
  }

  function onFeedScroll() {
    const feed = el('nvFeed');
    if (!feed) return;
    if (feed.scrollTop + feed.clientHeight >= feed.scrollHeight - feed.clientHeight * 1.5) {
      loadOlder();
    }
  }

  // ── interactions ─────────────────────────────────────────────────────────
  function cardAt(node) {
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains('nv-card')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function onFeedClick(e) {
    const btn = e.target.closest && e.target.closest('[data-act]');
    if (btn) {
      e.stopPropagation();
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if (act === 'like') toggleLike(id, btn);
      else if (act === 'comment') openComments(id);
      else if (act === 'share') shareVideo(id);
      else if (act === 'save') toggleSave(id, btn);
      else if (act === 'edit') openEditVideo(id);
      else if (act === 'delete') deleteVideo(id);
      else if (act === 'follow') toggleFollow(btn.getAttribute('data-follow'), btn);
      return;
    }
    // Tap the video surface. Single tap = pause/play. Double tap: LEFT third
    // seeks back 10s, RIGHT third seeks forward 10s, CENTRE likes (the habit).
    const card = cardAt(e.target);
    if (!card) return;
    const id = card.getAttribute('data-id');
    const now = Date.now();
    const zone = tapZone(card, e.clientX);
    if (state.lastTapId === id && now - state.lastTapAt < DOUBLE_TAP_MS) {
      const prevZone = state.lastTapZone;
      state.lastTapAt = 0; state.lastTapId = null;
      const z = prevZone === 'c' ? zone : prevZone;
      if (z === 'l') seekBy(card, -SEEK_STEP);
      else if (z === 'r') seekBy(card, SEEK_STEP);
      else likeBurst(id, card);
      return;
    }
    state.lastTapAt = now; state.lastTapId = id; state.lastTapZone = zone;
    setTimeout(() => {
      if (state.lastTapAt !== now) return; // a second tap happened → it was a double
      togglePlay(card);
    }, DOUBLE_TAP_MS);
  }

  function tapZone(card, clientX) {
    try {
      const r = card.getBoundingClientRect();
      if (!r.width) return 'c';
      const x = (clientX - r.left) / r.width;
      if (x < 0.35) return 'l';
      if (x > 0.65) return 'r';
    } catch (e) {}
    return 'c';
  }

  function togglePlay(card) {
    const video = card.querySelector('.nv-video');
    if (!video) return;
    attachVideoTime(card, video);
    if (video.paused) { tryPlay(video); card.classList.add('nv-playing'); }
    else { try { video.pause(); } catch (e) {} card.classList.add('nv-paused'); }
    card.classList.toggle('nv-paused', video.paused);
    clearTimeout(card._hintT);
    card._hintT = setTimeout(() => card.classList.remove('nv-paused'), 700);
  }

  function likeBurst(id, card) {
    if (!state.likedMine[id]) {
      // double-tap always likes (never unlikes)
      doLike(id, true);
    }
    const heart = card.querySelector('.nv-heart');
    if (heart) {
      heart.classList.remove('nv-heart-pop');
      void heart.offsetWidth;
      heart.classList.add('nv-heart-pop');
      setTimeout(() => heart.classList.remove('nv-heart-pop'), 900);
    }
    const btn = card.querySelector('.nv-rail-like');
    if (btn) btn.classList.add('liked');
  }

  function toggleLike(id, btn) {
    const liked = !state.likedMine[id];
    doLike(id, liked);
    if (btn) btn.classList.toggle('liked', liked);
  }

  // The per-user marker and the denormalised count move TOGETHER in one
  // transaction, so a double-tap can't double-count and a failed write can't
  // leave the badge ahead of the server. Optimistic paint first for feel; the
  // next feed snapshot then reconciles the number to the truth.
  function doLike(id, liked) {
    state.likedMine[id] = liked;
    const vidRef = window.db.collection('videos').doc(id);
    const likeRef = vidRef.collection('likes').doc(myUid());
    const countEl = el('nvLikeCount-' + id);
    const prev = countEl ? parseCount(countEl.textContent) : 0;
    if (countEl) countEl.textContent = fmtCount(Math.max(0, prev + (liked ? 1 : -1)));
    const paintBtn = (on) => {
      const b = document.querySelector('.nv-rail-like[data-id="' + id + '"]');
      if (b) b.classList.toggle('liked', on);
    };
    paintBtn(liked);
    window.db.runTransaction(tx => tx.get(likeRef).then(d => {
      const has = d.exists;
      if (liked && !has) { tx.set(likeRef, { at: Date.now() }); tx.update(vidRef, { likes: fv().increment(1) }); }
      else if (!liked && has) { tx.delete(likeRef); tx.update(vidRef, { likes: fv().increment(-1) }); }
    })).then(() => {
      // Tell the author (never yourself, never on an unlike).
      if (liked) notifyVideoAuthor(id, 'liked your video', { isVideoLike: true });
      // Mirror the like onto users/{me}/liked_videos so a profile's "Liked"
      // grid renders from a small per-user subcollection (no collection-group
      // query). Cosmetic cache — a miss just means the grid is stale.
      try {
        const mirror = window.db.collection('users').doc(myUid()).collection('liked_videos').doc(id);
        if (liked) {
          const v = findVideo(id) || {};
          mirror.set({
            videoId: id, uid: v.uid || '', caption: v.caption || '',
            thumbUrl: v.thumbUrl || '', videoUrl: v.videoUrl || '',
            at: Date.now(),
            // Denormalised so the profile "Liked" grid tiles can show the
            // view + like counts without a read per tile.
            views: Number(v.views) || 0, likes: Number(v.likes) || 0
          }).catch(() => {});
        } else {
          mirror.delete().catch(() => {});
        }
      } catch (e) {}
    }).catch(err => {
      console.warn('like failed', err && err.message);
      state.likedMine[id] = !liked;
      if (countEl) countEl.textContent = fmtCount(prev);
      paintBtn(!liked);
      toast('Could not update like', 'error');
    });
  }

  // "1.2K" → 1200 (so an optimistic +1/-1 stays sane)
  function parseCount(s) {
    s = String(s).trim();
    if (/K$/i.test(s)) return Math.round(parseFloat(s) * 1e3);
    if (/M$/i.test(s)) return Math.round(parseFloat(s) * 1e6);
    return parseInt(s, 10) || 0;
  }

  // Follow / unfollow straight from the feed. Delegates the write to
  // nexaToggleFollow (so the counts + notification stay in one place) and paints
  // the button optimistically so the tap feels instant.
  function toggleFollow(uid, btn) {
    if (!uid) return;
    if (uid === myUid()) return;
    if (state.followBusy[uid]) return;
    state.followBusy[uid] = true;
    const following = relationshipWith(uid).following === 'accepted';
    const paint = (f) => {
      if (!btn) return;
      btn.classList.toggle('following', f);
      btn.textContent = f ? 'Following' : 'Follow';
    };
    paint(!following);
    const done = () => {
      // The write succeeded, so the state is now the opposite of before. Record
      // it as an override (the listener will confirm shortly) and repaint.
      state.followBusy[uid] = false;
      state.followOverride[uid] = !following;
      paint(!following);
      syncFollowButtons();
    };
    const fail = () => { state.followBusy[uid] = false; paint(following); };
    if (typeof window.nexaToggleFollow === 'function') {
      Promise.resolve(window.nexaToggleFollow(uid)).then(done, fail);
    } else {
      fail();
    }
  }

  function toggleSave(id, btn) {
    btn.classList.toggle('saved');
    const saved = btn.classList.contains('saved');
    window.db.collection('videos').doc(id).update({ saves: fv().increment(saved ? 1 : -1) })
      .catch(() => {});
    toast(saved ? 'Saved' : 'Removed from saved', 'success');
  }

  // The share link points at the watch.html landing (canonical host) so it
  // opens the ACTUAL video on another device — not the app's home screen.
  function shareUrlFor(id) { return SHARE_ORIGIN + '/watch.html?v=' + encodeURIComponent(id); }

  // The badge label is ROUNDED ("1.2k"), so re-parsing it to do +1 is lossy —
  // that is why repeated shares used to appear to do nothing. Keep the exact
  // number per video: seeded from the server value, then advanced by one.
  function exactShares(v) {
    if (!v) return 0;
    if (state.sharesExact[v.id] === undefined) state.sharesExact[v.id] = Number(v.shares) || 0;
    return state.sharesExact[v.id];
  }
  function paintShares(id) {
    const c = el('nvShareCount-' + id);
    if (c) c.textContent = fmtCount(state.sharesExact[id] || 0);
  }

  // One place that advances the count, repaints and tells the author.
  function bumpShare(id) {
    state.sharesExact[id] = exactShares(findVideo(id)) + 1;
    paintShares(id);
    window.db.collection('videos').doc(id).update({ shares: fv().increment(1) }).catch(() => {});
    notifyVideoAuthor(id, 'shared your video', { isVideoShare: true });
  }

  // Notify the video's author about an interaction — never yourself, and never
  // when the author is unknown. Best-effort (a push failure must not break the
  // interaction that triggered it).
  function notifyVideoAuthor(id, what, flags) {
    try {
      const v = findVideo(id);
      const target = v && v.uid;
      if (!target || target === myUid() || !window.sendPushNotification) return;
      window.sendPushNotification(myName(), what, target, Object.assign({ isVideo: true, chatUid: myUid(), videoId: id }, flags || {}));
    } catch (e) { /* non-fatal */ }
  }

  function shareVideo(id) {
    // A double tap on the share button must not open two OS sheets or count
    // twice: ignore any tap while a share for this video is still in flight.
    if (state.sharing[id]) return;
    const v = state.videos.find(x => x.id === id) || state.myVideos.find(x => x.id === id);
    const url = shareUrlFor(id);
    const text = (v && v.caption) ? v.caption : 'Watch this video on Nexa';

    // Count ONLY when a share really completed — cancelling the OS sheet or a
    // failed clipboard write must not inflate the number.
    const countShare = () => bumpShare(id);
    const clearInFlight = () => { state.sharing[id] = false; };

    if (navigator.share) {
      state.sharing[id] = true;
      navigator.share({ title: 'Nexa', text: text, url: url })
        .then(() => { countShare(); toast('Shared', 'success'); })
        .catch(err => {
          // A deliberate dismiss is not a failure; anything else means the
          // share did NOT happen, so fall back to copying instead of dying
          // silently (the "I tap share and nothing happens" report).
          if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
          copyShareFallback(id, text + ' ' + url);
        })
        .then(clearInFlight, clearInFlight);
    } else {
      copyShareFallback(id, text + ' ' + url);
    }
  }

  function copyShareFallback(id, payload) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload)
        .then(() => { toast('Link copied', 'success'); bumpShare(id); })
        .catch(() => toast('Could not copy the link', 'error'));
      return;
    }
    // Last resort: a hidden textarea + execCommand so desktop browsers without
    // the async clipboard API still get a usable copy instead of nothing.
    try {
      const ta = document.createElement('textarea');
      ta.value = payload;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      if (ok) { toast('Link copied', 'success'); bumpShare(id); return; }
    } catch (e) {}
    toast('Sharing is not supported on this device', 'error');
  }

  // Remove a subcollection in <=400-doc batches. Best-effort: the video doc
  // delete is what matters, and orphaned sub-docs are unreachable once the
  // parent is gone.
  async function purgeSub(ref, name) {
    try {
      const snap = await ref.collection(name).limit(400).get();
      if (snap.empty) return;
      const batch = window.db.batch();
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
    } catch (e) { console.warn('purge ' + name + ' failed', e && e.message); }
  }

  async function deleteVideo(id) {
    const ok = window.nexaConfirm
      ? await window.nexaConfirm('Delete this video? This cannot be undone.',
          { title: 'Delete video?', okLabel: 'Delete', danger: true })
      : window.confirm('Delete this video?');
    if (!ok) return;
    try {
      const ref = window.db.collection('videos').doc(id);
      await purgeSub(ref, 'comments');
      await purgeSub(ref, 'likes');
      await ref.delete();
      state.videos = state.videos.filter(v => v.id !== id);
      state.myVideos = state.myVideos.filter(v => v.id !== id);
      const card = document.querySelector('.nv-card[data-id="' + id + '"]');
      if (card) card.remove();
      if (!state.videos.length) renderEmpty('No videos yet. Be the first to post one!');
      toast('Video deleted', 'success');
      if (el('nvMyVideosList')) renderMyVideos();
    } catch (err) { toast('Could not delete video', 'error'); console.warn(err); }
  }

  // ── long-press: playback speed ───────────────────────────────────────────
  let _lpTimer = null;
  const SPEEDS = [0.5, 1, 1.5, 2];
  function onFeedPointerDown(e) {
    if (e.target.closest && e.target.closest('.nv-progress')) { startScrub(e); return; }
    const card = cardAt(e.target);
    if (!card || (e.target.closest && e.target.closest('[data-act]'))) return;
    clearLongPress();
    _lpTimer = setTimeout(() => {
      _lpTimer = null;
      const video = card.querySelector('.nv-video');
      if (!video) return;
      const cur = video.playbackRate || 1;
      const idx = SPEEDS.indexOf(cur);
      const next = SPEEDS[(idx + 1) % SPEEDS.length];
      video.playbackRate = next;
      showSpeedPill(card, next);
    }, 550);
  }
  function onFeedPointerUp() { clearLongPress(); }
  function clearLongPress() { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } }
  function showSpeedPill(card, rate) {
    let pill = card.querySelector('.nv-speed-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'nv-speed-pill';
      card.appendChild(pill);
    }
    pill.textContent = rate + 'x';
    pill.classList.add('show');
    clearTimeout(pill._t);
    pill._t = setTimeout(() => pill.classList.remove('show'), 900);
  }

  // ── comments sheet ───────────────────────────────────────────────────────
  function openComments(id) {
    const v = state.videos.find(x => x.id === id);
    state.commentsVideoId = id;
    let sheet = el('nvCommentsSheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'nvCommentsSheet';
      sheet.className = 'nv-sheet-overlay';
      sheet.setAttribute('onclick', 'nexaVideosBackdropClick(event)');
      sheet.innerHTML =
        '<div class="nv-sheet" onclick="event.stopPropagation()">' +
          '<div class="nv-sheet-grab"></div>' +
          '<div class="nv-sheet-head"><span id="nvCommentsTitle">Comments</span>' +
            '<button class="nv-sheet-close" onclick="nexaVideosCloseComments()">' +
              '<i data-lucide="x" style="width:16px;height:16px;"></i></button></div>' +
          '<div class="nv-comments" id="nvCommentsList"></div>' +
          '<div class="nv-comment-reply-chip" id="nvCommentReplyChip" style="display:none;">' +
            '<span id="nvCommentReplyText"></span>' +
            '<button onclick="nexaVideosCancelCommentReply()" aria-label="Cancel reply">' +
              '<i data-lucide="x" style="width:14px;height:14px;"></i></button>' +
          '</div>' +
          '<div class="nv-comment-input">' +
            '<img class="nv-comment-me" src="' + esc(safeUrl(myPhoto())) + '" alt="">' +
            '<input id="nvCommentInput" type="text" maxlength="500" placeholder="Add a comment…" autocomplete="off">' +
            '<button id="nvCommentSend" onclick="nexaVideosSendComment()">' +
              '<i data-lucide="send" style="width:17px;height:17px;"></i></button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(sheet);
      const inp = el('nvCommentInput');
      if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') nexaVideosSendComment(); });
      if (window.lucide) window.lucide.createIcons();
    }
    sheet.classList.add('active');
    loadComments(id);
  }

  function loadComments(id) {
    if (state.commentsUnsub) { try { state.commentsUnsub(); } catch (e) {} state.commentsUnsub = null; }
    state.commentItems = [];
    state.likedComments = {};
    state.checkedCommentLikes = {};
    state.expandedThreads = {};
    cancelCommentReply();
    const list = el('nvCommentsList');
    if (list) list.innerHTML = '<div class="nv-comments-empty">Loading…</div>';
    state.commentsUnsub = window.db.collection('videos').doc(id).collection('comments')
      .orderBy('createdAt', 'asc').limit(COMMENTS_PAGE)
      .onSnapshot(snap => {
        const items = [];
        snap.forEach(d => items.push(Object.assign({ id: d.id }, d.data())));
        state.commentItems = items;
        renderComments(false);
        // One batched read for my like markers on THIS video's comments (no
        // per-comment get) — then re-render once so the hearts settle.
        const ids = items.map(c => c.id);
        if (ids.length) refreshMyCommentLikes(id, ids);
      }, err => {
        console.warn('comments listener error', err && err.message);
        if (window.nexaNoteQuotaError) window.nexaNoteQuotaError(err);
      });
  }

  function refreshMyCommentLikes(videoId, ids) {
    // Only resolve markers we haven't already looked up this open — a busy video
    // re-snapshots on every new comment, and re-querying the same ids each time
    // would burn reads for nothing.
    ids = ids.filter(cid => !state.checkedCommentLikes[cid]);
    if (!ids.length) return;
    ids.forEach(cid => { state.checkedCommentLikes[cid] = true; });
    const chunks = [];
    for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
    Promise.all(chunks.map(chunk => window.db.collection('videos').doc(videoId)
      .collection('comment_likes')
      .where('uid', '==', myUid())
      .where('cid', 'in', chunk)
      .get()
      .catch(() => ({ forEach() {} }))))
      .then(snaps => {
        snaps.forEach(sn => sn.forEach && sn.forEach(d => {
          const data = d.data ? d.data() : {};
          if (data && data.cid) state.likedComments[data.cid] = true;
        }));
        renderComments(false);
      });
  }

  // Reply threads are grouped client-side (replyTo) so a comment and its
  // replies read top-to-bottom in one pass — no extra Firestore collection.
  function buildCommentTree(items) {
    const byId = {};
    items.forEach(c => { byId[c.id] = c; });
    const top = [], replies = {};
    items.forEach(c => {
      const parent = c.replyTo;
      if (parent && byId[parent]) { (replies[parent] = replies[parent] || []).push(c); }
      else { top.push(c); }   // orphaned replies fall back to top level
    });
    return { top, replies };
  }

  function renderComments(scroll) {
    const listEl = el('nvCommentsList');
    if (!listEl) return;
    const items = state.commentItems || [];
    if (!items.length) { listEl.innerHTML = '<div class="nv-comments-empty">No comments yet. Say something nice!</div>'; return; }
    const tree = buildCommentTree(items);
    const html = tree.top.map(c => {
      const reps = tree.replies[c.id] || [];
      if (!reps.length) return commentHtml(c);
      // Replies are collapsed behind a "View N replies" toggle so a busy thread
      // doesn't bury the rest of the comments. Expansion is per-thread and
      // resets on open (state.expandedThreads).
      const open = !!state.expandedThreads[c.id];
      const count = reps.length;
      const toggle =
        '<button class="nv-comment-viewreplies" data-thread="' + esc(c.id) + '" onclick="nexaVideosToggleReplies(\'' + esc(c.id) + '\')" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<span class="nv-comment-viewreplies-arrow">' + (open ? '\u25BE' : '\u25B8') + '</span>' +
          '<span class="nv-comment-viewreplies-label">' + (open ? 'Hide replies' : 'View ' + count + (count === 1 ? ' reply' : ' replies')) + '</span>' +
        '</button>';
      const kids = '<div class="nv-comment-replies"' + (open ? '' : ' style="display:none;"') + '>' +
        reps.map(r => commentHtml(r, c)).join('') + '</div>';
      return '<div class="nv-thread">' + commentHtml(c) + toggle + kids + '</div>';
    }).join('');
    listEl.innerHTML = html;
    if (scroll) listEl.scrollTop = listEl.scrollHeight;
    if (window.lucide) window.lucide.createIcons();
  }

  // Expand / collapse a thread's replies (per-thread, in-memory for this open).
  function toggleReplies(cid) {
    if (!cid) return;
    if (state.expandedThreads[cid]) delete state.expandedThreads[cid];
    else state.expandedThreads[cid] = true;
    renderComments(false);
  }

  function commentLikesText(n) {
    n = Number(n) || 0;
    if (!n) return '';
    return '<span class="nv-comment-likes-n">' + n + '</span>';
  }

  function commentHtml(c, parent) {
    const mine = c.uid === myUid();
    const liked = !!state.likedComments[c.id];
    const likes = Number(c.likes) || 0;
    const reply = parent
      ? '<span class="nv-comment-replyto">@' + esc(parent.name || 'user') + '</span> '
      : '';
    return '<div class="nv-comment' + (parent ? ' nv-comment-child' : '') + '" data-id="' + esc(c.id) + '">' +
      '<img class="nv-comment-pic" src="' + esc(safeUrl(c.photo || 'https://i.imgur.com/HeIi0wU.png')) + '" alt="">' +
      '<div class="nv-comment-body">' +
        '<div class="nv-comment-top"><span class="nv-comment-name">' + esc(c.name || 'user') + '</span>' +
          '<span class="nv-comment-time">' + esc(timeAgo(Number(c.createdAt))) + '</span></div>' +
        '<div class="nv-comment-text">' + reply + esc(c.text || '') + '</div>' +
        '<div class="nv-comment-acts">' +
          '<button class="nv-comment-act nv-comment-like' + (liked ? ' liked' : '') + '"' +
            ' onclick="nexaVideosLikeComment(\'' + esc(c.id) + '\')" aria-label="Like comment">' +
            '<i data-lucide="heart" style="width:14px;height:14px;"></i>' + commentLikesText(likes) + '</button>' +
          '<button class="nv-comment-act" onclick="nexaVideosReplyComment(\'' + esc(c.id) + '\')" aria-label="Reply">Reply</button>' +
          '<button class="nv-comment-act" onclick="nexaVideosCopyComment(\'' + esc(c.id) + '\')" aria-label="Copy">Copy</button>' +
          (mine ? '<button class="nv-comment-act nv-comment-del" onclick="nexaVideosDeleteComment(\'' + esc(c.id) + '\')" aria-label="Delete">Delete</button>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // Copy arbitrary text — the same clipboard + execCommand fallback the share
  // path uses, so desktop browsers without the async clipboard still work.
  function copyText(payload, okMsg, errMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload)
        .then(() => toast(okMsg || 'Copied', 'success'))
        .catch(() => toast(errMsg || 'Could not copy', 'error'));
      return;
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = payload;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      if (ok) { toast(okMsg || 'Copied', 'success'); return; }
    } catch (e) {}
    toast(errMsg || 'Copy is not supported on this device', 'error');
  }

  function copyComment(cid) {
    const c = (state.commentItems || []).find(x => x.id === cid);
    if (!c) return;
    copyText(c.text || '', 'Comment copied', 'Could not copy the comment');
  }

  function likeComment(cid) {
    const id = state.commentsVideoId;
    if (!id || !cid) return;
    const liked = !!state.likedComments[cid];
    const ref = window.db.collection('videos').doc(id).collection('comments').doc(cid);
    const likeRef = window.db.collection('videos').doc(id).collection('comment_likes').doc(cid + '_' + myUid());
    const items = state.commentItems || [];
    const c = items.find(x => x.id === cid);
    if (!c) return;
    const next = liked ? Math.max(0, (Number(c.likes) || 0) - 1) : (Number(c.likes) || 0) + 1;
    // Optimistic — re-render keeps scroll position (renderComments(false)).
    c.likes = next;
    if (liked) delete state.likedComments[cid]; else state.likedComments[cid] = true;
    renderComments(false);
    window.db.runTransaction(tx => tx.get(ref).then(doc => {
      if (!doc.exists) return;
      const cur = Number(doc.data().likes) || 0;
      tx.update(ref, { likes: liked ? Math.max(0, cur - 1) : cur + 1 });
      if (liked) tx.delete(likeRef); else tx.set(likeRef, { uid: myUid(), cid: cid, at: Date.now() });
    })).catch(err => {
      console.warn('comment like failed', err);
      c.likes = liked ? (Number(c.likes) || 0) + 1 : Math.max(0, (Number(c.likes) || 0) - 1);
      if (liked) state.likedComments[cid] = true; else delete state.likedComments[cid];
      renderComments(false);
      toast('Could not update like', 'error');
    });
  }

  function replyComment(cid) {
    const items = state.commentItems || [];
    const c = items.find(x => x.id === cid);
    if (!c) return;
    // Reveal the thread so the user sees where the reply will land (walk up to
    // the top-level ancestor; the renderer shows one level of replies).
    const byId = {};
    items.forEach(x => { byId[x.id] = x; });
    let root = c, guard = 0;
    while (root.replyTo && byId[root.replyTo] && guard++ < 20) root = byId[root.replyTo];
    if (!state.expandedThreads[root.id]) {
      state.expandedThreads[root.id] = true;
      renderComments(false);
    }
    state.commentReplyTo = { id: cid, name: c.name || 'user', uid: c.uid };
    const chip = el('nvCommentReplyChip');
    const txt = el('nvCommentReplyText');
    if (txt) txt.textContent = 'Replying to @' + (c.name || 'user');
    if (chip) chip.style.display = 'flex';
    const inp = el('nvCommentInput');
    if (inp) inp.focus();
  }

  function cancelCommentReply() {
    state.commentReplyTo = null;
    const chip = el('nvCommentReplyChip');
    if (chip) chip.style.display = 'none';
  }

  function sendComment() {
    const id = state.commentsVideoId;
    const inp = el('nvCommentInput');
    if (!id || !inp) return;
    const text = (inp.value || '').trim();
    if (!text) return;
    const reply = state.commentReplyTo;
    const doc = {
      uid: myUid(), name: myName(), photo: myPhoto(), text: text,
      createdAt: Date.now(), likes: 0
    };
    if (reply && reply.id) { doc.replyTo = reply.id; doc.replyToName = reply.name || 'user'; doc.replyToUid = reply.uid || null; }
    inp.value = '';
    cancelCommentReply();
    window.db.collection('videos').doc(id).collection('comments').add(doc).then(() => {
      window.db.collection('videos').doc(id).update({ commentsCount: fv().increment(1) }).catch(() => {});
      const c = el('nvCommentCount-' + id);
      if (c) c.textContent = fmtCount(parseCount(c.textContent) + 1);
      // Notify the person you replied to (or the video's author for a top-level
      // comment). Best-effort; the sender-side push costs no Firestore writes.
      const v = findVideo(id);
      const target = (reply && reply.uid) ? reply.uid : (v && v.uid);
      if (target && target !== myUid() && window.sendPushNotification) {
        window.sendPushNotification(myName(), (reply ? 'replied to your comment' : 'commented on your video'), target, { isVideo: true, isVideoComment: true, chatUid: myUid(), videoId: id });
      }
    }).catch(err => { toast('Could not post comment', 'error'); console.warn(err); });
  }

  function deleteComment(cid) {
    const id = state.commentsVideoId;
    if (!id) return;
    // Like markers are keyed <cid>_<uid>; only each liker may delete their own
    // (least privilege), so the author deleting a comment drops only their own
    // marker here. Other likers' orphaned markers are harmless — they are looked
    // up by cid and the comment is gone.
    const myMarker = window.db.collection('videos').doc(id).collection('comment_likes').doc(cid + '_' + myUid());
    myMarker.delete().catch(() => {});
    window.db.collection('videos').doc(id).collection('comments').doc(cid).delete()
      .then(() => {
        window.db.collection('videos').doc(id).update({ commentsCount: fv().increment(-1) }).catch(() => {});
        const c = el('nvCommentCount-' + id);
        if (c) c.textContent = fmtCount(Math.max(0, parseCount(c.textContent) - 1));
      })
      .catch(() => toast('Could not delete comment', 'error'));
  }

  function closeComments() {
    const sheet = el('nvCommentsSheet');
    if (sheet) sheet.classList.remove('active');
    if (state.commentsUnsub) { try { state.commentsUnsub(); } catch (e) {} state.commentsUnsub = null; }
    state.commentsVideoId = null;
    state.commentItems = [];
    state.likedComments = {};
    state.checkedCommentLikes = {};
    state.expandedThreads = {};
    cancelCommentReply();
  }

  function backdropClick(e) {
    if (e.target && e.target.id === 'nvCommentsSheet') closeComments();
  }

  // ── composer ─────────────────────────────────────────────────────────────
  function openComposer() {
    let box = el('nvComposer');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nvComposer';
      box.className = 'nv-composer-overlay';
      box.setAttribute('onclick', 'nexaVideosComposerBackdrop(event)');
      box.innerHTML =
        '<div class="nv-composer" onclick="event.stopPropagation()">' +
          '<div class="nv-composer-head">' +
            '<button class="nv-composer-cancel" onclick="nexaVideosCloseComposer()">Cancel</button>' +
            '<span class="nv-composer-title">New Video</span>' +
            '<button class="nv-composer-post" id="nvComposerPost" onclick="nexaVideosPost()">Post</button>' +
          '</div>' +
          '<div class="nv-composer-stage" id="nvComposerStage">' +
            '<div class="nv-composer-pick" id="nvComposerPick" onclick="nexaVideosPickFile()">' +
              '<div class="nv-pick-ic"><i data-lucide="video" style="width:40px;height:40px;"></i></div>' +
              '<div class="nv-pick-title">Select a video</div>' +
              '<div class="nv-pick-sub">From your gallery or camera · up to ' + MAX_VIDEO_MIN + ' min · max ' + MAX_VIDEO_MB + ' MB</div>' +
            '</div>' +
            '<video class="nv-composer-preview" id="nvComposerPreview" playsinline loop style="display:none;"></video>' +
            '<button class="nv-composer-mute" id="nvComposerMute" onclick="nexaVideosTogglePreviewSound()" aria-label="Toggle preview sound" style="display:none;">' +
              '<i data-lucide="volume-2" style="width:18px;height:18px;"></i></button>' +
            '<div class="nv-composer-dur" id="nvComposerDur" style="display:none;"></div>' +
            '<div class="nv-upload-ring" id="nvUploadRing" style="display:none;">' +
              '<svg viewBox="0 0 120 120"><circle class="nv-ring-track" cx="60" cy="60" r="52"></circle>' +
              '<circle class="nv-ring-fill" id="nvRingFill" cx="60" cy="60" r="52"></circle></svg>' +
              '<div class="nv-ring-pct" id="nvRingPct">0%</div>' +
              '<div class="nv-ring-stage" id="nvRingStage"></div>' +
            '</div>' +
          '</div>' +
          '<div class="nv-composer-fields">' +
            '<textarea id="nvComposerCaption" rows="2" maxlength="300" placeholder="Write a caption…"></textarea>' +
          '</div>' +
          '<input type="file" id="nvFileInput" accept="video/*" hidden>' +
        '</div>';
      document.body.appendChild(box);
      const fi = el('nvFileInput');
      fi.addEventListener('change', onFileChosen);
      if (window.lucide) window.lucide.createIcons();
    }
    state.pendingFile = null;
    state.pendingDuration = 0;
    state.pendingDurationMs = 0;
    state.pendingTooLong = false;
    state.pendingTooBig = false;
    const prev = el('nvComposerPreview');
    if (prev) { prev.style.display = 'none'; prev.muted = false; prev.removeAttribute('src'); }
    const muteBtn = el('nvComposerMute'); if (muteBtn) muteBtn.style.display = 'none';
    const durBox = el('nvComposerDur'); if (durBox) { durBox.style.display = 'none'; durBox.textContent = ''; }
    const pick = el('nvComposerPick');
    if (pick) pick.style.display = '';
    const cap = el('nvComposerCaption'); if (cap) cap.value = '';
    setRing(false, 0, '');
    // Silence any feed clip behind the overlay so you don't hear two at once.
    const feed = el('nvFeed');
    if (feed) feed.querySelectorAll('.nv-video').forEach(v => { try { v.pause(); } catch (e) {} });
    box.classList.add('active');
  }

  // The composer preview is a LOOPING <video>. Hiding the overlay with
  // display:none does NOT stop media, so without an explicit teardown the clip
  // keeps playing (and looping) after the composer is dismissed — the "I still
  // hear the video after leaving" bug.
  function pausePreview() {
    const prev = el('nvComposerPreview');
    if (prev && !prev.paused) { try { prev.pause(); } catch (e) {} }
  }
  function teardownPreview() {
    const prev = el('nvComposerPreview');
    if (prev) {
      try { prev.pause(); } catch (e) {}
      prev.muted = true;
      try { prev.removeAttribute('src'); prev.load(); } catch (e) {}
    }
    if (state.previewObjectUrl) {
      try { if (typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(state.previewObjectUrl); } catch (e) {}
      state.previewObjectUrl = null;
    }
  }
  // Re-start whichever feed clip was on screen before the composer covered it.
  function resumeActiveCard() {
    const feed = el('nvFeed');
    if (!feed || !state.activeId) return;
    const card = feed.querySelector('.nv-card[data-id="' + sid(state.activeId) + '"]');
    const video = card && card.querySelector('.nv-video');
    if (video && video.paused) tryPlay(video);
  }

  function closeComposer() {
    const box = el('nvComposer');
    if (box) box.classList.remove('active');
    teardownPreview();
    resumeActiveCard();
  }

  function composerBackdrop(e) {
    if (e.target && e.target.id === 'nvComposer') closeComposer();
  }

  function pickFile() {
    const fi = el('nvFileInput');
    if (fi) fi.click();
  }

  function onFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^video\//.test(file.type)) { toast('Please choose a video file', 'error'); return; }
    if (file.size > MAX_VIDEO_BYTES) {
      const mb = Math.round(file.size / (1024 * 1024));
      toast('Video is ' + mb + ' MB … the max is ' + MAX_VIDEO_MB +
        ' MB. Please trim it and try again.', 'error');
      state.pendingFile = null;
      state.pendingTooBig = true;
      state.pendingTooLong = false;
      state.pendingDurationMs = 0;
      const postBtn = el('nvComposerPost');
      if (postBtn) postBtn.disabled = true;
      return;
    }
    state.pendingFile = file;
    state.pendingTooBig = false;
    state.pendingTooLong = false;
    state.pendingDurationMs = 0;
    const prev = el('nvComposerPreview');
    const pick = el('nvComposerPick');
    if (pick) pick.style.display = 'none';
    if (prev) {
      if (state.previewObjectUrl) { try { URL.revokeObjectURL(state.previewObjectUrl); } catch (e) {} }
      state.previewObjectUrl = URL.createObjectURL(file);
      prev.src = state.previewObjectUrl;
      prev.style.display = '';
      prev.muted = false; // hear what you are about to post
      prev.load();
      prev.play().catch(() => {
        // Audible autoplay refused → start muted and reflect it on the toggle.
        prev.muted = true;
        const mb = el('nvComposerMute');
        if (mb) mb.innerHTML = '<i data-lucide="volume-x" style="width:18px;height:18px;"></i>';
        if (window.lucide) window.lucide.createIcons();
        try { prev.play().catch(() => {}); } catch (e) {}
      });
      const muteBtn = el('nvComposerMute'); if (muteBtn) muteBtn.style.display = 'flex';
      prev.onloadedmetadata = () => {
        const durMs = Math.round((prev.duration || 0) * 1000);
        state.pendingDurationMs = durMs;
        state.pendingDuration = Math.round(prev.duration || 0);
        state.pendingTooLong = durMs > MAX_VIDEO_MS;
        const durBox = el('nvComposerDur');
        if (durBox) {
          durBox.style.display = '';
          durBox.textContent = fmtDur(durMs) + ' · ' + Math.max(1, Math.round(file.size / (1024 * 1024))) + ' MB';
        }
        const postBtn = el('nvComposerPost');
        if (state.pendingTooLong) {
          toast('Video is ' + fmtDur(durMs) + ' … the max is ' + MAX_VIDEO_MIN +
            ' min. Please trim it.', 'error');
          if (postBtn) postBtn.disabled = true;
        } else if (postBtn && !state.posting) {
          postBtn.disabled = false;
        }
      };
    }
  }

  function togglePreviewSound() {
    const prev = el('nvComposerPreview');
    if (!prev) return;
    prev.muted = !prev.muted;
    const btn = el('nvComposerMute');
    if (btn) {
      btn.innerHTML = '<i data-lucide="' + (prev.muted ? 'volume-x' : 'volume-2') + '" style="width:18px;height:18px;"></i>';
      if (window.lucide) window.lucide.createIcons();
    }
    if (!prev.muted) { try { prev.play().catch(() => {}); } catch (e) {} }
  }

  function setRing(active, pct, stage) {
    const ring = el('nvUploadRing');
    const fill = el('nvRingFill');
    const label = el('nvRingPct');
    const stageEl = el('nvRingStage');
    if (!ring) return;
    ring.style.display = active ? 'flex' : 'none';
    const CIRC = 2 * Math.PI * 52;
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    if (fill) {
      fill.style.strokeDasharray = String(CIRC);
      fill.style.strokeDashoffset = String(CIRC * (1 - p / 100));
    }
    // The number is ALWAYS the ring centre (it must visibly read to 100%); the
    // stage is a caption underneath so "Uploading…" no longer hides the %.
    if (label) label.textContent = p + '%';
    if (stageEl) stageEl.textContent = stage || '';
  }

  function post() {
    if (state.posting) return;
    if (!state.pendingFile) { toast('Pick a video first', 'error'); pickFile(); return; }
    if (state.pendingTooLong) {
      toast('Video is longer than ' + MAX_VIDEO_MIN + ' min … please trim it.', 'error');
      return;
    }
    if (state.pendingTooBig) {
      toast('Video is over ' + MAX_VIDEO_MB + ' MB … please trim it.', 'error');
      return;
    }
    const capEl = el('nvComposerCaption');
    const caption = (capEl && capEl.value || '').trim();
    state.posting = true;
    const postBtn = el('nvComposerPost');
    if (postBtn) { postBtn.disabled = true; postBtn.textContent = 'Posting…'; }
    setRing(true, 0, 'Uploading…');

    // Real byte progress 0->99 while uploading (never 100 until the bytes are
    // actually on the server), then 100 for the "Posting…" write and "Posted!".
    window.uploadFile(state.pendingFile, (pct) => { setRing(true, Math.min(99, pct), 'Uploading…'); })
      .then(url => {
        setRing(true, 100, 'Posting…');
        const thumb = cloudThumb(url);
        return window.db.collection('videos').add({
          uid: myUid(),
          authorName: myName(),
          authorPhoto: myPhoto(),
          videoUrl: url,
          thumbUrl: thumb,
          caption: caption,
          duration: state.pendingDuration,
          createdAt: Date.now(),
          views: 0, likes: 0, commentsCount: 0, shares: 0, saves: 0,
          visibility: 'public'
        });
      })
      .then(() => {
        setRing(true, 100, 'Posted!');
        // No push on publish: posting a video is not an event your connections
        // need to be interrupted for. They are notified about LIKES, COMMENTS,
        // SHARES and new FOLLOWERS instead.
        return new Promise(r => setTimeout(r, 320));
      })
      .then(() => {
        setRing(false, 0, '');
        closeComposer();
        toast('✓ Video posted!', 'success');
        const feed = el('nvFeed');
        if (feed) feed.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(err => {
        console.warn('video post failed', err);
        setRing(false, 0, '');
        toast(err && err.message ? ('Upload failed: ' + err.message) : 'Upload failed', 'error');
      })
      .finally(() => {
        state.posting = false;
        const b = el('nvComposerPost');
        if (b) { b.disabled = false; b.textContent = 'Post'; }
      });
  }

  // ── edit (caption) ──
  function findVideo(id) {
    return state.videos.find(x => x.id === id) || state.myVideos.find(x => x.id === id) || null;
  }

  function openEditVideo(id) {
    const v = findVideo(id);
    if (!v) { toast('Video not found', 'error'); return; }
    let sheet = el('nvEditSheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'nvEditSheet';
      sheet.className = 'nv-sheet-overlay';
      sheet.setAttribute('onclick', 'nexaVideosEditBackdrop(event)');
      sheet.innerHTML =
        '<div class="nv-sheet" onclick="event.stopPropagation()">' +
          '<div class="nv-sheet-grab"></div>' +
          '<div class="nv-sheet-head"><span>Edit video</span>' +
            '<button class="nv-sheet-close" onclick="nexaVideosCloseEdit()">' +
              '<i data-lucide="x" style="width:16px;height:16px;"></i></button></div>' +
          '<div class="nv-edit-body">' +
            '<label class="nv-edit-label">Caption</label>' +
            '<textarea id="nvEditCaption" rows="3" maxlength="300" placeholder="Write a caption…"></textarea>' +
            '<div class="nv-edit-note">The clip itself can’t be changed … delete and re-post to swap the video.</div>' +
            '<button class="nv-edit-save" id="nvEditSave" onclick="nexaVideosSaveEdit()">Save changes</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(sheet);
      if (window.lucide) window.lucide.createIcons();
    }
    state.editVideoId = id;
    const cap = el('nvEditCaption'); if (cap) cap.value = v.caption || '';
    sheet.classList.add('active');
  }

  function closeEdit() {
    const sheet = el('nvEditSheet');
    if (sheet) sheet.classList.remove('active');
    state.editVideoId = null;
  }

  function editBackdrop(e) { if (e.target && e.target.id === 'nvEditSheet') closeEdit(); }

  function refreshCardMeta(id) {
    const v = findVideo(id);
    const card = document.querySelector('.nv-card[data-id="' + id + '"]');
    if (!v || !card) return;
    const meta = card.querySelector('.nv-meta');
    if (meta) meta.outerHTML = metaHtml(v);
    if (window.lucide) window.lucide.createIcons();
  }

  async function saveEdit() {
    const id = state.editVideoId;
    if (!id) return;
    const caption = ((el('nvEditCaption') || {}).value || '').trim();
    const btn = el('nvEditSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await window.db.collection('videos').doc(id).update({ caption: caption });
      const v = findVideo(id);
      if (v) { v.caption = caption; }
      toast('Video updated', 'success');
      closeEdit();
      refreshCardMeta(id);
      if (el('nvMyVideosList')) renderMyVideos();
    } catch (err) {
      toast('Could not update video', 'error');
      console.warn(err);
    } finally {
      const b = el('nvEditSave');
      if (b) { b.disabled = false; b.textContent = 'Save changes'; }
    }
  }

  // ── Settings → My Videos (own posts only, NOT stories) ──
  function renderMyVideos() {
    const host = el('nvMyVideosList');
    if (!host) return;
    if (state.myUnsub) { try { state.myUnsub(); } catch (e) {} state.myUnsub = null; }
    const uid = myUid();
    if (!uid) { host.innerHTML = '<div class="nv-mine-empty">Sign in to see your videos.</div>'; return; }
    host.innerHTML = '<div class="nv-mine-empty">Loading your videos…</div>';
    // Single-field equality query → auto-indexed, no composite index to deploy.
    // Ordering is done client-side.
    state.myUnsub = window.db.collection('videos').where('uid', '==', uid).limit(100)
      .onSnapshot(snap => {
        const items = [];
        snap.forEach(d => items.push(Object.assign({ id: d.id }, d.data())));
        items.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
        state.myVideos = items;
        if (!items.length) {
          host.innerHTML = '<div class="nv-mine-empty">You haven’t posted any videos yet.<br>' +
            'Open Moments → Videos and tap <strong>+ New Video</strong> to post one.</div>';
          return;
        }
        host.innerHTML = items.map(myVideoRowHtml).join('');
        if (window.lucide) window.lucide.createIcons();
      }, err => {
        console.warn('my videos listener error', err && err.message);
        host.innerHTML = '<div class="nv-mine-empty">Couldn’t load your videos.</div>';
        if (window.nexaNoteQuotaError) window.nexaNoteQuotaError(err);
      });
  }

  function closeMyVideos() {
    if (state.myUnsub) { try { state.myUnsub(); } catch (e) {} state.myUnsub = null; }
  }

  function myVideoRowHtml(v) {
    const thumb = v.thumbUrl || cloudThumb(v.videoUrl);
    const id = sid(v.id);
    return '' +
      '<div class="nv-mine-row">' +
        '<div class="nv-mine-thumb" onclick="nexaVideosWatch(\'' + id + '\')">' +
          '<img src="' + esc(safeUrl(thumb)) + '" alt="" loading="lazy">' +
          '<span class="nv-mine-play"><i data-lucide="play" style="width:15px;height:15px;"></i></span>' +
        '</div>' +
        '<div class="nv-mine-info">' +
          '<div class="nv-mine-cap">' + (v.caption ? esc(v.caption) : '<span class="nv-mine-muted">No caption</span>') + '</div>' +
          '<div class="nv-mine-stats">' +
            '<span>' + esc(timeAgo(Number(v.createdAt))) + '</span>' +
            '<span>·</span><span>' + fmtCount(v.views) + ' views</span>' +
            '<span>·</span><span>' + fmtCount(v.likes) + ' likes</span>' +
            '<span>·</span><span>' + fmtCount(v.commentsCount) + ' comments</span>' +
          '</div>' +
        '</div>' +
        '<div class="nv-mine-actions">' +
          '<button class="nv-mine-btn" onclick="nexaVideosEdit(\'' + id + '\')" title="Edit">' +
            '<i data-lucide="pencil" style="width:16px;height:16px;"></i></button>' +
          '<button class="nv-mine-btn danger" onclick="nexaVideosDelete(\'' + id + '\')" title="Delete">' +
            '<i data-lucide="trash-2" style="width:16px;height:16px;"></i></button>' +
        '</div>' +
      '</div>';
  }

  function watchMyVideo(id) {
    const v = findVideo(id);
    if (!v) return;
    if (window.openMediaViewer) window.openMediaViewer(v.videoUrl, 'video');
    else window.open(safeUrl(v.videoUrl), '_blank');
  }

  // Safety net: if the tab/app is backgrounded while the composer is open,
  // silence the preview immediately (a mobile WebView may not deliver any other
  // event until the page is resumed).
  if (document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') pausePreview();
    });
  }
  if (window.addEventListener) window.addEventListener('pagehide', pausePreview);

  // ── public API ───────────────────────────────────────────────────────────
  window.NexaVideos = {
    open: open,
    close: stop,
    refresh: () => { state.started = false; if (el('nexaVideosRoot')) { el('nexaVideosRoot').dataset.built = ''; } open(); },
    renderMyVideos: renderMyVideos,
    closeMyVideos: closeMyVideos,
    openFocus: (id) => { state.focusVideoId = id; open(id); },
    openComments: openComments
  };
  window.nexaVideosToggleSound = toggleSound;
  window.nexaVideosTogglePreviewSound = togglePreviewSound;
  window.nexaVideosOpenComposer = openComposer;
  window.nexaVideosCloseComposer = closeComposer;
  window.nexaVideosComposerBackdrop = composerBackdrop;
  window.nexaVideosPickFile = pickFile;
  window.nexaVideosPost = post;
  window.nexaVideosCloseComments = closeComments;
  window.nexaVideosBackdropClick = backdropClick;
  window.nexaVideosSendComment = sendComment;
  window.nexaVideosDeleteComment = deleteComment;
  window.nexaVideosLikeComment = likeComment;
  window.nexaVideosCopyComment = copyComment;
  window.nexaVideosToggleReplies = toggleReplies;
  window.nexaVideosReplyComment = replyComment;
  window.nexaVideosCancelCommentReply = cancelCommentReply;
  window.nexaVideosEdit = openEditVideo;
  window.nexaVideosCloseEdit = closeEdit;
  window.nexaVideosEditBackdrop = editBackdrop;
  window.nexaVideosSaveEdit = saveEdit;
  window.nexaVideosWatch = watchMyVideo;
  window.nexaVideosDelete = deleteVideo;
})();
