"use strict";

// ============================================================
// Settings
// ============================================================

const AREA_KEY = "sortingArea";
const AUTO_KEY = "sortingAutoListen";

const HANDOVER_MS = 600;
const LISTEN_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;

const MIN_SUGGEST = 0.6;
const MAX_READ_RESULTS = 8;

const SpeechRec =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const SUFFIXES = new Set([
  "ROAD", "RD", "STREET", "ST", "AVENUE", "AVE",
  "CLOSE", "DRIVE", "DR", "LANE", "WAY", "COURT",
  "CT", "TERRACE", "CRESCENT", "GARDENS", "GROVE",
  "PARK", "WALK", "PLACE", "MEWS", "RISE", "HOUSE", "THE"
]);

const YES_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "correct", "right",
  "thats right", "thats it", "that one", "ok",
  "okay", "sure", "confirm"
]);

const NO_WORDS = new Set([
  "no", "nope", "wrong", "incorrect", "not that"
]);

const CANCEL_WORDS = new Set([
  "none", "neither", "none of these", "cancel",
  "try again", "start again"
]);

const NUMBER_WORDS = {
  oh: 0, zero: 0, one: 1, two: 2, three: 3,
  four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80,
  ninety: 90
};

const NUMBER_ALIASES = {
  won: "1", wan: "1", to: "2", too: "2", tu: "2",
  tree: "3", free: "3", for: "4", fore: "4",
  ate: "8", first: "1", second: "2", third: "3",
  fourth: "4", fifth: "5"
};

const NATO_LETTERS = {
  alpha: "A", alfa: "A", bravo: "B", charlie: "C",
  delta: "D", echo: "E", foxtrot: "F", golf: "G",
  hotel: "H", india: "I", juliet: "J", juliett: "J",
  kilo: "K", lima: "L", mike: "M", november: "N",
  oscar: "O", papa: "P", quebec: "Q", romeo: "R",
  sierra: "S", tango: "T", uniform: "U", victor: "V",
  whiskey: "W", whisky: "W", xray: "X", yankee: "Y",
  zulu: "Z"
};

const SPOKEN_LETTERS = {
  bee: "B", be: "B", cee: "C", see: "C",
  dee: "D", ee: "E", gee: "G", aitch: "H",
  jay: "J", kay: "K", el: "L", ell: "L",
  em: "M", en: "N", pea: "P", pee: "P",
  cue: "Q", queue: "Q", are: "R", ess: "S",
  tee: "T", tea: "T", you: "U", vee: "V",
  doubleyou: "W", ex: "X", why: "Y", zed: "Z", zee: "Z"
};

const HOUSES_AFTER_NAME =
  /^(.*?)\s+(\d{1,3}(?:-\d{1,3})?(?:\s+\d{1,3}(?:-\d{1,3})?)*)$/;

// ============================================================
// State
// ============================================================

let roads = [];
let ready = false;
let selectedArea = "ME10";
let interactionMode = "text";

let pending = null;
let suggestions = null;

const manifest = new Map();
let manifestReady = false;

// A single recogniser is created once and reused.
// It is never replaced while an old session may still be active.
let recognizer = null;
let micState = "idle";
let micReleasedAt = 0;
let runNumber = 0;

let activeRun = null;
let listenTimer = null;
let stopTimer = null;
let abortTimer = null;

// Playback.
let audio;
let nextAudio;
let playbackVersion = 0;
let playbackActive = false;
let queuedReply = null;
let lastReply = null;
let playbackTimer = null;
let autoTimer = null;
let cancelCurrentClip = null;

// Web Audio playback (avoids the <audio> element, which on iOS
// reconfigures the audio session and can leave the microphone stuck).
let audioCtx = null;
let activeSources = [];
const bufferCache = new Map();
const roadLoose = new Map();
let micStream = null;
let micReadyToggle;

const APP_VERSION = "Web Audio playback v1";
const CLIP_GAP_SECONDS = 0.15;
const MIC_READY_KEY = "sortingMicReady";

// Page elements.
let input;
let micBtn;
let transcript;
let results;
let letterGrid;
let walkGrid;
let roadTab;
let walkTab;
let me10Tab;
let me9Tab;
let areaLabel;

let replayBtn;
let autoToggle;
let audioStatus;
let micStatus;
let diagnosticPanel;
let diagnosticButton;

const diagnosticLines = [];

// ============================================================
// Startup
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  input = document.getElementById("roadSearch");
  micBtn = document.getElementById("micBtn");
  transcript = document.getElementById("transcript");
  results = document.getElementById("results");

  letterGrid = document.getElementById("letterGrid");
  walkGrid = document.getElementById("walkGrid");
  roadTab = document.getElementById("roadTab");
  walkTab = document.getElementById("walkTab");

  me10Tab = document.getElementById("me10Tab");
  me9Tab = document.getElementById("me9Tab");
  areaLabel = document.getElementById("areaLabel");

  audio = new Audio();
  audio.preload = "auto";

  nextAudio = new Audio();
  nextAudio.preload = "auto";

  createControls();
  setupRecognizer();

  roadTab.onclick = () => {
    enterTextMode();
    switchMode("road");
  };

  walkTab.onclick = () => {
    enterTextMode();
    switchMode("walk");
  };

  me10Tab.onclick = () => {
    enterTextMode();
    setArea("ME10");
  };

  me9Tab.onclick = () => {
    enterTextMode();
    setArea("ME9");
  };

  document.getElementById("resetBtn").onclick = reset;

  input.addEventListener("focus", () => {
    enterTextMode(false);
  });

  input.addEventListener("input", () => {
    enterTextMode();
    handleInput(input.value, false);
  });

  input.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;

    event.preventDefault();
    enterTextMode();
    handleInput(input.value, true);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      logVoice("Page hidden: cancelling voice interaction.");
      enterTextMode(false);
    }
  });

  window.addEventListener("pagehide", () => {
    enterTextMode(false);
  });

  micBtn.disabled = true;
  showNote("Loading roads...");

  const recordingsLoading = loadManifest();

  try {
    const response = await fetch("roads.csv");

    if (!response.ok) {
      throw new Error(`roads.csv: HTTP ${response.status}`);
    }

    roads = parseCsv(await response.text());

    if (!roads.length) {
      throw new Error("No usable road entries found.");
    }

    selectedArea =
      readSetting(AREA_KEY) === "ME9" ? "ME9" : "ME10";

    ready = true;
    applyArea();
    buildGrids();
    switchMode("road");

    showNote(
      `Showing ${selectedArea}. Type or say a road name.`
    );
  } catch (error) {
    console.error(error);
    showNote("Could not load roads.csv. Check the file and columns.");
  }

  await recordingsLoading;

  micBtn.disabled = !ready || !recognizer;

  logVoice(
    `${APP_VERSION} loaded. AudioContext: ` +
    `${window.AudioContext || window.webkitAudioContext ? "yes" : "no"}` +
    `, audioSession: ${navigator.audioSession ? "yes" : "no"}.`
  );
});

function createControls() {
  const box = document.createElement("div");
  box.style.margin = "10px 0";

  replayBtn = document.createElement("button");
  replayBtn.type = "button";
  replayBtn.textContent = "Read reply aloud";
  replayBtn.disabled = true;

  Object.assign(replayBtn.style, {
    padding: "10px 12px",
    fontSize: "16px"
  });

  replayBtn.onclick = () => {
    if (!lastReply) return;

    unlockAudio();

    const keys = [...lastReply.keys];
    enterTextMode(false);
    requestPlayback(keys, false);
  };

  const label = document.createElement("label");
  label.style.display = "block";
  label.style.marginTop = "10px";

  autoToggle = document.createElement("input");
  autoToggle.type = "checkbox";
  autoToggle.checked = readSetting(AUTO_KEY) !== "false";
  autoToggle.style.marginRight = "8px";

  autoToggle.onchange = () => {
    saveSetting(AUTO_KEY, String(autoToggle.checked));

    if (!autoToggle.checked) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }

    logVoice(
      `Automatic listening: ${autoToggle.checked ? "on" : "off"}.`
    );
  };

  label.append(
    autoToggle,
    document.createTextNode(
      "Listen automatically after voice questions"
    )
  );

  const readyLabel = document.createElement("label");
  readyLabel.style.display = "block";
  readyLabel.style.marginTop = "6px";

  micReadyToggle = document.createElement("input");
  micReadyToggle.type = "checkbox";
  micReadyToggle.checked = readSetting(MIC_READY_KEY) === "true";
  micReadyToggle.style.marginRight = "8px";

  micReadyToggle.onchange = () => {
    saveSetting(MIC_READY_KEY, String(micReadyToggle.checked));
    setMicReady(micReadyToggle.checked);
  };

  readyLabel.append(
    micReadyToggle,
    document.createTextNode(
      "Keep microphone ready (experimental, iPhone)"
    )
  );

  micStatus = document.createElement("p");
  micStatus.setAttribute("role", "status");
  micStatus.style.fontSize = "14px";
  micStatus.style.margin = "8px 0";

  audioStatus = document.createElement("p");
  audioStatus.setAttribute("role", "status");
  audioStatus.style.fontSize = "14px";
  audioStatus.style.margin = "8px 0";

  diagnosticButton = document.createElement("button");
  diagnosticButton.type = "button";
  diagnosticButton.textContent = "Show voice diagnostics";

  diagnosticPanel = document.createElement("textarea");
  diagnosticPanel.readOnly = true;
  diagnosticPanel.hidden = true;
  diagnosticPanel.rows = 10;
  diagnosticPanel.setAttribute(
    "aria-label",
    "Voice event diagnostics"
  );

  Object.assign(diagnosticPanel.style, {
    width: "100%",
    boxSizing: "border-box",
    marginTop: "8px",
    fontSize: "13px"
  });

  diagnosticButton.onclick = () => {
    diagnosticPanel.hidden = !diagnosticPanel.hidden;

    diagnosticButton.textContent = diagnosticPanel.hidden
      ? "Show voice diagnostics"
      : "Hide voice diagnostics";
  };

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy diagnostics";
  copyButton.style.marginLeft = "8px";

  copyButton.onclick = async () => {
    const text = diagnosticLines.join("\n");

    try {
      if (!navigator.clipboard) throw new Error("Unavailable");
      await navigator.clipboard.writeText(text);
      setMicStatus("Diagnostics copied.");
    } catch (error) {
      diagnosticPanel.hidden = false;
      diagnosticButton.textContent = "Hide voice diagnostics";
      diagnosticPanel.focus();
      diagnosticPanel.select();

      setMicStatus(
        "Select and copy the diagnostics from the box."
      );
    }
  };

  box.append(
    replayBtn,
    label,
    readyLabel,
    micStatus,
    audioStatus,
    diagnosticButton,
    copyButton,
    diagnosticPanel
  );

  transcript.insertAdjacentElement("afterend", box);
}

function setAudioStatus(text) {
  audioStatus.textContent = text;
}

function setMicStatus(text) {
  micStatus.textContent = text;
}

function logVoice(message) {
  const time = new Date().toLocaleTimeString();

  diagnosticLines.push(`${time} ${message}`);

  if (diagnosticLines.length > 100) {
    diagnosticLines.shift();
  }

  if (diagnosticPanel) {
    diagnosticPanel.value = diagnosticLines.join("\n");
    diagnosticPanel.scrollTop = diagnosticPanel.scrollHeight;
  }
}

function readSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // Saved preferences are optional.
  }
}

// ============================================================
// Manifest
// ============================================================

function compactSpaces(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function clipKey(value) {
  return compactSpaces(value).toUpperCase();
}

function looseRoad(text) {
  return String(text).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function recording(key) {
  const normal = clipKey(key);
  const direct = manifest.get(normal);
  if (direct) return direct;

  // Road clips: tolerate area or punctuation differences between
  // roads.csv, the generator script and this app.
  const match = normal.match(/^ROAD:(?:ME9|ME10):(.*)$/);

  if (match) {
    const other = normal.startsWith("ROAD:ME9:") ? "ME10" : "ME9";
    const swapped = manifest.get(`ROAD:${other}:${match[1]}`);
    if (swapped) return swapped;

    return roadLoose.get(looseRoad(match[1]));
  }

  return undefined;
}

function roadRecordingKey(entry) {
  const road = compactSpaces(entry.road).toUpperCase();
  return `road:${entry.area}:${road}`;
}

function resultRecordingKey(entry) {
  const road = compactSpaces(entry.road).toUpperCase();
  return `result:${entry.area}:${road}:${walkKey(entry.walk)}`;
}

async function loadManifest() {
  try {
    const response = await fetch("audio/manifest.json", {
      cache: "no-cache"
    });

    if (!response.ok) {
      throw new Error(`manifest.json: HTTP ${response.status}`);
    }

    const data = await response.json();
    const root = new URL("audio/", document.baseURI);

    for (const [key, entry] of Object.entries(data)) {
      if (
        !entry ||
        typeof entry.file !== "string" ||
        typeof entry.text !== "string"
      ) {
        continue;
      }

      const url = new URL(entry.file, document.baseURI);

      if (
        url.origin !== root.origin ||
        !url.pathname.startsWith(root.pathname) ||
        !url.pathname.toLowerCase().endsWith(".mp3")
      ) {
        continue;
      }

      const stored = { text: entry.text, url: url.href };
      const normal = clipKey(key);

      manifest.set(normal, stored);

      const roadMatch = normal.match(/^ROAD:(?:ME9|ME10):(.*)$/);

      if (roadMatch) {
        const loose = looseRoad(roadMatch[1]);
        if (!roadLoose.has(loose)) roadLoose.set(loose, stored);
      }
    }

    if (!manifest.size) {
      throw new Error("No usable recordings found.");
    }

    manifestReady = true;
    updateReplayButton();

    let roadCount = 0;
    let dutyCount = 0;

    for (const key of manifest.keys()) {
      if (key.startsWith("ROAD:")) roadCount++;
      if (key.startsWith("DUTY:")) dutyCount++;
    }

    logVoice(
      `Manifest loaded: ${manifest.size} entries ` +
      `(${roadCount} road, ${dutyCount} duty).`
    );

    if (!roadCount) {
      setAudioStatus(
        "audio/manifest.json has no road: entries, so road names " +
        "cannot be read. Check the manifest was uploaded."
      );
    }
  } catch (error) {
    console.error(error);

    setAudioStatus(
      "Could not load recordings. Check audio/manifest.json."
    );

    logVoice(`Manifest failed: ${error.message}`);
  }
}

function updateReplayButton() {
  replayBtn.disabled = !(
    manifestReady &&
    lastReply &&
    lastReply.keys.length
  );
}

function clearReply() {
  lastReply = null;
  updateReplayButton();
}

function reply(keys, listenAfter = false) {
  keys = Array.isArray(keys) ? keys : [keys];
  keys = keys.filter(Boolean);

  lastReply = keys.length ? { keys: [...keys] } : null;
  updateReplayButton();

  if (interactionMode === "voice" && keys.length) {
    requestPlayback(keys, listenAfter);
  }
}

// ============================================================
// Playback
// ============================================================

function stopPlayback(forget = false) {
  playbackVersion++;

  clearTimeout(playbackTimer);
  clearTimeout(autoTimer);
  playbackTimer = null;
  autoTimer = null;

  queuedReply = null;
  playbackActive = false;

  if (cancelCurrentClip) {
    cancelCurrentClip();
    cancelCurrentClip = null;
  }

  if (audio) audio.pause();

  if (nextAudio) {
    nextAudio.pause();
    nextAudio.removeAttribute("src");
    nextAudio.load();
  }

  if (forget) clearReply();
}

function enterTextMode(forget = true) {
  interactionMode = "text";
  stopPlayback(forget);
  stopRecognition(true);

  transcript.textContent = "";

  if (manifestReady) {
    setAudioStatus("");
  }

  if (micState === "idle") {
    setMicStatus("");
  }
}

function requestPlayback(keys, listenAfter) {
  stopPlayback();

  lastReply = { keys: [...keys] };
  updateReplayButton();

  if (!manifestReady) {
    setAudioStatus("Recordings have not loaded.");
    return;
  }

  const missing = keys.filter(key => !recording(key));
  let notice = "";

  if (missing.length) {
    logVoice(
      `Missing ${missing.length} recording(s): ` +
      missing.slice(0, 3).join(" | ")
    );

    keys = keys.filter(key => recording(key));

    if (!keys.length) {
      setAudioStatus(`Missing recording: ${missing[0]}`);
      return;
    }

    const roads = missing.filter(key => /^road:/i.test(key)).length;

    notice = roads
      ? `${roads} road name(s) had no recording and were skipped.`
      : `${missing.length} recording(s) were missing.`;
  }

  queuedReply = {
    keys: [...keys],
    listenAfter,
    notice,
    version: playbackVersion
  };

  if (micState !== "idle") {
    setAudioStatus("Waiting for microphone to finish...");
    stopRecognition(false);
    return;
  }

  flushPlayback();
}

function flushPlayback() {
  clearTimeout(playbackTimer);
  playbackTimer = null;

  if (
    !queuedReply ||
    micState !== "idle" ||
    document.hidden
  ) {
    return;
  }

  const job = queuedReply;

  if (job.version !== playbackVersion) {
    queuedReply = null;
    return;
  }

  const delay = micReleasedAt + HANDOVER_MS - Date.now();

  if (delay > 0) {
    playbackTimer = setTimeout(flushPlayback, delay);
    return;
  }

  queuedReply = null;
  runPlayback(job);
}

async function runPlayback(job) {
  playbackActive = true;
  logVoice(`Playback requested: ${job.keys.length} clip(s).`);

  try {
    const entries = job.keys.map(key => recording(key));
    let finished = false;

    if (audioCtx) {
      try {
        const completed = await playWithWebAudio(job, entries);
        finished = true;

        if (!completed || job.version !== playbackVersion) return;
      } catch (error) {
        if (job.version !== playbackVersion) return;

        logVoice(
          `Web Audio failed (${error.name}: ${error.message}); ` +
          "trying the audio element."
        );
      }
    }

    if (!finished) {
      const completed = await playWithElement(job);
      if (!completed) return;
    }

    if (job.version !== playbackVersion) return;

    playbackActive = false;
    setAudioStatus(job.notice || "");
    logVoice("Playback ended.");

    if (
      job.listenAfter &&
      interactionMode === "voice" &&
      autoToggle.checked
    ) {
      autoTimer = setTimeout(() => {
        autoTimer = null;

        if (
          job.version === playbackVersion &&
          interactionMode === "voice" &&
          autoToggle.checked &&
          !document.hidden
        ) {
          startListening(true);
        }
      }, 500);
    }
  } catch (error) {
    if (job.version !== playbackVersion) return;

    console.error(error);
    logVoice(`Playback error: ${error.name}: ${error.message}`);

    if (error.name === "NotAllowedError") {
      setAudioStatus(
        "Automatic audio was blocked. Tap Read reply aloud."
      );
    } else {
      setAudioStatus(
        "Could not play the recording. " + error.message
      );
    }
  } finally {
    if (job.version === playbackVersion) {
      playbackActive = false;
    }
  }
}

// ============================================================
// Web Audio playback
// ============================================================

function unlockAudio() {
  // Must run synchronously inside a tap handler.
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;

    if (!audioCtx) {
      audioCtx = new Context();
      logVoice("Audio context created.");
    }

    if (audioCtx.state !== "running") {
      const resumed = audioCtx.resume();
      if (resumed && resumed.catch) resumed.catch(() => {});
    }

    // Silent blip, which also unlocks output on iOS.
    const blip = audioCtx.createBufferSource();
    blip.buffer = audioCtx.createBuffer(1, 1, 22050);
    blip.connect(audioCtx.destination);
    blip.start(0);
  } catch (error) {
    logVoice(`Audio unlock failed: ${error.name}: ${error.message}`);
  }
}

async function loadBuffer(entry) {
  if (bufferCache.has(entry.url)) return bufferCache.get(entry.url);

  const response = await fetch(entry.url);

  if (!response.ok) {
    throw new Error(`Clip download failed: HTTP ${response.status}`);
  }

  const data = await response.arrayBuffer();

  const buffer = await new Promise((resolve, reject) => {
    const promise = audioCtx.decodeAudioData(data, resolve, reject);
    if (promise && promise.catch) promise.catch(reject);
  });

  bufferCache.set(entry.url, buffer);
  return buffer;
}

// Skips silence at the start and end of each recording so the
// road name and duty join closely.
function audibleRange(buffer) {
  const data = buffer.getChannelData(0);
  const threshold = 0.01;
  let start = 0;
  let end = data.length - 1;

  while (start < end && Math.abs(data[start]) < threshold) start++;
  while (end > start && Math.abs(data[end]) < threshold) end--;

  const pad = Math.floor(buffer.sampleRate * 0.03);
  start = Math.max(0, start - pad);
  end = Math.min(data.length - 1, end + pad);

  return {
    offset: start / buffer.sampleRate,
    duration: (end - start + 1) / buffer.sampleRate
  };
}

function stopSources() {
  const sources = activeSources;
  activeSources = [];

  sources.forEach(source => {
    try {
      source.onended = null;
      source.stop();
    } catch (error) {
      // Already stopped.
    }
  });
}

async function playWithWebAudio(job, entries) {
  if (audioCtx.state !== "running") {
    try {
      await audioCtx.resume();
    } catch (error) {
      logVoice(`Audio resume failed: ${error.name}`);
    }
  }

  logVoice(`Audio context state: ${audioCtx.state}`);

  if (audioCtx.state !== "running") {
    throw new Error(`Audio context is ${audioCtx.state}`);
  }

  setAudioStatus("Loading recordings...");

  const buffers = [];

  for (const entry of entries) {
    buffers.push(await loadBuffer(entry));

    if (job.version !== playbackVersion) return false;
  }

  if (job.version !== playbackVersion) return false;

  setAudioStatus(`Playing: ${entries.map(e => e.text).join(" ")}`);

  return new Promise(resolve => {
    let when = audioCtx.currentTime + 0.05;
    let finished = false;
    let timer;

    function done(completed) {
      if (finished) return;
      finished = true;

      clearTimeout(timer);
      cancelCurrentClip = null;
      activeSources = [];
      resolve(completed);
    }

    cancelCurrentClip = () => {
      stopSources();
      done(false);
    };

    buffers.forEach((buffer, index) => {
      const range = audibleRange(buffer);
      const source = audioCtx.createBufferSource();

      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start(when, range.offset, range.duration);

      if (index === buffers.length - 1) {
        source.onended = () => done(true);
      }

      activeSources.push(source);
      when += range.duration + CLIP_GAP_SECONDS;
    });

    timer = setTimeout(() => {
      stopSources();
      done(true);
    }, (when - audioCtx.currentTime + 3) * 1000);
  });
}

async function setMicReady(on) {
  if (!on) {
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      micStream = null;
      logVoice("Microphone released.");
    }

    return;
  }

  if (micStream) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });

    logVoice("Microphone held open.");
  } catch (error) {
    logVoice(`Hold microphone failed: ${error.name}`);
    setMicStatus(`Could not hold the microphone: ${error.name}`);

    if (micReadyToggle) micReadyToggle.checked = false;
    saveSetting(MIC_READY_KEY, "false");
  }
}

async function playWithElement(job) {
  for (let index = 0; index < job.keys.length; index++) {
    if (
      job.version !== playbackVersion ||
      document.hidden ||
      micState !== "idle"
    ) {
      return false;
    }

    const entry = recording(job.keys[index]);
    const next = recording(job.keys[index + 1] || "");

    if (next) {
      // Best-effort browser preloading.
      nextAudio.src = next.url;
      nextAudio.load();
    }

    const completed = await playClip(entry);

    if (!completed || job.version !== playbackVersion) {
      return false;
    }
  }

  return true;
}

function playClip(entry) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    function finish(error, completed) {
      if (settled) return;
      settled = true;

      clearTimeout(timer);
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      cancelCurrentClip = null;

      if (!completed) audio.pause();

      if (error) reject(error);
      else resolve(completed);
    }

    cancelCurrentClip = () => finish(null, false);

    audio.onplaying = () => {
      setAudioStatus(`Playing: ${entry.text}`);
    };

    audio.onended = () => finish(null, true);

    audio.onerror = () => {
      const code = audio.error ? audio.error.code : "unknown";
      finish(new Error(`Audio error ${code}.`), false);
    };

    timer = setTimeout(() => {
      finish(new Error("Playback timed out."), false);
    }, 90000);

    setAudioStatus(`Loading: ${entry.text}`);
    audio.src = entry.url;

    try {
      const promise = audio.play();

      if (promise && typeof promise.catch === "function") {
        promise.catch(error => finish(error, false));
      }
    } catch (error) {
      finish(error, false);
    }
  });
}

// ============================================================
// Reusable speech recogniser
// ============================================================

function updateMicButton() {
  if (micState === "idle") {
    micBtn.textContent = "🎤 Speak";
  } else if (micState === "starting") {
    micBtn.textContent = "Cancel starting";
  } else if (micState === "listening") {
    micBtn.textContent = "Stop listening";
  } else if (micState === "blocked") {
    micBtn.textContent = "Microphone stuck — tap to reload";
  } else {
    micBtn.textContent = "Stopping...";
  }
}

function clearMicTimers() {
  clearTimeout(listenTimer);
  clearTimeout(stopTimer);
  clearTimeout(abortTimer);

  listenTimer = null;
  stopTimer = null;
  abortTimer = null;
}

function setupRecognizer() {
  if (!SpeechRec) {
    micBtn.hidden = true;
    setMicStatus("Voice recognition is unavailable in this browser.");
    return;
  }

  try {
    // Created ONCE, rather than once per search.
    recognizer = new SpeechRec();
    recognizer.lang = "en-GB";
    recognizer.continuous = false;
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 5;
  } catch (error) {
    logVoice(`Recognizer creation failed: ${error.message}`);
    setMicStatus("Could not create the speech recogniser.");
    return;
  }

  recognizer.onstart = () => {
    if (!activeRun) {
      logVoice("Unexpected recognition start without an active run.");

      try {
        recognizer.abort();
      } catch (error) {
        logVoice(`Abort failed: ${error.message}`);
      }

      return;
    }

    logVoice(`Run ${activeRun.id}: onstart.`);

    if (
      activeRun.discard ||
      micState === "stopping" ||
      micState === "blocked" ||
      interactionMode !== "voice"
    ) {
      stopRecognition(true);
      return;
    }

    micState = "listening";
    updateMicButton();
    transcript.textContent = "Listening...";
    setMicStatus("Say a road, duty, or your answer.");

    armListeningTimeout(activeRun.id);
  };

  recognizer.onaudiostart = () => {
    logVoice(`Run ${activeRun?.id || "?"}: audiostart.`);
  };

  recognizer.onsoundstart = () => {
    logVoice(`Run ${activeRun?.id || "?"}: soundstart.`);
  };

  recognizer.onspeechstart = () => {
    logVoice(`Run ${activeRun?.id || "?"}: speechstart.`);
  };

  recognizer.onspeechend = () => {
    logVoice(`Run ${activeRun?.id || "?"}: speechend.`);
  };

  recognizer.onaudioend = () => {
    logVoice(`Run ${activeRun?.id || "?"}: audioend.`);
  };

  recognizer.onresult = event => {
    const run = activeRun;

    if (
      !run ||
      run.discard ||
      run.alternatives ||
      interactionMode !== "voice"
    ) {
      return;
    }

    for (
      let index = event.resultIndex;
      index < event.results.length;
      index++
    ) {
      const result = event.results[index];
      if (!result.isFinal) continue;

      const alternatives = Array.from(
        result,
        item => item.transcript.trim()
      ).filter(Boolean);

      if (!alternatives.length) continue;

      run.alternatives = alternatives;

      transcript.textContent = `Heard: ${alternatives[0]}`;
      logVoice(
        `Run ${run.id}: final result (${alternatives.length} alternatives).`
      );

      // Process the words only AFTER onend.
      stopRecognition(false);
      break;
    }
  };

  recognizer.onerror = event => {
    const run = activeRun;
    if (!run) return;

    run.error = event.error;

    logVoice(`Run ${run.id}: error ${event.error}.`);

    if (!run.discard) {
      if (event.error === "not-allowed") {
        setMicStatus(
          run.automatic
            ? "Automatic listening was refused. Tap Speak."
            : "Microphone access refused. Check browser permissions."
        );
      } else if (event.error === "audio-capture") {
        setMicStatus(
          "Microphone unavailable. Check other apps or audio devices."
        );
      } else if (event.error === "no-speech") {
        setMicStatus("No speech recognised. Tap Speak to retry.");
      } else if (event.error !== "aborted") {
        setMicStatus(
          `Recognition error: ${event.error}. Tap Speak to retry.`
        );
      }
    }

    // An error is not proof that the session has ended.
    // Keep waiting for onend, with a bounded stop watchdog.
    stopRecognition(false);
  };

  recognizer.onend = () => {
    const run = activeRun;

    logVoice(`Run ${run?.id || "?"}: onend.`);
    clearMicTimers();

    activeRun = null;
    micState = "idle";
    micReleasedAt = Date.now();

    updateMicButton();

    if (
      run &&
      !run.discard &&
      run.alternatives &&
      interactionMode === "voice" &&
      !document.hidden
    ) {
      setMicStatus("");

      try {
        // Recognition has now actually ended.
        handleVoice(run.alternatives);
      } catch (error) {
        console.error(error);
        logVoice(`Input processing failed: ${error.message}`);
        stopPlayback();
        setMicStatus("Could not process that request. Tap Speak.");
      }
    } else if (
      run &&
      !run.discard &&
      !run.error &&
      !run.timedOut
    ) {
      transcript.textContent = "Nothing recognised.";
      setMicStatus("Tap Speak to try again.");
    } else if (run?.discard) {
      setMicStatus("");
    }

    if (queuedReply) flushPlayback();
  };

  micBtn.onclick = () => {
    if (micState === "blocked") {
      logVoice("Reloading because recognition is stuck.");
      location.reload();
      return;
    }

    unlockAudio();

    if (
      readSetting(MIC_READY_KEY) === "true" &&
      !micStream &&
      micState === "idle"
    ) {
      setMicReady(true);
    }

    if (micState !== "idle") {
      enterTextMode(false);
      return;
    }

    stopPlayback(true);
    interactionMode = "voice";
    startListening(false);
  };
}

function armListeningTimeout(id) {
  clearTimeout(listenTimer);

  listenTimer = setTimeout(() => {
    if (!activeRun || activeRun.id !== id) return;

    activeRun.timedOut = true;
    activeRun.discard = true;

    logVoice(`Run ${id}: listening/start timeout.`);

    setMicStatus(
      "Listening timed out. Stopping the microphone..."
    );

    // No recognised result is expected now, so abort.
    stopRecognition(true);
  }, LISTEN_TIMEOUT_MS);
}

function armStopWatchdog(run) {
  if (stopTimer || abortTimer) return;

  stopTimer = setTimeout(() => {
    stopTimer = null;

    if (activeRun !== run) return;

    run.discard = true;
    logVoice(`Run ${run.id}: no onend; requesting abort.`);

    setMicStatus(
      "Recognition has not ended. Attempting to cancel it..."
    );

    abortTimer = setTimeout(() => {
      abortTimer = null;

      if (activeRun !== run) return;

      micState = "blocked";
      updateMicButton();

      logVoice(
        `Run ${run.id}: still no onend; reload required.`
      );

      setMicStatus(
        "The browser has not released recognition. " +
        "Reload the page. Reset cannot repair this browser state."
      );

      // Do not mark idle or create a second recogniser.
    }, STOP_TIMEOUT_MS);

    try {
      recognizer.abort();
    } catch (error) {
      logVoice(`Abort exception: ${error.name}: ${error.message}`);
    }
  }, STOP_TIMEOUT_MS);
}

function stopRecognition(discard = false) {
  const run = activeRun;
  if (!recognizer || !run) return;

  if (discard) {
    run.discard = true;
    run.alternatives = null;
  }

  clearTimeout(listenTimer);
  listenTimer = null;

  if (micState === "blocked") return;

  const alreadyStopping = micState === "stopping";
  micState = "stopping";
  updateMicButton();

  // Arm before calling stop/abort in case events arrive quickly.
  armStopWatchdog(run);

  try {
    if (discard && !run.abortRequested) {
      run.abortRequested = true;
      logVoice(`Run ${run.id}: abort requested.`);
      recognizer.abort();
    } else if (!discard && !alreadyStopping) {
      logVoice(`Run ${run.id}: stop requested.`);
      recognizer.stop();
    }
  } catch (error) {
    logVoice(
      `Run ${run.id}: stop exception ${error.name}: ${error.message}`
    );
  }
}

function startListening(automatic) {
  if (
    !recognizer ||
    !ready ||
    document.hidden ||
    interactionMode !== "voice" ||
    micState !== "idle" ||
    activeRun ||
    playbackActive ||
    queuedReply ||
    (automatic && !autoToggle.checked)
  ) {
    logVoice(
      `Start skipped: state=${micState}, ` +
      `mode=${interactionMode}, playback=${playbackActive}.`
    );
    return;
  }

  clearMicTimers();

  const run = {
    id: ++runNumber,
    automatic,
    discard: false,
    alternatives: null,
    error: null,
    timedOut: false,
    abortRequested: false
  };

  activeRun = run;
  micState = "starting";

  updateMicButton();
  transcript.textContent = "Starting microphone...";
  setMicStatus("");
  setAudioStatus("");

  logVoice(
    `Run ${run.id}: start requested (${automatic ? "automatic" : "tap"}).`
  );

  // Covers start requests which never produce onstart.
  armListeningTimeout(run.id);

  try {
    recognizer.start();
  } catch (error) {
    logVoice(
      `Run ${run.id}: start exception ${error.name}: ${error.message}`
    );

    if (error.name === "InvalidStateError") {
      // Browser says recognition is already active.
      // Do not simply overwrite the state with "idle".
      run.discard = true;

      setMicStatus(
        "The browser reports recognition is already active. " +
        "Attempting to cancel it..."
      );

      stopRecognition(true);
    } else {
      // The requested session did not start.
      clearMicTimers();
      activeRun = null;
      micState = "idle";
      updateMicButton();

      setMicStatus(
        `Could not start: ${error.name}. ${error.message}`
      );
    }
  }
}

// ============================================================
// CSV parsing
// ============================================================

function splitCsvLine(line) {
  const columns = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];

    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      columns.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  columns.push(value);
  return columns;
}

function parseCsv(text) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .slice(1);

  const entries = [];
  let area = "ME10";

  for (const line of lines) {
    const columns = splitCsvLine(line);
    const road = (columns[0] || "").trim();
    const walk = (columns[2] || "").trim();

    if (!road) {
      if (entries.length && area === "ME10") area = "ME9";
      continue;
    }

    if (!walk) continue;

    const letter =
      (columns[1] || "").trim().toUpperCase() ||
      normalise(road.replace(/^THE\s+/i, ""))[0] ||
      "";

    entries.push(makeEntry(road, walk, letter, area));
  }

  return entries;
}

function makeEntry(road, walk, letter, area) {
  const separator = road.indexOf(" - ");
  let base;
  let detail;

  if (separator !== -1) {
    base = road.slice(0, separator).trim();
    detail = road.slice(separator + 3).trim();
  } else {
    const match = road.match(HOUSES_AFTER_NAME);
    base = match ? match[1].trim() : road;
    detail = match ? match[2] : "";
  }

  const text = detail
    .replace(/(\d+)\s+-\s+(\d+)/g, "$1-$2")
    .toUpperCase();

  const outcodes = (
    text.match(/\b[A-Z]{1,2}\d{1,2}(?:\s+\d[A-Z]{0,2})?\b/g) ||
    []
  ).map(normalise);

  const inwards = (
    text.match(/\b\d[A-Z]{2}\b/g) || []
  ).map(normalise);

  const ranges = [];
  const singles = [];
  const tokens = text.replace(/[()&,]/g, " ").split(/\s+/);

  for (let index = 0; index < tokens.length; index++) {
    const match = tokens[index].match(/^(\d+)-(\d+)$/);

    if (match) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      const next = tokens[index + 1];

      ranges.push({
        lo: Math.min(first, second),
        hi: Math.max(first, second),
        first,
        parity: next === "ODD"
          ? "odd"
          : next === "EVEN" ? "even" : null
      });
    } else if (/^\d+$/.test(tokens[index]) && !outcodes.length) {
      singles.push(Number(tokens[index]));
    }
  }

  if (ranges.length === 2 && !singles.length) {
    ranges.forEach(range => {
      if (!range.parity) {
        range.parity = range.first % 2 ? "odd" : "even";
      }
    });
  }

  return {
    road,
    walk,
    letter,
    area,
    base,
    detail,
    baseN: normalise(base),
    detailN: normalise(detail),
    ranges,
    singles,
    outcodes,
    inwards,
    fallback:
      /EXCEPT|REMAINDER/i.test(road) ||
      (
        !ranges.length &&
        !singles.length &&
        !outcodes.length &&
        !inwards.length
      )
  };
}

// ============================================================
// Matching
// ============================================================

function normalise(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function walkKey(value) {
  const text = normalise(value);
  const match = text.match(/^[TUZ]?(\d+)$/);

  return match ? String(parseInt(match[1], 10)) : text;
}

function areaRoads() {
  return roads.filter(entry => entry.area === selectedArea);
}

function findWalk(query) {
  const key = walkKey(query);

  return key
    ? areaRoads().filter(entry => walkKey(entry.walk) === key)
    : [];
}

function findRoads(query, list = areaRoads()) {
  const text = normalise(query);
  if (!text) return [];

  const exact = list.filter(entry => entry.baseN === text);
  if (exact.length) return exact;

  const starts = list.filter(entry => entry.baseN.startsWith(text));
  if (starts.length) return starts;

  return text.length >= 4
    ? list.filter(entry => entry.baseN.includes(text))
    : [];
}

function findExactVoiceRoad(query) {
  const text = normalise(query);
  const exact = areaRoads().filter(entry => entry.baseN === text);

  if (exact.length) return exact;

  const core = coreName(query);
  if (core.length < 3) return [];

  const matches = areaRoads().filter(
    entry => coreName(entry.base) === core
  );

  return new Set(matches.map(entry => entry.baseN)).size === 1
    ? matches
    : [];
}

function needsDetail(matches) {
  return (
    matches.length > 1 &&
    matches.every(entry => entry.baseN === matches[0].baseN) &&
    matches.some(entry => entry.detail)
  );
}

function housesMatch(entry, number) {
  return (
    entry.singles.includes(number) ||
    entry.ranges.some(range =>
      number >= range.lo &&
      number <= range.hi &&
      (
        !range.parity ||
        (range.parity === "odd") === (number % 2 === 1)
      )
    )
  );
}

function answerPending(query, allowFallback = true) {
  if (!pending) return null;

  const text = normalise(query);
  if (!text) return null;

  let hits;

  if (/^\d+[A-Z]?$/.test(text)) {
    hits = pending.matches.filter(entry =>
      housesMatch(entry, parseInt(text, 10))
    );
  } else if (
    /^[A-Z]{1,2}\d/.test(text) ||
    /^\d[A-Z]{2}$/.test(text)
  ) {
    hits = pending.matches.filter(entry =>
      entry.outcodes.some(code =>
        code.startsWith(text) || text.startsWith(code)
      ) ||
      entry.inwards.some(code =>
        text === code || text.endsWith(code)
      )
    );
  } else if (text.length >= 3) {
    hits = pending.matches.filter(entry =>
      entry.detailN.includes(text)
    );

    return hits.length ? hits : null;
  } else {
    return null;
  }

  if (!hits.length && allowFallback) {
    hits = pending.matches.filter(entry => entry.fallback);
  }

  return hits.length ? hits : null;
}

function coreName(value) {
  const words = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(word => word && !SUFFIXES.has(word));

  return words.length ? words.join("") : normalise(value);
}

function editDistance(a, b) {
  let previous = Array.from(
    { length: b.length + 1 },
    (_, index) => index
  );

  for (let row = 1; row <= a.length; row++) {
    const current = [row];

    for (let column = 1; column <= b.length; column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] +
          (a[row - 1] === b[column - 1] ? 0 : 1)
      );
    }

    previous = current;
  }

  return previous[b.length];
}

function suggestRoads(alternatives) {
  const bases = new Map();

  areaRoads().forEach(entry => {
    if (!bases.has(entry.baseN)) {
      bases.set(entry.baseN, {
        base: entry.base,
        baseN: entry.baseN,
        core: coreName(entry.base),
        score: 0
      });
    }
  });

  for (const raw of alternatives) {
    const said = coreName(raw);
    if (said.length < 3) continue;

    for (const candidate of bases.values()) {
      const longest = Math.max(said.length, candidate.core.length);

      let score = longest
        ? 1 - editDistance(said, candidate.core) / longest
        : 0;

      if (
        Math.min(said.length, candidate.core.length) >= 4 &&
        (
          said.startsWith(candidate.core) ||
          candidate.core.startsWith(said)
        )
      ) {
        score = Math.max(score, 0.8);
      }

      candidate.score = Math.max(candidate.score, score);
    }
  }

  return [...bases.values()]
    .filter(candidate => candidate.score >= MIN_SUGGEST)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ============================================================
// Display and navigation
// ============================================================

function applyArea() {
  me10Tab.classList.toggle("active", selectedArea === "ME10");
  me9Tab.classList.toggle("active", selectedArea === "ME9");
  areaLabel.textContent = selectedArea;
}

function setArea(name) {
  if (!ready) return;

  stopPlayback(true);
  selectedArea = name;
  pending = null;
  suggestions = null;

  saveSetting(AREA_KEY, name);
  applyArea();
  buildGrids();

  const query = input.value.trim();

  if (query && !areaFromText(query)) {
    lookup(query);
  } else {
    input.value = "";
    clearResults();

    showNote(
      `Showing ${selectedArea}. Type or say a road name.`
    );

    if (interactionMode === "voice") {
      reply("prompt:retry", true);
    }
  }
}

function addButton(parent, label, callback) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.onclick = callback;
  parent.appendChild(button);
}

function buildGrids() {
  letterGrid.innerHTML = "";
  walkGrid.innerHTML = "";

  const letters = [
    ...new Set(areaRoads().map(entry => entry.letter))
  ].filter(letter => /^[A-Z]$/.test(letter)).sort();

  letters.forEach(letter => {
    addButton(letterGrid, letter, () => {
      enterTextMode();

      showDuties(
        areaRoads().filter(entry => entry.letter === letter)
      );
    });
  });

  const walks = [
    ...new Set(areaRoads().map(entry => walkKey(entry.walk)))
  ].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  walks.forEach(walk => {
    addButton(walkGrid, walk, () => {
      enterTextMode();
      showDuties(findWalk(walk));
    });
  });
}

function switchMode(name) {
  pending = null;
  const isRoad = name === "road";

  roadTab.classList.toggle("active", isRoad);
  walkTab.classList.toggle("active", !isRoad);
  letterGrid.classList.toggle("hidden", !isRoad);
  walkGrid.classList.toggle("hidden", isRoad);

  clearResults();
}

function clearResults() {
  suggestions = null;
  results.innerHTML = "";

  letterGrid.classList.remove("compact");
  walkGrid.classList.remove("compact");
  clearReply();
}

function compact() {
  letterGrid.classList.add("compact");
  walkGrid.classList.add("compact");
}

function appendNote(text) {
  const row = document.createElement("li");
  row.className = "note";
  row.textContent = text;
  results.appendChild(row);
}

function showNote(text) {
  results.innerHTML = "";
  appendNote(text);
  clearReply();
}

function sortedEntries(matches) {
  return [...matches].sort((a, b) =>
    a.road.localeCompare(b.road)
  );
}

function resultRow(entry) {
  const row = document.createElement("li");
  const name = document.createElement("span");

  name.className = "road";
  name.textContent = entry.base;

  if (entry.detail) {
    const detail = document.createElement("small");
    detail.textContent = entry.detail;
    name.append(document.createElement("br"), detail);
  }

  const duty = document.createElement("span");
  duty.className = "walk";
  duty.textContent = walkKey(entry.walk);

  row.append(name, duty);
  return row;
}

function appendEntries(matches) {
  sortedEntries(matches).forEach(entry => {
    results.appendChild(resultRow(entry));
  });
}

function resultAudioKeys(matches) {
  const keys = [];

  for (const entry of sortedEntries(matches)) {
    const roadKey = roadRecordingKey(entry);
    const dutyKey = `duty:${walkKey(entry.walk)}`;
    const fullResultKey = resultRecordingKey(entry);

    if (recording(roadKey) && recording(dutyKey)) {
      keys.push(roadKey, dutyKey);
    } else if (recording(fullResultKey)) {
      keys.push(fullResultKey);
    } else {
      keys.push(roadKey, dutyKey);
    }
  }

  return keys;
}

function showDuties(matches) {
  pending = null;
  suggestions = null;

  compact();
  results.innerHTML = "";

  if (!matches.length) {
    appendNote("No road found.");
    reply("prompt:no-match");
    return;
  }

  appendEntries(matches);

  if (matches.length <= MAX_READ_RESULTS) {
    reply(resultAudioKeys(matches));
  } else {
    clearReply();

    setAudioStatus(
      `${matches.length} results shown. Narrow the search ` +
      `to ${MAX_READ_RESULTS} or fewer to read them aloud.`
    );
  }
}

function askDetail(matches, message) {
  if (interactionMode !== "voice") {
    showDuties(matches);
    return;
  }

  suggestions = null;
  pending = { matches };

  compact();
  results.innerHTML = "";

  // Results stay visible beneath the clarification question.
  appendNote(message);
  appendEntries(matches);

  reply("prompt:detail", true);
}

function option(label, callback, dashed = false) {
  const row = document.createElement("li");
  const button = document.createElement("button");

  button.type = "button";
  button.textContent = label;

  Object.assign(button.style, {
    width: "100%",
    padding: "12px",
    textAlign: "left",
    fontSize: "17px",
    background: "#fff",
    color: dashed ? "#555" : "#1d1d1f",
    border: "1px solid #d9d9d6",
    borderRadius: "8px"
  });

  if (dashed) button.style.borderStyle = "dashed";

  button.onclick = () => {
    enterTextMode();
    callback();
  };

  row.appendChild(button);
  results.appendChild(row);
}

function reset() {
  enterTextMode();
  pending = null;
  suggestions = null;
  input.value = "";
  clearResults();

  logVoice("Reset pressed.");

  if (micState === "blocked") {
    setMicStatus(
      "Recognition is still stuck in the browser. Reload the page."
    );
  }
}

// ============================================================
// Suggestions
// ============================================================

function offerOptions(options) {
  pending = null;

  suggestions = {
    options,
    stage: "choose",
    chosen: -1
  };

  renderChoose();
}

function renderChoose() {
  if (!suggestions) return;

  const options = suggestions.options;
  compact();
  results.innerHTML = "";

  appendNote(
    options.length === 1
      ? "Did you mean this?"
      : "Did you mean one of these?"
  );

  options.forEach((candidate, index) => {
    const label = options.length === 1
      ? candidate.base
      : `${index + 1}. ${candidate.base}`;

    option(label, () => pickOption(index));
  });

  option("None of these", cancelSuggestions, true);

  if (options.length === 1) {
    appendEntries(
      areaRoads().filter(entry =>
        entry.baseN === options[0].baseN
      )
    );

    reply(`confirm:${options[0].base}`, true);
  } else {
    reply("prompt:choose", true);
  }
}

function pickOption(index) {
  if (!suggestions || !suggestions.options[index]) return;

  if (suggestions.options.length === 1) {
    acceptOption(0);
    return;
  }

  suggestions.stage = "confirm";
  suggestions.chosen = index;
  renderConfirm();
}

function renderConfirm() {
  if (!suggestions) return;

  const index = suggestions.chosen;
  const candidate = suggestions.options[index];
  if (!candidate) return;

  compact();
  results.innerHTML = "";

  appendNote(`Did you mean ${candidate.base}?`);
  option("Yes, that one", () => acceptOption(index));

  option("No, choose again", () => {
    if (!suggestions) return;

    suggestions.stage = "choose";
    suggestions.chosen = -1;
    renderChoose();
  }, true);

  appendEntries(
    areaRoads().filter(entry => entry.baseN === candidate.baseN)
  );

  reply(`confirm:${candidate.base}`, true);
}

function acceptOption(index) {
  if (!suggestions || !suggestions.options[index]) return;

  const candidate = suggestions.options[index];
  suggestions = null;
  input.value = candidate.base;
  lookup(candidate.base);
}

function cancelSuggestions() {
  suggestions = null;
  pending = null;
  input.value = "";

  showNote("Okay. Type or say the road again.");
  reply("prompt:retry", true);
}

function handleSuggestion(alternatives) {
  if (!suggestions) return false;

  const { options, stage, chosen } = suggestions;

  for (const raw of alternatives) {
    const said = cleanSpoken(raw);

    if (CANCEL_WORDS.has(said)) {
      cancelSuggestions();
      return true;
    }

    if (YES_WORDS.has(said)) {
      if (stage === "confirm") {
        acceptOption(chosen);
      } else if (options.length === 1) {
        acceptOption(0);
      } else {
        reply("prompt:choose", true);
      }

      return true;
    }

    if (NO_WORDS.has(said)) {
      if (stage === "confirm") {
        suggestions.stage = "choose";
        suggestions.chosen = -1;
        renderChoose();
      } else {
        cancelSuggestions();
      }

      return true;
    }

    const number = Number(heardAsNumber(raw));

    if (
      Number.isInteger(number) &&
      number >= 1 &&
      number <= options.length
    ) {
      pickOption(number - 1);
      return true;
    }

    const named = options.filter(
      candidate => candidate.core === coreName(raw)
    );

    if (named.length === 1) {
      pickOption(options.indexOf(named[0]));
      return true;
    }
  }

  return false;
}

// ============================================================
// Typed lookup
// ============================================================

function areaFromText(text) {
  const value = normalise(text);

  return value === "ME10" || value === "ME9" ? value : null;
}

function handleInput(raw, final) {
  if (!ready) return;

  const query = raw.trim();

  if (!query) {
    pending = null;
    clearResults();
    return;
  }

  if (suggestions) {
    if (final && handleSuggestion([query])) return;
    suggestions = null;
  }

  const requestedArea = areaFromText(query);

  if (requestedArea) {
    if (final) {
      input.value = requestedArea;
      setArea(requestedArea);
    } else {
      clearResults();
    }

    return;
  }

  if (pending) {
    const openQuestion = pending;
    const hits = answerPending(query);

    if (hits) {
      showDuties(hits);

      if (!final) pending = openQuestion;
      return;
    }

    if (
      /^\d/.test(normalise(query)) ||
      /^[A-Z]{1,2}\d/.test(normalise(query))
    ) {
      showDuties(openQuestion.matches);

      if (!final) pending = openQuestion;
      return;
    }

    pending = null;
  }

  if (!final && query.length < 3 && !findWalk(query).length) {
    clearResults();
    return;
  }

  lookup(query);
}

function lookup(query) {
  const duties = findWalk(query);

  if (duties.length) {
    showDuties(duties);
    return;
  }

  const matches = findRoads(query);

  if (matches.length) {
    if (
      interactionMode === "voice" &&
      needsDetail(matches)
    ) {
      askDetail(
        matches,
        `${matches[0].base}: which house number or postcode?`
      );
    } else {
      showDuties(matches);
    }

    return;
  }

  const elsewhere = findRoads(
    query,
    roads.filter(entry => entry.area !== selectedArea)
  );

  if (elsewhere.length) {
    pending = null;
    suggestions = null;

    showNote(
      `Not in ${selectedArea}. Found in ${elsewhere[0].area}. ` +
      "Select that area to search there."
    );

    return;
  }

  const options = suggestRoads([query]);

  if (options.length) offerOptions(options);
  else showDuties([]);
}

// ============================================================
// Spoken-text interpretation
// ============================================================

function cleanSpoken(value) {
  return String(value)
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wordsToDigits(text) {
  const words = text.split(/\s+/);
  const output = [];

  for (let index = 0; index < words.length; index++) {
    const value = NUMBER_WORDS[words[index]];
    const next = NUMBER_WORDS[words[index + 1]];

    if (value === undefined) {
      output.push(words[index]);
    } else if (
      value >= 20 &&
      next !== undefined &&
      next > 0 &&
      next < 10
    ) {
      output.push(String(value + next));
      index++;
    } else {
      output.push(String(value));
    }
  }

  return output.join(" ");
}

function heardAsNumber(raw) {
  const text = cleanSpoken(raw).replace(
    /^(number|option|house number|house) /,
    ""
  );

  if (Object.prototype.hasOwnProperty.call(NUMBER_ALIASES, text)) {
    return NUMBER_ALIASES[text];
  }

  return wordsToDigits(text)
    .replace(/\b(you|u)\s*(\d)/gi, "U$2")
    .replace(/\b(tea|tee|t)\s*(\d)/gi, "T$2")
    .replace(/\b(zed|zee|said|z)\s*(\d)/gi, "Z$2");
}

function postcodeVariant(raw) {
  let text = cleanSpoken(raw)
    .replace(/^(the )?(postcode|post code)\s+/, "")
    .replace(/\bx ray\b/g, "xray")
    .replace(/\bdouble u\b/g, "doubleyou");

  text = wordsToDigits(text);

  const tokens = text.split(/\s+/).map(token =>
    NATO_LETTERS[token] || SPOKEN_LETTERS[token] || token
  );

  const value = normalise(tokens.join(" "));

  return /^(?:ME(?:9|10)(?:\d[A-Z]{0,2})?|\d[A-Z]{2})$/.test(
    value
  ) ? value : null;
}

function detailAlternatives(alternatives) {
  const values = [];

  for (const raw of alternatives) {
    values.push(heardAsNumber(raw), raw);

    const postcode = postcodeVariant(raw);
    if (postcode) values.push(postcode);
  }

  return [...new Set(values.filter(Boolean))];
}

function handleVoice(alternatives) {
  if (interactionMode !== "voice" || !ready) return;

  if (suggestions && handleSuggestion(alternatives)) return;
  suggestions = null;

  const spoken = alternatives.map(heardAsNumber);

  if (pending) {
    const candidates = detailAlternatives(alternatives);

    for (const text of candidates) {
      const hits = answerPending(text, false);

      if (!hits) continue;

      input.value = text;

      if (
        new Set(hits.map(entry => walkKey(entry.walk))).size > 1
      ) {
        askDetail(
          hits,
          "More than one match. Which house number or postcode?"
        );
      } else {
        showDuties(hits);
      }

      return;
    }

    const anotherRoad = spoken.find(
      text => findExactVoiceRoad(text).length
    );

    if (anotherRoad) {
      pending = null;
      input.value = anotherRoad;
      lookup(anotherRoad);
      return;
    }

    for (const text of candidates) {
      const hits = answerPending(text, true);

      if (hits) {
        input.value = text;
        showDuties(hits);
        return;
      }
    }

    askDetail(
      pending.matches,
      "No clear match. Which house number or postcode?"
    );

    return;
  }

  for (const text of spoken) {
    const requestedArea = areaFromText(text);

    if (requestedArea) {
      input.value = requestedArea;
      setArea(requestedArea);
      return;
    }
  }

  for (const text of spoken) {
    const command = text.match(/^(walk|duty|letter)\s+(.+)$/i);
    if (!command) continue;

    if (command[1].toLowerCase() === "letter") {
      switchMode("road");
      const letter = normalise(command[2])[0];

      showDuties(
        areaRoads().filter(entry => entry.letter === letter)
      );
    } else {
      switchMode("walk");
      input.value = command[2];
      showDuties(findWalk(command[2]));
    }

    return;
  }

  for (const text of spoken) {
    const matches = findExactVoiceRoad(text);

    if (matches.length) {
      input.value = matches[0].base;
      lookup(matches[0].base);
      return;
    }
  }

  for (const text of spoken) {
    if (findWalk(text).length) {
      input.value = text;
      showDuties(findWalk(text));
      return;
    }
  }

  input.value = spoken[0] || "";

  const options = suggestRoads(alternatives);

  if (options.length) {
    offerOptions(options);
  } else {
    lookup(spoken[0] || "");
  }
}