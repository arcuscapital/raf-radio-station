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
function loadSavedShow() {
  try {
    const raw = localStorage.getItem("radio_show_blocks");
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return [
    { id: "b1", type: "jingle", label: "Welcome Jingle", mode: "quiet", duration: 3 },
    { id: "b2", type: "songs", count: 4 },
    { id: "b3", type: "talk", label: "Talk Time – News", mode: "quiet", duration: 15 },
    { id: "b4", type: "songs", count: 3 },
    { id: "b5", type: "bed", label: "Talk-over Music", mode: "background", duration: 20 },
    { id: "b6", type: "commercial", label: "Commercial Break", mode: "quiet", duration: 10 },
    { id: "b7", type: "songs", count: 3 },
    { id: "b8", type: "jingle", label: "Closing Jingle", mode: "quiet", duration: 3 }
  ];
}

function saveShow() {
  localStorage.setItem("radio_show_blocks", JSON.stringify(blocks));
  localStorage.setItem("radio_bg_music", bgMusicInput.value.trim());
  localStorage.setItem("radio_playlist", playlistInput.value.trim());
}

let blocks = loadSavedShow();
let nextIdNum = Date.now();
function makeId() { return "b" + (nextIdNum++); }

let loopEnabled = false;
let currentBlockIndex = 0;
let songsPlayedInBlock = 0;
let isPlaying = false;
let spotifyPlayer = null;
let deviceId = null;
let accessToken = null;
let isPaused = false;
let playlistUri = "spotify:playlist:37i9dQZF1E4CPcTtDJiVpn";
let lastTrackUri = null;
let activePlaybackTimer = null;
let activeAudioEl = null;

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
const playlistInput = document.getElementById("playlist-input");
const bgMusicInput = document.getElementById("bg-music-input");
const skipSongBtn = document.getElementById("skip-song-btn");
const finishedTalkingBtn = document.getElementById("finished-talking-btn");

playlistInput.value = localStorage.getItem("radio_playlist") || playlistInput.value;
bgMusicInput.value = localStorage.getItem("radio_bg_music") || "";

const MODE_LABELS = { quiet: "🤫 Quiet", record: "🎙️ Recorded", background: "🎶 Background" };
const TYPE_LABELS = { jingle: "Jingle", talk: "Talk Time – News", bed: "Talk-over Music", commercial: "Commercial Break" };
const TYPE_ICONS = { jingle: "🎤", talk: "🗣️", bed: "🎶", commercial: "📢" };

// ====================== RENDER BLOCKS ======================
function renderBlocks() {
  blocksList.innerHTML = "";
  blocks.forEach((block, index) => {
    const card = document.createElement("div");
    card.className = `block-card ${block.type}`;
    card.dataset.index = index;
    card.draggable = true;

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
      leftContent = `<span class="block-icon">${TYPE_ICONS[block.type]}</span> ${block.label || TYPE_LABELS[block.type]} <span class="block-mode-badge">${MODE_LABELS[block.mode] || ""}</span>`;
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

    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", index);
      card.style.opacity = "0.5";
    });
    card.addEventListener("dragend", () => {
      card.style.opacity = "1";
    });
    card.addEventListener("dragover", (e) => e.preventDefault());
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/plain"));
      const to = index;
      if (from !== to) {
        const [moved] = blocks.splice(from, 1);
        blocks.splice(to, 0, moved);
        renderBlocks(); saveShow();
      }
    });

    blocksList.appendChild(card);
  });
}

// ====================== ADD BLOCK ======================
document.getElementById("add-block-btn").addEventListener("click", () => {
  addModal.classList.remove("hidden");
});

document.getElementById("close-modal").addEventListener("click", () => {
  addModal.classList.add("hidden");
});

document.querySelectorAll(".block-type-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.type;
    addModal.classList.add("hidden");
    if (type === "songs") {
      blocks.push({ id: makeId(), type, count: 3 });
      renderBlocks(); saveShow();
      return;
    }
    const newBlock = { id: makeId(), type, label: TYPE_LABELS[type], mode: null, duration: 15 };
    openModeModal(newBlock, /* isNew */ true);
  });
});

// ====================== MODE MODAL (quiet / record / background) ======================
let modeModalTarget = null;
let modeModalIsNew = false;

function openModeModal(block, isNew = false) {
  modeModalTarget = block;
  modeModalIsNew = isNew;
  document.getElementById("mode-modal-title").textContent =
    `How should "${block.label || TYPE_LABELS[block.type]}" work?`;
  modeModal.classList.remove("hidden");
}

document.getElementById("close-mode-modal").addEventListener("click", () => {
  modeModal.classList.add("hidden");
  modeModalTarget = null;
});

document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    const block = modeModalTarget;
    if (!block) return;
    modeModal.classList.add("hidden");

    if (mode === "quiet") {
      const answer = prompt("How many seconds of quiet? (e.g. 15)", block.duration || 15);
      const secs = parseInt(answer, 10);
      block.mode = "quiet";
      block.duration = isNaN(secs) || secs <= 0 ? 15 : Math.min(secs, 120);
      finalizeBlockAdd(block);
    } else if (mode === "background") {
      block.mode = "background";
      finalizeBlockAdd(block);
    } else if (mode === "record") {
      openRecorderModal(block);
    }
  });
});

function finalizeBlockAdd(block) {
  if (modeModalIsNew) {
    blocks.push(block);
  }
  renderBlocks();
  saveShow();
  modeModalTarget = null;
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

document.getElementById("close-recorder-modal").addEventListener("click", () => {
  stopMicStream();
  recorderModal.classList.add("hidden");
  modeModalTarget = null;
});

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
    accessToken = data.access_token;
    localStorage.setItem("spotify_access_token", accessToken);
    if (data.refresh_token) {
      localStorage.setItem("spotify_refresh_token", data.refresh_token);
    }
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  }
  return false;
}

async function refreshTokenIfNeeded() {
  accessToken = localStorage.getItem("spotify_access_token");
  return !!accessToken;
}

// ====================== SPOTIFY PLAYER ======================
window.onSpotifyWebPlaybackSDKReady = () => {
  // Initialized after login in init()
};

async function initPlayer() {
  if (!accessToken) return;

  spotifyPlayer = new Spotify.Player({
    name: "My Radio Station",
    getOAuthToken: cb => { cb(accessToken); },
    volume: 0.8
  });

  spotifyPlayer.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
    document.getElementById("login-btn").classList.add("hidden");
    document.getElementById("spotify-connected").classList.remove("hidden");
  });

  spotifyPlayer.addListener("not_ready", () => {});

  spotifyPlayer.addListener("player_state_changed", state => {
    if (!state) return;
    const currentUri = state.track_window?.current_track?.uri;
    if (currentUri && currentUri !== lastTrackUri) {
      if (lastTrackUri !== null && isPlaying) {
        onTrackEnded();
      }
      lastTrackUri = currentUri;
      const track = state.track_window.current_track;
      if (track && statusSub) {
        statusSub.textContent = track.name + " – " + (track.artists?.[0]?.name || "");
      }
    }
  });

  await spotifyPlayer.connect();
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

async function playContextUri(contextUri, isTrack) {
  if (!deviceId || !accessToken) return false;
  try {
    await fetch(`https://api.spotify.com/v1/me/player`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], play: false })
    });
    await new Promise(r => setTimeout(r, 400));
    const body = isTrack ? { uris: [contextUri] } : { context_uri: contextUri, offset: { position: 0 } };
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

async function startPlaylistPlayback() {
  const raw = playlistInput ? playlistInput.value.trim() : "";
  const uri = extractPlaylistOrTrackUri(raw) || playlistUri;
  playlistUri = uri;
  const ok = await playContextUri(uri, uri.startsWith("spotify:track:"));
  if (!ok) setTimeout(onTrackEnded, 10000);
}

async function playNextSpotifyTrack() {
  if (songsPlayedInBlock === 0) {
    await startPlaylistPlayback();
  } else if (spotifyPlayer) {
    try { await spotifyPlayer.nextTrack(); } catch (e) { console.error(e); }
  }
}

async function pauseSpotify() {
  if (spotifyPlayer) {
    try { await spotifyPlayer.pause(); } catch (e) {}
  }
}

async function resumeSpotify() {
  if (spotifyPlayer) {
    try { await spotifyPlayer.resume(); } catch (e) {}
  }
}

async function setSpotifyVolume(v) {
  if (spotifyPlayer) {
    try { await spotifyPlayer.setVolume(v); } catch (e) {}
  }
}

// ====================== SHOW ENGINE ======================
function updateLiveUI(label, main, sub, progress = 0) {
  statusLabel.textContent = label;
  statusMain.textContent = main;
  statusSub.textContent = sub;
  progressFill.style.width = `${progress}%`;
}

function clearActivePlayback() {
  if (activePlaybackTimer) { clearTimeout(activePlaybackTimer); activePlaybackTimer = null; }
  if (activeAudioEl) { activeAudioEl.pause(); activeAudioEl = null; }
}

function getNextBlockPreview() {
  const next = blocks[currentBlockIndex + 1];
  if (!next) return loopEnabled ? "Loop → start again" : "End of show";
  if (next.type === "songs") return `Play ${next.count} Songs`;
  return next.label || TYPE_LABELS[next.type];
}

function setLiveButtonsForBlock(block) {
  const isSongs = block.type === "songs";
  skipSongBtn.classList.toggle("hidden", !isSongs);
  finishedTalkingBtn.classList.toggle("hidden", isSongs);
}

async function runCurrentBlock() {
  clearActivePlayback();

  if (currentBlockIndex >= blocks.length) {
    if (loopEnabled) {
      currentBlockIndex = 0;
      songsPlayedInBlock = 0;
      runCurrentBlock();
      return;
    } else {
      liveScreen.classList.add("hidden");
      endScreen.classList.remove("hidden");
      return;
    }
  }

  const block = blocks[currentBlockIndex];
  nextUp.textContent = "Next up: " + getNextBlockPreview();
  setLiveButtonsForBlock(block);

  if (block.type === "songs") {
    songsPlayedInBlock = 0;
    lastTrackUri = null;
    updateLiveUI("Now Playing", `Song 1 of ${block.count}`, "Starting playlist...", 5);
    isPlaying = true;
    await playNextSpotifyTrack();
    return;
  }

  isPlaying = false;
  const label = block.label || TYPE_LABELS[block.type];

  if (block.mode === "record") {
    await pauseSpotify();
    updateLiveUI(label, "Playing recording...", "Listen up!", 0);
    const blob = await loadRecording(block.id);
    if (!blob) {
      // No recording saved, fall back to a short quiet pause
      updateLiveUI(label, "🤫 ...", "(no recording found)", 0);
      activePlaybackTimer = setTimeout(() => { currentBlockIndex++; runCurrentBlock(); }, 3000);
      return;
    }
    const audio = new Audio(URL.createObjectURL(blob));
    activeAudioEl = audio;
    audio.addEventListener("ended", () => { currentBlockIndex++; runCurrentBlock(); });
    audio.play().catch(() => {
      activePlaybackTimer = setTimeout(() => { currentBlockIndex++; runCurrentBlock(); }, 3000);
    });
  }
  else if (block.mode === "background") {
    await pauseSpotify();
    const bgRaw = bgMusicInput.value.trim();
    const bgUri = extractPlaylistOrTrackUri(bgRaw);
    if (bgUri) {
      updateLiveUI(label, "Background music playing", "Talk over it! Press green when done", 30);
      await setSpotifyVolume(0.25);
      await playContextUri(bgUri, bgUri.startsWith("spotify:track:"));
    } else {
      updateLiveUI(label, "Your turn to talk!", "(no background music set) Press green when done", 0);
    }
    // Waits for "I'm finished talking" button.
  }
  else {
    // quiet
    await pauseSpotify();
    if (block.type === "jingle") playHappyChime();
    const duration = block.duration || 10;
    let remaining = duration;
    updateLiveUI(label, block.type === "jingle" ? "🎶 Jingle time!" : "🤫 Shhh...", `${remaining}s left — or press green when done`, 0);
    const tick = () => {
      remaining--;
      const pct = ((duration - remaining) / duration) * 100;
      updateLiveUI(label, block.type === "jingle" ? "🎶 Jingle time!" : "🤫 Shhh...", `${Math.max(remaining, 0)}s left — or press green when done`, pct);
      if (remaining <= 0) {
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
      updateLiveUI(
        "Now Playing",
        `Song ${songsPlayedInBlock + 1} of ${block.count}`,
        "Music from Spotify",
        (songsPlayedInBlock / block.count) * 100
      );
    }
  }
}

// ====================== BUTTON HANDLERS ======================
document.getElementById("start-show-btn").addEventListener("click", async () => {
  if (!accessToken) {
    alert("Please connect Spotify first!");
    return;
  }
  if (blocks.length === 0) {
    alert("Add at least one block!");
    return;
  }
  saveShow();
  currentBlockIndex = 0;
  songsPlayedInBlock = 0;
  isPaused = false;
  builderScreen.classList.add("hidden");
  liveScreen.classList.remove("hidden");
  endScreen.classList.add("hidden");
  runCurrentBlock();
});

finishedTalkingBtn.addEventListener("click", async () => {
  clearActivePlayback();
  await setSpotifyVolume(0.8);
  currentBlockIndex++;
  runCurrentBlock();
});

skipSongBtn.addEventListener("click", async () => {
  if (spotifyPlayer) {
    try { await spotifyPlayer.nextTrack(); } catch (e) {}
  }
  onTrackEnded();
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

document.getElementById("stop-show-btn").addEventListener("click", async () => {
  clearActivePlayback();
  await pauseSpotify();
  isPlaying = false;
  liveScreen.classList.add("hidden");
  builderScreen.classList.remove("hidden");
});

document.getElementById("play-again-btn").addEventListener("click", () => {
  endScreen.classList.add("hidden");
  liveScreen.classList.remove("hidden");
  currentBlockIndex = 0;
  songsPlayedInBlock = 0;
  runCurrentBlock();
});

document.getElementById("back-to-builder-btn").addEventListener("click", () => {
  endScreen.classList.add("hidden");
  builderScreen.classList.remove("hidden");
});

document.getElementById("login-btn").addEventListener("click", loginWithSpotify);
playlistInput.addEventListener("change", saveShow);
bgMusicInput.addEventListener("change", saveShow);

// ====================== INIT ======================
async function init() {
  renderBlocks();

  const justLoggedIn = await handleRedirect();
  if (justLoggedIn || await refreshTokenIfNeeded()) {
    await initPlayer();
  }
}

init();
