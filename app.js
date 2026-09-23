// ====================== CONFIG ======================
const CLIENT_ID = "6ec3c6f59ec14dcca495a904a268a67f";
// Must exactly match a Redirect URI registered in the Spotify Developer Dashboard.
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state"
].join(" ");

// ====================== STORAGE (recordings live in IndexedDB) ======================
const DB_NAME = "radio-station-db";
const STORE_NAME = "recordings";
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function saveRecording(blockId, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(blob, blockId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadRecording(blockId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(blockId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecording(blockId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(blockId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ====================== STATE ======================
function getDefaultBlocks() {
  return [
    { id: "b1", type: "jingle", label: "Welcome Jingle", mode: "quiet", duration: 3 },
    { id: "b2", type: "songs", count: 4 },
    { id: "b3", type: "talk", label: "Weather, Traffic, News", mode: "quiet", duration: 15 },
    { id: "b4", type: "songs", count: 3 },
    { id: "b5", type: "bed", label: "DJ Talk", mode: "background", duration: 20 },
    { id: "b6", type: "commercial", label: "Commercial Break", mode: "quiet", duration: 10 },
    { id: "b7", type: "songs", count: 3 },
    { id: "b8", type: "jingle", label: "Closing Jingle", mode: "quiet", duration: 3 }
  ];
}

function loadSavedShow() {
  try {
    const raw = localStorage.getItem("radio_show_blocks");
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return getDefaultBlocks();
}

function saveShow() {
  localStorage.setItem("radio_show_blocks", JSON.stringify(blocks));
  localStorage.setItem("radio_bg_music", bgMusicInput.value.trim());
}

let blocks = loadSavedShow();
let nextIdNum = Date.now();
function makeId() { return "b" + (nextIdNum++); }

let loopEnabled = false;
let currentBlockIndex = 0;
let songsPlayedInBlock = 0;
let isPlaying = false;
let deviceId = null;
let accessToken = null;
let isPaused = false;
let lastTrackUri = null;
let activePlaybackTimer = null;
let activeAudioEl = null;
let trackPollInterval = null;
let currentVolumePercent = 80;
let showInProgress = false; // true once a show has started, so Back/Stop can resume it later
let isResuming = false;     // set for one runCurrentBlock() call when continuing a paused block
let blockRemainingSeconds = null; // quiet-mode countdown, survives pausing so it can resume
let blockDurationSeconds = null;
let trackDurationMs = 0;    // for the songs progress bar
let trackProgressMsAtPoll = 0;
let trackProgressPolledAt = 0;
let progressTickInterval = null;
let isScrubbing = false; // true while the child is dragging the progress bar

// ====================== SIMPLE TONE JINGLE (fallback, no recording) ======================
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, duration, type = "sine") {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

function playHappyChime() {
  playTone(523, 0.2);
  setTimeout(() => playTone(659, 0.2), 200);
  setTimeout(() => playTone(784, 0.4), 400);
}

// ====================== DOM ======================
const builderScreen = document.getElementById("builder-screen");
const liveScreen = document.getElementById("live-screen");
const endScreen = document.getElementById("end-screen");
const blocksList = document.getElementById("blocks-list");
const addModal = document.getElementById("add-modal");
const modeModal = document.getElementById("mode-modal");
const recorderModal = document.getElementById("recorder-modal");
const statusLabel = document.getElementById("status-label");
const statusMain = document.getElementById("status-main");
const statusSub = document.getElementById("status-sub");
const nextUp = document.getElementById("next-up");
const progressFill = document.getElementById("progress-fill");
const bgMusicInput = document.getElementById("bg-music-input");
const skipSongBtn = document.getElementById("skip-song-btn");
const finishedTalkingBtn = document.getElementById("finished-talking-btn");

bgMusicInput.value = localStorage.getItem("radio_bg_music") || "";

const MODE_LABELS = { quiet: "🤫 Quiet", record: "🎙️ Recorded", background: "🎶 Background" };
const TYPE_LABELS = { jingle: "Jingle", talk: "Weather, Traffic, News", bed: "DJ Talk", commercial: "Commercial Break" };
const TYPE_ICONS = { jingle: "🎤", talk: "🗣️", bed: "🎶", commercial: "📢" };

// ====================== PRESS-AND-HOLD DRAG TO REORDER (works with touch + mouse) ======================
// The old implementation used the HTML5 drag-and-drop API, which only fires from
// a mouse — it silently does nothing on a phone. This uses Pointer Events (which
// fire for touch, mouse and pen alike) with a long-press to start the drag, so it
// works consistently on the phone this app is actually used on.
const LONG_PRESS_MS = 320;
const DRAG_CANCEL_PX = 10;
let dragCtx = null;

function attachCardDrag(card) {
  let longPressTimer = null;
  let startX = 0, startY = 0, pointerId = null;
  let scrollPassthroughActive = false;
  let lastScrollClientY = 0;

  function cancelPreDrag() {
    clearTimeout(longPressTimer);
    card.removeEventListener("pointermove", onPreMove);
    card.removeEventListener("pointerup", onPreUp);
    card.removeEventListener("pointercancel", onPreUp);
  }

  // The card has touch-action: none (required for the long-press-then-drag
  // gesture to register reliably on iOS/Android), which also switches off the
  // browser's own touch scrolling for it. So if the finger moves before the
  // long-press fires — meaning they're scrolling, not trying to reorder — we
  // have to scroll the page ourselves for the rest of that touch.
  function onPreMove(e) {
    if (Math.abs(e.clientY - startY) > DRAG_CANCEL_PX || Math.abs(e.clientX - startX) > DRAG_CANCEL_PX) {
      cancelPreDrag();
      scrollPassthroughActive = true;
      lastScrollClientY = e.clientY;
      card.addEventListener("pointermove", onScrollPassthroughMove);
      card.addEventListener("pointerup", onScrollPassthroughEnd);
      card.addEventListener("pointercancel", onScrollPassthroughEnd);
      window.scrollBy(0, lastScrollClientY - e.clientY);
    }
  }
  function onPreUp() { cancelPreDrag(); }

  function onScrollPassthroughMove(e) {
    window.scrollBy(0, lastScrollClientY - e.clientY);
    lastScrollClientY = e.clientY;
  }
  function onScrollPassthroughEnd() {
    scrollPassthroughActive = false;
    card.removeEventListener("pointermove", onScrollPassthroughMove);
    card.removeEventListener("pointerup", onScrollPassthroughEnd);
    card.removeEventListener("pointercancel", onScrollPassthroughEnd);
  }

  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY; pointerId = e.pointerId;
    card.addEventListener("pointermove", onPreMove);
    card.addEventListener("pointerup", onPreUp);
    card.addEventListener("pointercancel", onPreUp);
    longPressTimer = setTimeout(() => {
      cancelPreDrag();
      beginDrag(card, pointerId, e.clientY);
    }, LONG_PRESS_MS);
  });
}

function beginDrag(card, pointerId, clientY) {
  const siblings = Array.from(blocksList.children);
  const index = siblings.indexOf(card);
  const listRect = blocksList.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();

  dragCtx = {
    card,
    pointerId,
    startClientY: clientY,
    index,
    targetIndex: index,
    cardHeight: cardRect.height,
    tops: siblings.map(el => el.getBoundingClientRect().top - listRect.top)
  };

  try { card.setPointerCapture(pointerId); } catch (e) {}
  card.classList.add("dragging");
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", onDragEnd);
  document.addEventListener("pointercancel", onDragEnd);
  if (navigator.vibrate) navigator.vibrate(15);
}

function onDragMove(e) {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
  e.preventDefault();
  const deltaY = e.clientY - dragCtx.startClientY;
  dragCtx.card.style.transform = `translateY(${deltaY}px)`;

  const siblings = Array.from(blocksList.children);
  const draggedCenter = dragCtx.tops[dragCtx.index] + dragCtx.cardHeight / 2 + deltaY;

  let insertPos = 0;
  siblings.forEach((el, i) => {
    if (i === dragCtx.index) return;
    const height = el.getBoundingClientRect().height;
    const mid = dragCtx.tops[i] + height / 2;
    if (draggedCenter > mid) insertPos++;
  });

  const newTarget = Math.min(Math.max(insertPos, 0), siblings.length - 1);
  if (newTarget !== dragCtx.targetIndex) {
    dragCtx.targetIndex = newTarget;
    applyDragShift();
  }
}

function applyDragShift() {
  const siblings = Array.from(blocksList.children);
  const gap = 12; // matches .blocks-list { gap: 12px; } in style.css
  siblings.forEach((el, i) => {
    if (i === dragCtx.index) return;
    let shift = 0;
    if (dragCtx.targetIndex > dragCtx.index && i > dragCtx.index && i <= dragCtx.targetIndex) {
      shift = -(dragCtx.cardHeight + gap);
    } else if (dragCtx.targetIndex < dragCtx.index && i < dragCtx.index && i >= dragCtx.targetIndex) {
      shift = dragCtx.cardHeight + gap;
    }
    el.style.transform = shift ? `translateY(${shift}px)` : "";
  });
}

function onDragEnd(e) {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
  const { index, targetIndex } = dragCtx;
  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", onDragEnd);
  document.removeEventListener("pointercancel", onDragEnd);

  dragCtx = null;

  if (targetIndex !== index) {
    const [moved] = blocks.splice(index, 1);
    blocks.splice(targetIndex, 0, moved);
    saveShow();
  }
  renderBlocks(); // fresh render clears every inline transform left over from dragging
}

// ====================== RENDER BLOCKS ======================
function renderBlocks() {
  blocksList.innerHTML = "";
  blocks.forEach((block, index) => {
    const card = document.createElement("div");
    card.className = `block-card ${block.type}`;
    card.dataset.index = index;

    let leftContent = "";
    let rightContent = "";

    if (block.type === "songs") {
      leftContent = `<span class="block-icon">🎵</span> Play <span class="song-count">${block.count}</span> Songs`;
      rightContent = `
        <button class="num-btn" data-action="minus">−</button>
        <button class="num-btn" data-action="plus">+</button>
        <button class="delete-btn" data-action="delete">×</button>
      `;
    } else {
      leftContent = `<span class="block-icon">${TYPE_ICONS[block.type]}</span> ${TYPE_LABELS[block.type]} <span class="block-mode-badge">${MODE_LABELS[block.mode] || ""}</span>`;
      rightContent = `<button class="edit-btn" data-action="edit">✎</button><button class="delete-btn" data-action="delete">×</button>`;
    }

    card.innerHTML = `
      <div class="block-left">${leftContent}</div>
      <div class="block-controls">${rightContent}</div>
    `;

    card.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === "plus") {
          block.count = Math.min(12, (block.count || 1) + 1);
          renderBlocks(); saveShow();
        } else if (action === "minus") {
          block.count = Math.max(1, (block.count || 1) - 1);
          renderBlocks(); saveShow();
        } else if (action === "delete") {
          if (block.mode === "record") deleteRecording(block.id);
          blocks.splice(index, 1);
          renderBlocks(); saveShow();
        } else if (action === "edit") {
          openModeModal(block);
        }
      });
    });

    attachCardDrag(card);

    blocksList.appendChild(card);
  });
}

// ====================== MODAL BACK-BUTTON SUPPORT ======================
// Treats the whole "add/edit a block" flow (add-type -> mode -> duration/recorder)
// as one logical screen for the phone's back button/gesture: opening any modal in
// the chain pushes a single history entry, and going back (or tapping Cancel)
// closes everything and returns to the builder, instead of leaving the page.
const durationModal = document.getElementById("duration-modal");
let modalHistoryPushed = false;

function openModalPushHistory() {
  if (!modalHistoryPushed) {
    modalHistoryPushed = true;
    history.pushState({ radioModal: true }, "");
  }
}

function hideAllModalsInternal() {
  addModal.classList.add("hidden");
  modeModal.classList.add("hidden");
  durationModal.classList.add("hidden");
  recorderModal.classList.add("hidden");
  stopMicStream();
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
}

function closeAllModals() {
  hideAllModalsInternal();
  modeModalTarget = null;
  if (modalHistoryPushed) {
    modalHistoryPushed = false;
    history.back();
  }
}

// Same pattern for the Live/End show screens: starting a show pushes one
// history entry, so the phone's back button (or gesture) returns straight
// to the builder ("home") from anywhere in the show, just like the Stop
// Show button does.
let showHistoryPushed = false;

function pushShowHistory() {
  if (!showHistoryPushed) {
    showHistoryPushed = true;
    history.pushState({ radioShow: true }, "");
  }
}

function exitToBuilderInternal() {
  clearActivePlayback();
  stopTrackPolling();
  pauseSpotify();
  isPlaying = false;
  isPaused = false;
  const pauseBtn = document.getElementById("pause-btn");
  if (pauseBtn) pauseBtn.textContent = "Pause everything";
  liveScreen.classList.add("hidden");
  endScreen.classList.add("hidden");
  builderScreen.classList.remove("hidden");
  updateStartButtonLabel();
}

function updateStartButtonLabel() {
  const btn = document.getElementById("start-show-btn");
  const newShowLink = document.getElementById("new-show-link");
  if (!btn) return;
  if (showInProgress) {
    btn.textContent = "▶ Resume Show";
    if (newShowLink) newShowLink.classList.remove("hidden");
  } else {
    btn.textContent = "▶ Start Show";
    if (newShowLink) newShowLink.classList.add("hidden");
  }
}

function exitToBuilder() {
  exitToBuilderInternal();
  if (showHistoryPushed) {
    showHistoryPushed = false;
    history.back();
  }
}

window.addEventListener("popstate", () => {
  if (modalHistoryPushed) {
    modalHistoryPushed = false;
    hideAllModalsInternal();
    modeModalTarget = null;
    return;
  }
  if (showHistoryPushed) {
    showHistoryPushed = false;
    exitToBuilderInternal();
  }
});

// ====================== ADD BLOCK ======================
document.getElementById("add-block-btn").addEventListener("click", () => {
  openModalPushHistory();
  addModal.classList.remove("hidden");
});

document.getElementById("close-modal").addEventListener("click", closeAllModals);

document.querySelectorAll(".block-type-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.type;
    addModal.classList.add("hidden");
    if (type === "songs") {
      blocks.push({ id: makeId(), type, count: 3 });
      renderBlocks(); saveShow();
      closeAllModals();
      return;
    }
    const newBlock = { id: makeId(), type, mode: null, duration: 15 };
    openModeModal(newBlock, /* isNew */ true);
  });
});

// ====================== MODE MODAL (quiet / record / background) ======================
let modeModalTarget = null;
let modeModalIsNew = false;

function openModeModal(block, isNew = false) {
  openModalPushHistory();
  modeModalTarget = block;
  modeModalIsNew = isNew;
  document.getElementById("mode-modal-title").textContent =
    `How should "${TYPE_LABELS[block.type]}" work?`;
  addModal.classList.add("hidden");
  durationModal.classList.add("hidden");
  recorderModal.classList.add("hidden");
  modeModal.classList.remove("hidden");
}

document.getElementById("close-mode-modal").addEventListener("click", closeAllModals);

document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    const block = modeModalTarget;
    if (!block) return;
    modeModal.classList.add("hidden");

    if (mode === "quiet") {
      openDurationModal(block, "quiet");
    } else if (mode === "background") {
      openDurationModal(block, "background");
    } else if (mode === "record") {
      openRecorderModal(block);
    }
  });
});

// ====================== DURATION MODAL (seconds or minutes) ======================
// Used for both "quiet" (silence) and "background" (music) blocks — background
// music doesn't have to run for its own full length: if the chosen duration is
// shorter it just gets cut off, and if it's longer Spotify is told to repeat
// the track/playlist so the music loops for as long as needed.
const durationValueInput = document.getElementById("duration-value");
const durationUnitSelect = document.getElementById("duration-unit");
let pendingDurationMode = "quiet";

function openDurationModal(block, mode) {
  modeModalTarget = block;
  pendingDurationMode = mode;
  const secs = block.duration || 15;
  if (secs >= 60 && secs % 60 === 0) {
    durationValueInput.value = secs / 60;
    durationUnitSelect.value = "minutes";
  } else {
    durationValueInput.value = secs;
    durationUnitSelect.value = "seconds";
  }
  document.getElementById("duration-modal-title").textContent =
    mode === "background" ? "How long should the music play?" : "How long?";
  modeModal.classList.add("hidden");
  durationModal.classList.remove("hidden");
}

document.getElementById("close-duration-modal").addEventListener("click", closeAllModals);

document.getElementById("duration-save-btn").addEventListener("click", () => {
  const block = modeModalTarget;
  if (!block) return;
  const raw = parseFloat(durationValueInput.value);
  const value = isNaN(raw) || raw <= 0 ? 15 : raw;
  const secs = durationUnitSelect.value === "minutes" ? Math.round(value * 60) : Math.round(value);
  block.mode = pendingDurationMode;
  block.duration = Math.min(secs, 3600);
  finalizeBlockAdd(block);
});

function finalizeBlockAdd(block) {
  if (modeModalIsNew) {
    blocks.push(block);
  }
  renderBlocks();
  saveShow();
  closeAllModals();
}

// ====================== RECORDER MODAL ======================
let mediaRecorder = null;
let recordedChunks = [];
let recordTimerInterval = null;
let recordSeconds = 0;
let pendingRecordingBlob = null;

const recorderMainBtn = document.getElementById("recorder-main-btn");
const recorderTimer = document.getElementById("recorder-timer");
const recorderPreview = document.getElementById("recorder-preview");
const recorderSaveBtn = document.getElementById("recorder-save-btn");
const recorderRetryBtn = document.getElementById("recorder-retry-btn");

function openRecorderModal(block) {
  modeModalTarget = block;
  resetRecorderUI();
  recorderModal.classList.remove("hidden");
}

function resetRecorderUI() {
  recorderMainBtn.classList.remove("hidden");
  recorderMainBtn.textContent = "⏺ Start Recording";
  recorderMainBtn.disabled = false;
  recorderTimer.classList.add("hidden");
  recorderTimer.textContent = "00:00";
  recorderPreview.classList.add("hidden");
  recorderPreview.removeAttribute("src");
  recorderSaveBtn.classList.add("hidden");
  recorderRetryBtn.classList.add("hidden");
  pendingRecordingBlob = null;
  recordSeconds = 0;
  if (recordTimerInterval) clearInterval(recordTimerInterval);
}

document.getElementById("close-recorder-modal").addEventListener("click", closeAllModals);

function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

let micStream = null;
function stopMicStream() {
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
}

recorderMainBtn.addEventListener("click", async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("Couldn't access the microphone. Please allow microphone permission and try again.");
    return;
  }
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    stopMicStream();
    clearInterval(recordTimerInterval);
    const blob = new Blob(recordedChunks, { type: "audio/webm" });
    pendingRecordingBlob = blob;
    recorderPreview.src = URL.createObjectURL(blob);
    recorderPreview.classList.remove("hidden");
    recorderMainBtn.classList.add("hidden");
    recorderSaveBtn.classList.remove("hidden");
    recorderRetryBtn.classList.remove("hidden");
  };
  mediaRecorder.start();
  recordSeconds = 0;
  recorderTimer.textContent = "00:00";
  recorderTimer.classList.remove("hidden");
  recorderMainBtn.textContent = "⏹ Stop Recording";
  recordTimerInterval = setInterval(() => {
    recordSeconds++;
    recorderTimer.textContent = formatTime(recordSeconds);
    if (recordSeconds >= 60) mediaRecorder.stop();
  }, 1000);
});

recorderRetryBtn.addEventListener("click", () => {
  resetRecorderUI();
});

recorderSaveBtn.addEventListener("click", async () => {
  const block = modeModalTarget;
  if (!block || !pendingRecordingBlob) return;
  await saveRecording(block.id, pendingRecordingBlob);
  block.mode = "record";
  finalizeBlockAdd(block);
  recorderModal.classList.add("hidden");
});

// ====================== LOOP ======================
const loopToggle = document.getElementById("loop-toggle");
loopToggle.addEventListener("change", (e) => {
  loopEnabled = e.target.checked;
});

// ====================== SPOTIFY AUTH (PKCE) ======================
function generateRandomString(length) {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await window.crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function loginWithSpotify() {
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  localStorage.setItem("spotify_code_verifier", codeVerifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    state: generateRandomString(16)
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function handleRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return false;

  const codeVerifier = localStorage.getItem("spotify_code_verifier");
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await res.json();
  if (data.access_token) {
    saveToken(data);
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  }
  return false;
}

function saveToken(data) {
  accessToken = data.access_token;
  localStorage.setItem("spotify_access_token", accessToken);
  localStorage.setItem("spotify_token_expires_at", String(Date.now() + (data.expires_in || 3600) * 1000));
  if (data.refresh_token) {
    localStorage.setItem("spotify_refresh_token", data.refresh_token);
  }
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem("spotify_refresh_token");
  if (!refreshToken) return false;
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    });
    const data = await res.json();
    if (data.access_token) {
      saveToken(data);
      return true;
    }
  } catch (e) {}
  return false;
}

async function refreshTokenIfNeeded() {
  accessToken = localStorage.getItem("spotify_access_token");
  if (!accessToken) return false;
  const expiresAt = parseInt(localStorage.getItem("spotify_token_expires_at") || "0", 10);
  if (Date.now() > expiresAt - 60000) {
    return await refreshAccessToken();
  }
  return true;
}

// ====================== SPOTIFY CONNECT (control the Spotify app on this phone/device) ======================
// The Web Playback SDK (a browser tab acting as the speaker) is not supported on mobile
// browsers, so instead we control whichever device already has the real Spotify app open,
// using the same Spotify Connect mechanism as Spotify's own "cast to a device" feature.
const deviceHint = document.getElementById("device-hint");
const loginBtn = document.getElementById("login-btn");
const spotifyConnectedEl = document.getElementById("spotify-connected");
const refreshDeviceBtn = document.getElementById("refresh-device-btn");

async function fetchDevices() {
  if (!accessToken) return { devices: [], error: "not logged in" };
  try {
    let res = await fetch("https://api.spotify.com/v1/me/player/devices", {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (!refreshed) return { devices: [], error: "your Spotify login expired — tap Connect Spotify again" };
      res = await fetch("https://api.spotify.com/v1/me/player/devices", {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
    }
    if (!res.ok) return { devices: [], error: `Spotify returned an error (${res.status})` };
    const data = await res.json();
    return { devices: data.devices || [], error: null };
  } catch (e) {
    return { devices: [], error: "couldn't reach Spotify (check your internet connection)" };
  }
}

function showConnected() {
  loginBtn.classList.add("hidden");
  deviceHint.classList.add("hidden");
  spotifyConnectedEl.classList.remove("hidden");
}

function showNeedsDevice(message) {
  loginBtn.classList.add("hidden");
  spotifyConnectedEl.classList.add("hidden");
  deviceHint.classList.remove("hidden");
  const hintText = document.getElementById("device-hint-text");
  if (hintText) {
    hintText.textContent = message ||
      "Open the Spotify app on this phone and press play on any song, then tap Refresh.";
  }
}

function showLoggedOut() {
  loginBtn.classList.remove("hidden");
  spotifyConnectedEl.classList.add("hidden");
  deviceHint.classList.add("hidden");
}

async function ensureDevice() {
  if (!accessToken) { showLoggedOut(); return false; }
  const ok = await refreshTokenIfNeeded();
  if (!ok) {
    accessToken = null;
    localStorage.removeItem("spotify_access_token");
    showLoggedOut();
    return false;
  }
  const { devices, error } = await fetchDevices();
  if (error) {
    deviceId = null;
    showNeedsDevice(`Couldn't check for a Spotify device: ${error}.`);
    return false;
  }
  if (devices.length === 0) {
    deviceId = null;
    showNeedsDevice();
    return false;
  }
  const active = devices.find(d => d.is_active) || devices[0];
  deviceId = active.id;
  currentVolumePercent = typeof active.volume_percent === "number" ? active.volume_percent : 80;
  showConnected();
  return true;
}

if (refreshDeviceBtn) {
  refreshDeviceBtn.addEventListener("click", () => ensureDevice());
}

function extractPlaylistOrTrackUri(urlOrUri) {
  if (!urlOrUri) return null;
  let match = urlOrUri.match(/playlist[/:]([a-zA-Z0-9]+)/);
  if (match) return `spotify:playlist:${match[1]}`;
  match = urlOrUri.match(/track[/:]([a-zA-Z0-9]+)/);
  if (match) return `spotify:track:${match[1]}`;
  match = urlOrUri.match(/album[/:]([a-zA-Z0-9]+)/);
  if (match) return `spotify:album:${match[1]}`;
  return null;
}

async function playContextUri(contextUri, isTrack, offsetPosition = 0) {
  if (!deviceId || !accessToken) return false;
  try {
    await fetch(`https://api.spotify.com/v1/me/player`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], play: false })
    });
    await new Promise(r => setTimeout(r, 400));
    const body = isTrack ? { uris: [contextUri] } : { context_uri: contextUri, offset: { position: offsetPosition } };
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return true;
  } catch (e) {
    console.error("Playback error", e);
    return false;
  }
}

// Rather than starting a pasted playlist link from track 1 every time, hand off
// to whatever the parent already has open and selected in the real Spotify app:
// if it hasn't really started yet, just play it; if it's already under way,
// move on to the next track so the same song isn't replayed from the top.
async function startPlaylistPlayback() {
  if (!deviceId || !accessToken) return;
  try {
    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (res.status === 204 || !res.ok) {
      // Nothing selected/loaded in Spotify yet — ask the parent to pick something and retry shortly.
      updateLiveUI("Now Playing", "Waiting for Spotify…", "Open Spotify, pick a playlist, then press play");
      activePlaybackTimer = setTimeout(() => runCurrentBlock(), 2000);
      return;
    }
    const data = await res.json();
    const progressMs = data.progress_ms || 0;
    const HAS_STARTED_THRESHOLD_MS = 2000;
    if (progressMs > HAS_STARTED_THRESHOLD_MS) {
      await nextTrackSpotify();
    } else {
      await resumeSpotify();
    }
  } catch (e) {
    console.error("Playlist handoff error", e);
    setTimeout(onTrackEnded, 10000);
  }
}

async function playNextSpotifyTrack() {
  if (songsPlayedInBlock === 0) {
    await startPlaylistPlayback();
  } else {
    await nextTrackSpotify();
  }
}

async function nextTrackSpotify() {
  if (!deviceId || !accessToken) return;
  try {
    await fetch(`https://api.spotify.com/v1/me/player/next?device_id=${deviceId}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
  } catch (e) {}
}

async function pauseSpotify() {
  if (!deviceId || !accessToken) return;
  try {
    await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
  } catch (e) {}
}

async function resumeSpotify() {
  if (!deviceId || !accessToken) return;
  try {
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
  } catch (e) {}
}

async function setSpotifyVolume(percent0to1) {
  if (!deviceId || !accessToken) return;
  currentVolumePercent = Math.round(percent0to1 * 100);
  try {
    await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${currentVolumePercent}&device_id=${deviceId}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
  } catch (e) {}
}

// state: "track" | "context" | "off" — used so background music can loop for
// as long as its block's duration needs, even past the track/playlist's own length.
async function setRepeatMode(state) {
  if (!deviceId || !accessToken) return;
  try {
    await fetch(`https://api.spotify.com/v1/me/player/repeat?state=${state}&device_id=${deviceId}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
  } catch (e) {}
}

async function seekSpotify(positionMs) {
  if (!deviceId || !accessToken) return;
  try {
    await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${Math.round(positionMs)}&device_id=${deviceId}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
  } catch (e) {}
}

// ====================== TRACK-CHANGE POLLING ======================
// Spotify Connect (unlike the Web Playback SDK) doesn't push track-change
// events to us, so while a "songs" block is playing we poll for the
// currently playing track to detect when it changes.
async function pollCurrentTrack() {
  if (!isPlaying || !accessToken) return;
  try {
    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (res.status === 204 || !res.ok) return;
    const data = await res.json();
    if (data.item) {
      trackDurationMs = data.item.duration_ms || 0;
      trackProgressMsAtPoll = data.progress_ms || 0;
      trackProgressPolledAt = Date.now();
    }
    const uri = data.item?.uri;
    if (uri && uri !== lastTrackUri) {
      const isFirst = lastTrackUri === null;
      lastTrackUri = uri;
      if (data.item && statusSub) {
        statusSub.textContent = data.item.name + " – " + (data.item.artists?.[0]?.name || "");
      }
      if (!isFirst) onTrackEnded();
    }
  } catch (e) {}
}

// Between polls, estimate the song's live position so the progress bar and
// elapsed/remaining time move smoothly instead of jumping every 900ms.
function startProgressTicker() {
  stopProgressTicker();
  progressTickInterval = setInterval(() => {
    if (!trackDurationMs || isScrubbing) return;
    const estMs = Math.min(trackDurationMs, trackProgressMsAtPoll + (Date.now() - trackProgressPolledAt));
    updateProgress(estMs / 1000, trackDurationMs / 1000);
  }, 250);
}

function stopProgressTicker() {
  if (progressTickInterval) { clearInterval(progressTickInterval); progressTickInterval = null; }
}

function startTrackPolling() {
  stopTrackPolling();
  // Fairly short interval: Spotify Connect gives us no push notification when a
  // track changes, so this poll is the only way we find out — and the parent
  // noticed the "Song X of Y" display visibly lagging behind the real audio.
  trackPollInterval = setInterval(pollCurrentTrack, 900);
}

function stopTrackPolling() {
  if (trackPollInterval) { clearInterval(trackPollInterval); trackPollInterval = null; }
}

// ====================== SHOW ENGINE ======================
function updateLiveUI(label, main, sub) {
  statusLabel.textContent = label;
  statusMain.textContent = main;
  statusSub.textContent = sub;
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

const timeElapsedEl = document.getElementById("time-elapsed");
const timeRemainingEl = document.getElementById("time-remaining");

function updateProgress(elapsedSec, durationSec) {
  if (durationSec && durationSec > 0 && isFinite(durationSec)) {
    const pct = Math.min(100, Math.max(0, (elapsedSec / durationSec) * 100));
    progressFill.style.width = pct + "%";
    if (timeElapsedEl) timeElapsedEl.textContent = formatClock(elapsedSec);
    if (timeRemainingEl) timeRemainingEl.textContent = "-" + formatClock(Math.max(0, durationSec - elapsedSec));
  } else {
    // Open-ended (e.g. background music with no fixed length) — just count up.
    progressFill.style.width = "100%";
    if (timeElapsedEl) timeElapsedEl.textContent = formatClock(elapsedSec);
    if (timeRemainingEl) timeRemainingEl.textContent = "";
  }
}

function clearActivePlayback() {
  // Pauses without destroying anything, so a paused block can pick up again
  // from exactly where it left off (see isResuming in runCurrentBlock).
  if (activePlaybackTimer) { clearTimeout(activePlaybackTimer); activePlaybackTimer = null; }
  if (activeAudioEl) activeAudioEl.pause();
  stopProgressTicker();
}

function getNextBlockPreview() {
  const next = blocks[currentBlockIndex + 1];
  if (!next) return loopEnabled ? "Loop → start again" : "End of show";
  if (next.type === "songs") return `Play ${next.count} Songs`;
  return TYPE_LABELS[next.type];
}

function setLiveButtonsForBlock(block) {
  const isSongs = block.type === "songs";
  skipSongBtn.classList.toggle("hidden", !isSongs);
  finishedTalkingBtn.classList.toggle("hidden", isSongs);
}

// ====================== PROGRESS BAR SCRUBBING (press and drag to seek) ======================
let scrubDurationSec = 0;

function getCurrentDurationSec() {
  const block = blocks[currentBlockIndex];
  if (!block) return 0;
  if (block.type === "songs") return trackDurationMs ? trackDurationMs / 1000 : 0;
  if (block.mode === "record") return activeAudioEl && isFinite(activeAudioEl.duration) ? activeAudioEl.duration : 0;
  return blockDurationSeconds || 0; // quiet / background
}

function scrubFractionFromEvent(e, barEl) {
  const rect = barEl.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
  return rect.width > 0 ? x / rect.width : 0;
}

async function commitScrub(targetSec) {
  const block = blocks[currentBlockIndex];
  if (!block) return;
  const clamped = Math.max(0, Math.min(targetSec, scrubDurationSec));

  if (block.type === "songs") {
    trackProgressMsAtPoll = clamped * 1000;
    trackProgressPolledAt = Date.now();
    updateProgress(clamped, scrubDurationSec);
    await seekSpotify(clamped * 1000);
  } else if (block.mode === "record" && activeAudioEl) {
    activeAudioEl.currentTime = clamped;
    updateProgress(clamped, scrubDurationSec);
  } else {
    // quiet or background — there's no real media to seek, just fast-forward/rewind our own countdown
    blockRemainingSeconds = Math.max(0, Math.round(scrubDurationSec - clamped));
    updateProgress(clamped, scrubDurationSec);
    if (block.mode === "background") await seekSpotify(clamped * 1000);
  }
}

function setupProgressScrubbing() {
  const hitEl = document.getElementById("progress-bar-hit");
  const barEl = document.getElementById("progress-bar");
  if (!hitEl || !barEl) return;

  hitEl.addEventListener("pointerdown", (e) => {
    const duration = getCurrentDurationSec();
    if (!duration || duration <= 0) return;
    isScrubbing = true;
    scrubDurationSec = duration;
    barEl.classList.add("scrubbing");
    try { hitEl.setPointerCapture(e.pointerId); } catch (err) {}
    updateProgress(scrubFractionFromEvent(e, barEl) * scrubDurationSec, scrubDurationSec);
  });

  hitEl.addEventListener("pointermove", (e) => {
    if (!isScrubbing) return;
    updateProgress(scrubFractionFromEvent(e, barEl) * scrubDurationSec, scrubDurationSec);
  });

  function endScrub(e) {
    if (!isScrubbing) return;
    isScrubbing = false;
    barEl.classList.remove("scrubbing");
    const targetSec = scrubFractionFromEvent(e, barEl) * scrubDurationSec;
    commitScrub(targetSec);
  }

  hitEl.addEventListener("pointerup", endScrub);
  hitEl.addEventListener("pointercancel", () => {
    isScrubbing = false;
    barEl.classList.remove("scrubbing");
  });
}

setupProgressScrubbing();

// ====================== LIVE-SCREEN TIMETABLE ======================
const TIMETABLE_SHORT_LABELS = { jingle: "Jingle", talk: "News", bed: "DJ Talk", commercial: "Ad Break" };
const timetableEl = document.getElementById("timetable");

function renderTimetable() {
  if (!timetableEl) return;
  timetableEl.innerHTML = "";
  blocks.forEach((block, i) => {
    const chip = document.createElement("div");
    chip.className = `timetable-chip ${block.type}`;
    if (i < currentBlockIndex) chip.classList.add("played");
    if (i === currentBlockIndex) chip.classList.add("current");
    const icon = block.type === "songs" ? "🎵" : TYPE_ICONS[block.type];
    const label = block.type === "songs" ? `${block.count} Songs` : TIMETABLE_SHORT_LABELS[block.type];
    chip.innerHTML = `<span class="tt-icon">${icon}</span><span class="tt-label">${label}</span>`;
    timetableEl.appendChild(chip);
  });
  const currentChip = timetableEl.children[currentBlockIndex];
  if (currentChip) currentChip.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
}

async function runCurrentBlock() {
  const resuming = isResuming;
  isResuming = false;
  clearActivePlayback();

  if (currentBlockIndex >= blocks.length) {
    if (loopEnabled) {
      currentBlockIndex = 0;
      songsPlayedInBlock = 0;
      runCurrentBlock();
      return;
    } else {
      showInProgress = false;
      blockRemainingSeconds = null;
      blockDurationSeconds = null;
      activeAudioEl = null;
      liveScreen.classList.add("hidden");
      endScreen.classList.remove("hidden");
      return;
    }
  }

  const block = blocks[currentBlockIndex];
  nextUp.textContent = "Next up: " + getNextBlockPreview();
  renderTimetable();
  setLiveButtonsForBlock(block);

  if (block.type === "songs") {
    if (!resuming) {
      songsPlayedInBlock = 0;
      lastTrackUri = null;
    }
    updateLiveUI("Now Playing", `Song ${songsPlayedInBlock + 1} of ${block.count}`, resuming ? "Resuming..." : "Starting playlist...");
    isPlaying = true;
    if (resuming) {
      await resumeSpotify();
    } else {
      // Defensive: a previous background-music block may have left Spotify
      // set to repeat a single track/context, which would otherwise trap
      // playback on the first song instead of moving through the playlist.
      await setRepeatMode("off");
      await playNextSpotifyTrack();
    }
    startTrackPolling();
    startProgressTicker();
    return;
  }

  stopTrackPolling();
  isPlaying = false;
  const label = TYPE_LABELS[block.type];

  if (block.mode === "record") {
    await pauseSpotify();
    updateLiveUI(label, "Playing recording...", "Listen up!");
    if (resuming && activeAudioEl) {
      updateProgress(activeAudioEl.currentTime, activeAudioEl.duration);
      activeAudioEl.play().catch(() => {});
      return;
    }
    activeAudioEl = null;
    const blob = await loadRecording(block.id);
    if (!blob) {
      // No recording saved, fall back to a short quiet pause
      updateLiveUI(label, "🤫 ...", "(no recording found)");
      updateProgress(0, 0);
      activePlaybackTimer = setTimeout(() => { currentBlockIndex++; runCurrentBlock(); }, 3000);
      return;
    }
    const audio = new Audio(URL.createObjectURL(blob));
    activeAudioEl = audio;
    audio.addEventListener("loadedmetadata", () => updateProgress(0, audio.duration));
    audio.addEventListener("timeupdate", () => { if (!isScrubbing) updateProgress(audio.currentTime, audio.duration); });
    audio.addEventListener("ended", () => {
      activeAudioEl = null;
      currentBlockIndex++;
      runCurrentBlock();
    });
    audio.play().catch(() => {
      activePlaybackTimer = setTimeout(() => { currentBlockIndex++; runCurrentBlock(); }, 3000);
    });
  }
  else if (block.mode === "background") {
    await pauseSpotify();
    const duration = block.duration || 20;
    if (!resuming || blockRemainingSeconds === null) {
      blockRemainingSeconds = duration;
      blockDurationSeconds = duration;
    }
    updateProgress(blockDurationSeconds - blockRemainingSeconds, blockDurationSeconds);
    const tick = () => {
      if (isScrubbing) { activePlaybackTimer = setTimeout(tick, 200); return; }
      blockRemainingSeconds--;
      updateProgress(blockDurationSeconds - blockRemainingSeconds, blockDurationSeconds);
      if (blockRemainingSeconds <= 0) {
        blockRemainingSeconds = null;
        blockDurationSeconds = null;
        setRepeatMode("off");
        currentBlockIndex++;
        runCurrentBlock();
      } else {
        activePlaybackTimer = setTimeout(tick, 1000);
      }
    };
    activePlaybackTimer = setTimeout(tick, 1000);

    const bgRaw = bgMusicInput.value.trim();
    const bgUri = extractPlaylistOrTrackUri(bgRaw);
    if (bgUri) {
      updateLiveUI(label, "Background music playing", "Talk over it! Press green when done");
      if (resuming) {
        await resumeSpotify();
      } else {
        const isTrack = bgUri.startsWith("spotify:track:");
        // Loop the music for as long as this block's duration needs, even if
        // that's longer than the track/playlist itself.
        await setRepeatMode(isTrack ? "track" : "context");
        await setSpotifyVolume(0.25);
        await playContextUri(bgUri, isTrack);
      }
    } else {
      updateLiveUI(label, "Your turn to talk!", "(no background music set) Press green when done");
    }
    // Auto-advances when the timer runs out, or press "I'm finished talking" to skip early.
  }
  else {
    // quiet
    await pauseSpotify();
    const duration = block.duration || 10;
    if (!resuming || blockRemainingSeconds === null) {
      if (block.type === "jingle") playHappyChime();
      blockRemainingSeconds = duration;
      blockDurationSeconds = duration;
    }
    updateLiveUI(label, block.type === "jingle" ? "🎶 Jingle time!" : "🤫 Shhh...", "Press green when done");
    updateProgress(blockDurationSeconds - blockRemainingSeconds, blockDurationSeconds);
    const tick = () => {
      if (isScrubbing) { activePlaybackTimer = setTimeout(tick, 200); return; }
      blockRemainingSeconds--;
      updateProgress(blockDurationSeconds - blockRemainingSeconds, blockDurationSeconds);
      if (blockRemainingSeconds <= 0) {
        blockRemainingSeconds = null;
        blockDurationSeconds = null;
        currentBlockIndex++;
        runCurrentBlock();
      } else {
        activePlaybackTimer = setTimeout(tick, 1000);
      }
    };
    activePlaybackTimer = setTimeout(tick, 1000);
  }
}

function onTrackEnded() {
  if (!isPlaying) return;
  const block = blocks[currentBlockIndex];
  if (block && block.type === "songs") {
    songsPlayedInBlock++;
    if (songsPlayedInBlock >= block.count) {
      isPlaying = false;
      currentBlockIndex++;
      runCurrentBlock();
    } else {
      updateLiveUI("Now Playing", `Song ${songsPlayedInBlock + 1} of ${block.count}`, "Music from Spotify");
    }
  }
}

// ====================== BUTTON HANDLERS ======================
document.getElementById("start-show-btn").addEventListener("click", async () => {
  if (!accessToken) {
    alert("Please connect Spotify first!");
    return;
  }
  const hasDevice = await ensureDevice();
  if (!hasDevice) {
    alert("Open the Spotify app on this phone and press play on any song, then try again.");
    return;
  }
  if (blocks.length === 0) {
    alert("Add at least one block!");
    return;
  }
  saveShow();
  isResuming = showInProgress; // false = fresh start, true = continue where we left off
  if (!isResuming) {
    currentBlockIndex = 0;
    songsPlayedInBlock = 0;
  }
  showInProgress = true;
  isPaused = false;
  pushShowHistory();
  updateStartButtonLabel();
  builderScreen.classList.add("hidden");
  liveScreen.classList.remove("hidden");
  endScreen.classList.add("hidden");
  runCurrentBlock();
});

document.getElementById("new-show-link").addEventListener("click", () => {
  if (!confirm("Start a brand new show? This resets your blocks back to the default show.")) return;
  blocks = getDefaultBlocks();
  currentBlockIndex = 0;
  songsPlayedInBlock = 0;
  showInProgress = false;
  blockRemainingSeconds = null;
  blockDurationSeconds = null;
  activeAudioEl = null;
  renderBlocks();
  saveShow();
  updateStartButtonLabel();
});

finishedTalkingBtn.addEventListener("click", async () => {
  clearActivePlayback();
  blockRemainingSeconds = null;
  blockDurationSeconds = null;
  await setSpotifyVolume(0.8);
  await setRepeatMode("off");
  currentBlockIndex++;
  runCurrentBlock();
});

skipSongBtn.addEventListener("click", async () => {
  await nextTrackSpotify();
  // Don't wait for the regular poll interval — check right away (with a short
  // delay for Spotify to register the skip) so the display updates promptly.
  setTimeout(pollCurrentTrack, 350);
});

document.getElementById("pause-btn").addEventListener("click", async () => {
  if (isPaused) {
    await resumeSpotify();
    if (activeAudioEl) activeAudioEl.play();
    isPaused = false;
    document.getElementById("pause-btn").textContent = "Pause everything";
  } else {
    await pauseSpotify();
    if (activeAudioEl) activeAudioEl.pause();
    isPaused = true;
    document.getElementById("pause-btn").textContent = "Resume";
  }
});

document.getElementById("stop-show-btn").addEventListener("click", exitToBuilder);
document.getElementById("modify-session-btn").addEventListener("click", exitToBuilder);

document.getElementById("play-again-btn").addEventListener("click", () => {
  pushShowHistory(); // no-op if already pushed; keeps a single "back → home" level
  showInProgress = true;
  isResuming = false;
  endScreen.classList.add("hidden");
  liveScreen.classList.remove("hidden");
  currentBlockIndex = 0;
  songsPlayedInBlock = 0;
  runCurrentBlock();
});

document.getElementById("back-to-builder-btn").addEventListener("click", exitToBuilder);

document.getElementById("login-btn").addEventListener("click", loginWithSpotify);
bgMusicInput.addEventListener("change", saveShow);

// ====================== INIT ======================
async function init() {
  renderBlocks();

  await handleRedirect();
  accessToken = localStorage.getItem("spotify_access_token");
  if (accessToken) {
    await ensureDevice();
  }
}

// ====================== SPLASH SCREEN ======================
// A short, fun animation shown when the app is opened (from the home-screen
// icon or a fresh page load) — skipped when we're mid-way through the
// Spotify login redirect so that flow isn't interrupted.
const splashScreen = document.getElementById("splash-screen");
const splashPhraseEl = document.getElementById("splash-phrase");
const splashTapHint = document.getElementById("splash-tap-hint");

const SPLASH_DURATION_MS = 4200;
const SPLASH_TAP_HINT_DELAY_MS = 1900;
const SPLASH_PHRASES = [
  "Warming up the mic",
  "Tuning the antenna",
  "Cueing up the tunes",
  "Dusting off the turntable"
];

function runSplashScreen() {
  const isSpotifyRedirect = new URLSearchParams(window.location.search).has("code");
  if (isSpotifyRedirect) {
    splashScreen.classList.add("hidden");
    builderScreen.classList.remove("hidden");
    return;
  }

  let phraseIndex = 0;
  const phraseInterval = setInterval(() => {
    phraseIndex = (phraseIndex + 1) % SPLASH_PHRASES.length;
    splashPhraseEl.textContent = SPLASH_PHRASES[phraseIndex];
  }, 900);

  let finished = false;
  function finishSplash() {
    if (finished) return;
    finished = true;
    clearInterval(phraseInterval);
    splashScreen.classList.add("splash-fade-out");
    setTimeout(() => {
      splashScreen.classList.add("hidden");
      builderScreen.classList.remove("hidden");
    }, 400);
  }

  setTimeout(finishSplash, SPLASH_DURATION_MS);
  setTimeout(() => splashTapHint.classList.remove("hidden"), SPLASH_TAP_HINT_DELAY_MS);
  splashScreen.addEventListener("click", finishSplash, { once: true });
}

runSplashScreen();
init();
