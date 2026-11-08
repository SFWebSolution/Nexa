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
 *                                      thumbUrl, caption, music, duration,
 *                                      createdAt (ms int), views, likes,
 *                                      commentsCount, shares, saves, visibility }
 *   videos/{id}/likes/{uid}          { at }
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
    pendingFile: null,      // File chosen in the composer
    pendingDuration: 0,     // seconds (from the preview metadata)
    posting: false,
    commentsUnsub: null,
    commentsVideoId: null,
    lastTapAt: 0,
    lastTapId: null,
    pendingDurationMs: 0,
    pendingTooLong: false,
    pendingTooBig: false,
    editVideoId: null,
    myVideos: [],
    myUnsub: null
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
  function open() {
    if (!window.db || !myUid()) return;
    renderShell();
    if (!state.started) start();
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
        '<button class="nv-fab" id="nvFab" onclick="nexaVideosOpenComposer()" aria-label="Upload video">' +
          '<i data-lucide="plus" style="width:24px;height:24px;"></i></button>' +
        '<div class="nv-load-older" id="nvLoadOlder" style="display:none;">Loading…</div>';
      const feed = el('nvFeed');
      feed.addEventListener('click', onFeedClick);
      feed.addEventListener('pointerdown', onFeedPointerDown);
      feed.addEventListener('pointerup', onFeedPointerUp);
      feed.addEventListener('pointercancel', clearLongPress);
      feed.addEventListener('scroll', onFeedScroll, { passive: true });
      setupObserver();
      if (window.lucide) window.lucide.createIcons();
    }
  }

  function renderFeed() {
    const feed = el('nvFeed');
    if (!feed) return;
    if (!state.videos.length) {
      renderEmpty('No videos yet. Be the first to post one!');
      return;
    }
    feed.innerHTML = state.videos.map(cardHtml).join('');
    if (window.lucide) window.lucide.createIcons();
    // (Re)attach the observer to the fresh nodes and prime the first card.
    setupObserver();
    requestAnimationFrame(() => {
      const first = feed.querySelector('.nv-card');
      if (first) first.classList.add('nv-visible');
    });
  }

  function appendCards(list) {
    const feed = el('nvFeed');
    if (!feed) return;
    const empty = feed.querySelector('.nv-empty');
    if (empty) empty.remove();
    feed.insertAdjacentHTML('beforeend', list.map(cardHtml).join(''));
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

  function metaHtml(v) {
    return '' +
      '<div class="nv-meta">' +
        '<div class="nv-author">' +
          '<img class="nv-author-pic" src="' + esc(safeUrl(v.authorPhoto || 'https://i.imgur.com/HeIi0wU.png')) + '" alt="">' +
          '<span class="nv-author-name">@' + esc(v.authorName || 'user') + '</span>' +
          '<span class="nv-dot">·</span>' +
          '<span class="nv-time">' + esc(timeAgo(Number(v.createdAt))) + '</span>' +
        '</div>' +
        (v.caption ? '<div class="nv-caption">' + esc(v.caption) + '</div>' : '') +
        (v.music ? '<div class="nv-music"><i data-lucide="music" style="width:13px;height:13px;"></i>' +
          '<span class="nv-music-text">' + esc(v.music) + '</span></div>' : '') +
      '</div>';
  }

  function cardHtml(v) {
    const thumb = v.thumbUrl || cloudThumb(v.videoUrl);
    const poster = thumb ? ' poster="' + esc(safeUrl(thumb)) + '"' : '';
    const liked = !!state.likedMine[v.id];
    const mine = v.uid === myUid();
    return '' +
      '<div class="nv-card" data-id="' + esc(v.id) + '" data-uid="' + esc(v.uid || '') + '">' +
        '<video class="nv-video" src="' + esc(safeUrl(v.videoUrl)) + '"' + poster +
          ' playsinline webkit-playsinline loop preload="metadata"></video>' +
        '<div class="nv-shade"></div>' +
        '<div class="nv-heart" id="nvHeart-' + esc(v.id) + '">' +
          '<i data-lucide="heart" style="width:84px;height:84px;"></i></div>' +
        '<div class="nv-play-hint" aria-hidden="true">' +
          '<i data-lucide="play" style="width:30px;height:30px;"></i></div>' +
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
          (mine ? '<button class="nv-rail-btn" data-act="edit" data-id="' + esc(v.id) + '" aria-label="Edit">' +
            '<i data-lucide="pencil" style="width:22px;height:22px;"></i></button>' : '') +
          (mine ? '<button class="nv-rail-btn nv-rail-del" data-act="delete" data-id="' + esc(v.id) + '" aria-label="Delete">' +
            '<i data-lucide="trash-2" style="width:22px;height:22px;"></i></button>' : '') +
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

  function tryPlay(video) {
    if (!video) return;
    video.muted = true;
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
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
      return;
    }
    // Tap the video surface: single tap = pause/play, double tap = like.
    const card = cardAt(e.target);
    if (!card) return;
    const id = card.getAttribute('data-id');
    const now = Date.now();
    if (state.lastTapId === id && now - state.lastTapAt < DOUBLE_TAP_MS) {
      state.lastTapAt = 0; state.lastTapId = null;
      likeBurst(id, card);
      return;
    }
    state.lastTapAt = now; state.lastTapId = id;
    setTimeout(() => {
      if (state.lastTapAt !== now) return; // a second tap happened → it was a double
      togglePlay(card);
    }, DOUBLE_TAP_MS);
  }

  function togglePlay(card) {
    const video = card.querySelector('.nv-video');
    if (!video) return;
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

  function doLike(id, liked) {
    state.likedMine[id] = liked;
    const likeRef = window.db.collection('videos').doc(id).collection('likes').doc(myUid());
    const vidRef = window.db.collection('videos').doc(id);
    const countEl = el('nvLikeCount-' + id);
    const cur = Number((countEl && countEl.textContent) ? parseCount(countEl.textContent) : 0);
    if (countEl) countEl.textContent = fmtCount(Math.max(0, cur + (liked ? 1 : -1)));
    const p = liked ? likeRef.set({ at: Date.now() }) : likeRef.delete();
    p.then(() => vidRef.update({ likes: fv().increment(liked ? 1 : -1) }))
      .catch(err => {
        console.warn('like failed', err && err.message);
        state.likedMine[id] = !liked;
        const b = document.querySelector('.nv-rail-like[data-id="' + id + '"]');
        if (b) b.classList.toggle('liked', !liked);
      });
  }

  // "1.2K" → 1200 (so an optimistic +1/-1 stays sane)
  function parseCount(s) {
    s = String(s).trim();
    if (/K$/i.test(s)) return Math.round(parseFloat(s) * 1e3);
    if (/M$/i.test(s)) return Math.round(parseFloat(s) * 1e6);
    return parseInt(s, 10) || 0;
  }

  function toggleSave(id, btn) {
    btn.classList.toggle('saved');
    const saved = btn.classList.contains('saved');
    window.db.collection('videos').doc(id).update({ saves: fv().increment(saved ? 1 : -1) })
      .catch(() => {});
    toast(saved ? 'Saved' : 'Removed from saved', 'success');
  }

  function shareVideo(id) {
    const v = state.videos.find(x => x.id === id);
    const url = window.location.origin + '/dashboard.html';
    const text = (v && v.caption) ? v.caption : 'Watch this video on Nexa';
    const finish = () => {
      window.db.collection('videos').doc(id).update({ shares: fv().increment(1) }).catch(() => {});
      const c = el('nvShareCount-' + id);
      if (c) c.textContent = fmtCount(parseCount(c.textContent) + 1);
    };
    if (navigator.share) {
      navigator.share({ title: 'Nexa', text: text, url: url }).then(finish).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text + ' ' + url).then(() => { toast('Link copied', 'success'); finish(); }).catch(() => {});
    } else {
      finish();
    }
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
    const list = el('nvCommentsList');
    if (list) list.innerHTML = '<div class="nv-comments-empty">Loading…</div>';
    state.commentsUnsub = window.db.collection('videos').doc(id).collection('comments')
      .orderBy('createdAt', 'asc').limit(COMMENTS_PAGE)
      .onSnapshot(snap => {
        const items = [];
        snap.forEach(d => items.push(Object.assign({ id: d.id }, d.data())));
        const listEl = el('nvCommentsList');
        if (!listEl) return;
        if (!items.length) { listEl.innerHTML = '<div class="nv-comments-empty">No comments yet. Say something nice!</div>'; return; }
        listEl.innerHTML = items.map(commentHtml).join('');
        listEl.scrollTop = listEl.scrollHeight;
        if (window.lucide) window.lucide.createIcons();
      }, err => {
        console.warn('comments listener error', err && err.message);
        if (window.nexaNoteQuotaError) window.nexaNoteQuotaError(err);
      });
  }

  function commentHtml(c) {
    const mine = c.uid === myUid();
    return '<div class="nv-comment" data-id="' + esc(c.id) + '">' +
      '<img class="nv-comment-pic" src="' + esc(safeUrl(c.photo || 'https://i.imgur.com/HeIi0wU.png')) + '" alt="">' +
      '<div class="nv-comment-body">' +
        '<div class="nv-comment-top"><span class="nv-comment-name">' + esc(c.name || 'user') + '</span>' +
          '<span class="nv-comment-time">' + esc(timeAgo(Number(c.createdAt))) + '</span></div>' +
        '<div class="nv-comment-text">' + esc(c.text || '') + '</div>' +
      '</div>' +
      (mine ? '<button class="nv-comment-del" onclick="nexaVideosDeleteComment(\'' + esc(c.id) + '\')">' +
        '<i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>' : '') +
    '</div>';
  }

  function sendComment() {
    const id = state.commentsVideoId;
    const inp = el('nvCommentInput');
    if (!id || !inp) return;
    const text = (inp.value || '').trim();
    if (!text) return;
    inp.value = '';
    window.db.collection('videos').doc(id).collection('comments').add({
      uid: myUid(), name: myName(), photo: myPhoto(), text: text, createdAt: Date.now(), likes: 0
    }).then(() => {
      window.db.collection('videos').doc(id).update({ commentsCount: fv().increment(1) }).catch(() => {});
      const c = el('nvCommentCount-' + id);
      if (c) c.textContent = fmtCount(parseCount(c.textContent) + 1);
    }).catch(err => { toast('Could not post comment', 'error'); console.warn(err); });
  }

  function deleteComment(cid) {
    const id = state.commentsVideoId;
    if (!id) return;
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
            '<video class="nv-composer-preview" id="nvComposerPreview" playsinline muted loop style="display:none;"></video>' +
            '<div class="nv-upload-ring" id="nvUploadRing" style="display:none;">' +
              '<svg viewBox="0 0 120 120"><circle class="nv-ring-track" cx="60" cy="60" r="52"></circle>' +
              '<circle class="nv-ring-fill" id="nvRingFill" cx="60" cy="60" r="52"></circle></svg>' +
              '<div class="nv-ring-pct" id="nvRingPct">0%</div>' +
              '<div class="nv-ring-stage" id="nvRingStage"></div>' +
            '</div>' +
          '</div>' +
          '<div class="nv-composer-fields">' +
            '<textarea id="nvComposerCaption" rows="2" maxlength="300" placeholder="Write a caption…"></textarea>' +
            '<div class="nv-composer-music">' +
              '<i data-lucide="music" style="width:15px;height:15px;"></i>' +
              '<input id="nvComposerMusic" type="text" maxlength="80" placeholder="Add music (optional)" autocomplete="off">' +
            '</div>' +
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
    if (prev) { prev.style.display = 'none'; prev.removeAttribute('src'); }
    const pick = el('nvComposerPick');
    if (pick) pick.style.display = '';
    const cap = el('nvComposerCaption'); if (cap) cap.value = '';
    const mus = el('nvComposerMusic'); if (mus) mus.value = '';
    setRing(false, 0, '');
    box.classList.add('active');
  }

  function closeComposer() {
    const box = el('nvComposer');
    if (box) box.classList.remove('active');
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
      prev.src = URL.createObjectURL(file);
      prev.style.display = '';
      prev.load();
      prev.play().catch(() => {});
      prev.onloadedmetadata = () => {
        const durMs = Math.round((prev.duration || 0) * 1000);
        state.pendingDurationMs = durMs;
        state.pendingDuration = Math.round(prev.duration || 0);
        state.pendingTooLong = durMs > MAX_VIDEO_MS;
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
    const musEl = el('nvComposerMusic');
    const caption = (capEl && capEl.value || '').trim();
    const music = (musEl && musEl.value || '').trim();
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
          music: music,
          duration: state.pendingDuration,
          createdAt: Date.now(),
          views: 0, likes: 0, commentsCount: 0, shares: 0, saves: 0,
          visibility: 'public'
        });
      })
      .then(() => {
        setRing(true, 100, 'Posted!');
        notifyConnections(caption);
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

  // Only ACCEPTED connections are notified — everyone else sees the video but
  // gets no push (the product rule).
  function notifyConnections(caption) {
    try {
      const conns = Object.values(window.nexaMyConnections || {})
        .filter(c => c && c.status === 'accepted' && c.otherUid)
        .map(c => c.otherUid);
      if (!conns.length) return;
      window.sendPushNotification(myName(), 'posted a new video', null, {
        isVideo: true, recipientUids: conns, chatUid: myUid()
      });
    } catch (e) { console.warn('video push failed', e); }
  }

  // ── edit (caption + music) ──
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
            '<label class="nv-edit-label">Music</label>' +
            '<input id="nvEditMusic" type="text" maxlength="80" placeholder="Add music (optional)" autocomplete="off">' +
            '<div class="nv-edit-note">The clip itself can’t be changed … delete and re-post to swap the video.</div>' +
            '<button class="nv-edit-save" id="nvEditSave" onclick="nexaVideosSaveEdit()">Save changes</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(sheet);
      if (window.lucide) window.lucide.createIcons();
    }
    state.editVideoId = id;
    const cap = el('nvEditCaption'); if (cap) cap.value = v.caption || '';
    const mus = el('nvEditMusic'); if (mus) mus.value = v.music || '';
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
    const music = ((el('nvEditMusic') || {}).value || '').trim();
    const btn = el('nvEditSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await window.db.collection('videos').doc(id).update({ caption: caption, music: music });
      const v = findVideo(id);
      if (v) { v.caption = caption; v.music = music; }
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
            'Open Moments → Videos and tap + to post one.</div>';
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
          (v.music ? '<div class="nv-mine-music"><i data-lucide="music" style="width:12px;height:12px;"></i> ' + esc(v.music) + '</div>' : '') +
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

  // ── public API ───────────────────────────────────────────────────────────
  window.NexaVideos = {
    open: open,
    close: stop,
    refresh: () => { state.started = false; if (el('nexaVideosRoot')) { el('nexaVideosRoot').dataset.built = ''; } open(); },
    renderMyVideos: renderMyVideos,
    closeMyVideos: closeMyVideos
  };
  window.nexaVideosOpenComposer = openComposer;
  window.nexaVideosCloseComposer = closeComposer;
  window.nexaVideosComposerBackdrop = composerBackdrop;
  window.nexaVideosPickFile = pickFile;
  window.nexaVideosPost = post;
  window.nexaVideosCloseComments = closeComments;
  window.nexaVideosBackdropClick = backdropClick;
  window.nexaVideosSendComment = sendComment;
  window.nexaVideosDeleteComment = deleteComment;
  window.nexaVideosEdit = openEditVideo;
  window.nexaVideosCloseEdit = closeEdit;
  window.nexaVideosEditBackdrop = editBackdrop;
  window.nexaVideosSaveEdit = saveEdit;
  window.nexaVideosWatch = watchMyVideo;
  window.nexaVideosDelete = deleteVideo;
})();
