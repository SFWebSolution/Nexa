/**
 * Live room — voice-only + round launcher tests.
 *
 * The Live (formerly "Voice Room") feature is voice-only: the video mode, the
 * mode chooser, the camera toggle and the video tile wall were removed. The
 * launcher is now a single round floating button pinned bottom-right of the
 * chat list (same round footprint as the voice-note mic).
 *
 * These are structural assertions over the real source files — the module is a
 * browser-only class (PeerJS/Firebase/getUserMedia), so it is not instantiated.
 *
 * Run: node tests/live-room-voice-only.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");

const JS = read("nexa-voice-room.js");
const CSS = read("nexa-voice-room.css");
const HTML = read("dashboard.html");
const DASH_CSS = read("dashboard.css");

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }
function not(v, msg) { if (v) throw new Error(msg || "expected falsy"); }

console.log("\n── Voice room: video removed ──");

t("no camera / video-mode state remains", () => {
  ["this.roomMode", "this.isCameraOn", "this.remoteStreams",
   "this.maxParticipantsVideo", "this.maxParticipantsVoice",
   "isVideoRoom(", "modeLabel(", "capForMode(",
   "toggleCamera(", "chooseMode(", "renderVideoUI(",
   "videoTileHtml(", "playRemoteVideoStream(", "reapplyRemoteVideos(",
   "attachLocalSelfVideo("].forEach((sym) => {
    not(JS.includes(sym), `leftover symbol: ${sym}`);
  });
});

t("no video DOM ids remain", () => {
  ["nexaVrCamBtn", "nexaVrModeModal", "nexaVrModeVoiceBtn", "nexaVrModeVideoBtn",
   "nexaVrSelfVideo", "nexaVrRemoteVideo_"].forEach((id) => {
    not(JS.includes(id), `leftover DOM id: ${id}`);
  });
});

t("camera is never requested from getUserMedia", () => {
  // Every audio capture must pass video:false.
  ok(JS.includes("video: false"), "audio capture pins video:false");
  not(/video:\s*wantVideo/.test(JS), "no conditional video capture");
  not(JS.includes("videoConstraints"), "no video constraints block");
});

t("the room stays a 10-peer audio mesh", () => {
  ok(JS.includes("this.maxParticipants = 10;"), "capacity is 10");
});

t("launching a room goes straight in (no mode chooser)", () => {
  const start = JS.indexOf("openModeChooser() {");
  ok(start > -1, "openModeChooser exists");
  const body = JS.slice(start, start + 260);
  ok(body.includes("this.startRoom()"), "starts a room directly");
  not(body.includes("classList.add(\"active\")"), "no modal is opened");
});

t("a legacy room doc with mode:'video' still joins as audio", () => {
  ok(/legacy room doc may still carry mode:'video'/.test(JS),
     "joinRoom documents tolerance of legacy video rooms");
  not(/roomData\.mode === 'video'/.test(JS), "mode is no longer read from the doc");
});

t("no video CSS remains", () => {
  ["nexa-vr-grid-video", "nexa-vr-video-card", "nexa-vr-card-video",
   "nexa-vr-mode-badge", "nexa-vr-mode-opt"].forEach((cls) => {
    not(CSS.includes(cls), `leftover CSS: ${cls}`);
  });
});

t("CSS braces stay balanced", () => {
  const o = (CSS.match(/\{/g) || []).length;
  const c = (CSS.match(/\}/g) || []).length;
  ok(o === c, `unbalanced CSS: ${o} { vs ${c} }`);
});

console.log("\n── Round launcher ──");

t("exactly one launcher exists and it is the round FAB", () => {
  const count = (HTML.match(/start-voice-chat-btn/g) || []).length;
  ok(count === 1, `expected 1 launcher, found ${count}`);
  ok(HTML.includes('class="live-fab start-voice-chat-btn"'), "FAB carries the handler class");
});

t("the FAB lives inside the Chats pane, not the tab strip", () => {
  const pane = HTML.indexOf('id="tabPaneChats"');
  const fab = HTML.indexOf("live-fab");
  const paneEnd = HTML.indexOf('id="tabPaneStories"');
  ok(pane > -1 && fab > pane, "FAB is after the Chats pane opens");
  ok(paneEnd === -1 || fab < paneEnd, "FAB is before the Stories pane");
  ok(!/s-tab-btn[^>]*start-voice-chat-btn/.test(HTML), "not a tab-strip button any more");
});

t("the old text pill is gone", () => {
  not(HTML.includes("voice-chat-start-strip"), "strip markup removed");
  not(HTML.includes("Start a Voice room"), "old label removed");
});

t("the FAB is round and pinned bottom-right", () => {
  const block = DASH_CSS.slice(DASH_CSS.indexOf(".live-fab {"));
  const decl = block.slice(0, block.indexOf("}"));
  ok(/border-radius:\s*50%/.test(decl), "round");
  ok(/position:\s*absolute/.test(decl), "floats over the list");
  ok(/right:\s*18px/.test(decl), "right-aligned");
  ok(/bottom:\s*18px/.test(decl), "bottom-aligned");
  ok(/width:\s*52px/.test(decl) && /height:\s*52px/.test(decl), "square footprint (52px)");
});

t("the chat list reserves space so the FAB never covers the last row", () => {
  ok(/\.tab-pane #users\s*\{[^}]*padding-bottom:\s*84px/.test(DASH_CSS),
     "#users has bottom padding for the FAB");
});

t("the FAB clears the mobile bottom nav via the sidebar's reserved padding", () => {
  // On mobile .sidebar reserves the 62px nav with padding-bottom, so the pane
  // (the FAB's containing block) already ends above the nav. A second
  // .live-fab bottom override would double-count it and float the button high.
  ok(/\.sidebar\s*\{[^}]*padding-bottom:\s*62px/.test(DASH_CSS),
     ".sidebar reserves the nav height");
  not(/\.live-fab\s*\{[^}]*bottom:\s*(?!18px)\d+px/.test(DASH_CSS),
     "no competing .live-fab bottom offset");
});

t("the FAB respects reduced-motion", () => {
  ok(/prefers-reduced-motion[\s\S]{0,300}\.live-fab/.test(DASH_CSS),
     "reduced-motion guard present");
});

t("dashboard CSS braces stay balanced", () => {
  const o = (DASH_CSS.match(/\{/g) || []).length;
  const c = (DASH_CSS.match(/\}/g) || []).length;
  ok(o === c, `unbalanced CSS: ${o} { vs ${c} }`);
});

console.log("\n── Room chat layout ──");

t("chat section is not crushed by the column-flex body", () => {
  // .nexa-vr-body is display:flex/column. A default flex-shrink:1 shrank the
  // chat section to a 2px sliver on phones once the stage + participant grid
  // filled the height. The chat owns its own scroll area, so it must keep its
  // natural height (flex: 0 0 auto).
  const block = CSS.match(/\.nexa-vr-chat-section\s*\{[^}]*\}/g) || [];
  ok(block.length >= 1, "chat section rule missing");
  const all = block.join("\n");
  ok(/flex:\s*0\s+0\s+auto/.test(all),
     "chat section must set flex: 0 0 auto so the flex body can't shrink it");
});

t("chat body keeps a usable height in both breakpoints", () => {
  ok(/\.nexa-vr-chat-body\s*\{[^}]*height:\s*220px/.test(CSS),
     "desktop chat body height (220px) missing");
  // The <=600px media query shrinks it to 180px.
  ok(/@media[^{]*max-width:\s*600px[\s\S]{0,4000}\.nexa-vr-chat-body\s*\{[^}]*180px/.test(CSS),
     "mobile chat body height (180px) missing");
});

t("the chat body scrolls independently of the room body", () => {
  ok(/\.nexa-vr-chat-messages\s*\{[^}]*overflow-y:\s*auto/.test(CSS),
     "chat messages must scroll on their own");
});

t("chat send button is a fixed square that can't be squashed", () => {
  const rules = (CSS.match(/\.nexa-vr-chat-send\s*\{[^}]*\}/g) || []).join("\n");
  ok(rules, "send button rule missing");
  ok(/min-width/.test(rules) && /min-height/.test(rules),
     "send button needs min-width/min-height so a flex parent can't squash it");
});

t("chat markup + listener wiring are present", () => {
  ["nexaVrChatMessages", "nexaVrChatInput", "nexaVrChatSendBtn", "nexaVrChatToggle"]
    .forEach((id) => ok(JS.includes(id), `missing chat element #${id}`));
  ok(/subscribeToRoomChat\s*\(/.test(JS), "subscribeToRoomChat missing");
  ok(/sendRoomMessage\s*\(/.test(JS), "sendRoomMessage missing");
  // Subscribed on both lifecycle paths (host start + joiner).
  ok((JS.match(/this\.subscribeToRoomChat\(\)/g) || []).length >= 2,
     "chat must be subscribed when starting AND joining a room");
});

t("room chat escapes message text (no HTML injection)", () => {
  ok(/escapeHTML\(m\.text/.test(JS) || /escapeHTML\(m\.text \|\| ''\)/.test(JS),
     "chat message text must go through escapeHTML");
  // The name is resolved (profile lookup) and THEN escaped at the render site.
  ok(/escapeHTML\(this\.resolveSenderName\(m\)\)/.test(JS),
     "chat sender name must be resolved and escaped before interpolation");
});

console.log("\n── Line endings ──");

t("edited files keep their original line endings", () => {
  ["nexa-voice-room.js", "nexa-voice-room.css", "dashboard.html", "dashboard.css", "app-main.js"]
    .forEach((f) => {
      const raw = fs.readFileSync(path.join(ROOT, f), "utf8");
      const crlf = (raw.match(/\r\n/g) || []).length;
      const lf = (raw.match(/\n/g) || []).length;
      ok(crlf > 0 && crlf === lf, `${f}: mixed line endings (${crlf} CRLF / ${lf} LF)`);
    });
});

console.log(`\n${fail === 0 ? "✓ PASSED" : "✗ FAILED"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
