"use strict";

// ============================================================
// Settings
// ============================================================

const AREA_KEY = "sortingArea";
const AUTO_KEY = "sortingAutoListen";
const HANDOVER_MS = 600;
const MIN_SUGGEST = 0.6;

const SpeechRec =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const SUFFIXES = new Set([
  "ROAD", "RD", "STREET", "ST", "AVENUE", "AVE",
  "CLOSE", "DRIVE", "DR", "LANE", "WAY", "COURT",
  "CT", "TERRACE", "CRESCENT", "GARDENS", "GROVE",
  "PARK", "WALK", "PLACE", "MEWS", "RISE", "HOUSE", "THE"
]);

const YES = new Set([
  "yes", "yeah", "yep", "yup", "correct", "right",
  "thats right", "thats it", "that one", "ok",
  "okay", "sure", "confirm"
]);

const NO = new Set([
  "no", "nope", "wrong", "incorrect", "not that"
]);

const CANCEL = new Set([
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

const HOUSES_AFTER_NAME =
  /^(.*?)\s+(\d{1,3}(?:-\d{1,3})?(?:\s+\d{1,3}(?:-\d{1,3})?)*)$/;

// ============================================================
// State
// ============================================================

let roads = [];
let ready = false;
let area = "ME10";
let mode = "text";

let pending = null;
let suggestions = null;

let manifest = new Map();
let manifestReady = false;

let recognizer = null;
let micState = "idle";
let micReleasedAt = 0;
let stopTimer = null;

let audio = null;
let playbackVersion = 0;
let playbackActive = false;
let queuedReply = null;
let lastReply = null;
let playbackTimer = null;
let autoTimer = null;
let cancelClip = null;

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
let audioStatus;
let autoToggle;

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

  createAudioControls();
  setupMic();

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
      enterTextMode(false);
    }
  });

  window.addEventListener("pagehide", () => {
    enterTextMode(false);
  });

  micBtn.disabled = true;
  note("Loading roads...");

  const audioLoading = loadManifest();

  try {
    const response = await fetch("roads.csv");

    if (!response.ok) {
      throw new Error(`roads.csv: HTTP ${response.status}`);
    }

    roads = parseCsv(await response.text());

    if (!roads.length) {
      throw new Error("No usable roads found.");
    }

    const saved = readSetting(AREA_KEY);
    area = saved === "ME9" ? "ME9" : "ME10";
    ready = true;

    applyArea();
    buildGrids();
    switchMode("road");

    note(`Showing ${area}. Type or say a road name.`);
  } catch (error) {
    console.error(error);
    note("Could not load roads.csv. Check the file and columns.");
  }

  await audioLoading;
  micBtn.disabled = !ready;
});

function createAudioControls() {
  const box = document.createElement("div");
  box.style.margin = "10px 0";

  replayBtn = document.createElement("button");
  replayBtn.type = "button";
  replayBtn.textContent = "Read reply aloud";
  replayBtn.disabled = true;
  replayBtn.style.padding = "10px 12px";
  replayBtn.style.fontSize = "16px";

  replayBtn.onclick = () => {
    if (!lastReply) return;

    const reply = lastReply;
    enterTextMode(false);

    // Explicit replay never automatically opens the mic.
    requestPlayback(reply.keys, false);
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
  };

  label.append(
    autoToggle,
    document.createTextNode(
      "Listen automatically after voice questions"
    )
  );

  audioStatus = document.createElement("p");
  audioStatus.setAttribute("role", "status");
  audioStatus.setAttribute("aria-live", "polite");
  audioStatus.style.fontSize = "14px";
  audioStatus.style.margin = "8px 0";

  box.append(replayBtn, label, audioStatus);
  transcript.insertAdjacentElement("afterend", box);
}

function status(text) {
  audioStatus.textContent = text;
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
    // Storage is optional.
  }
}

// ============================================================
// Audio manifest
// ============================================================

function clipKey(value) {
  return String(value).trim().replace(/\s+/g, " ").toUpperCase();
}

async function loadManifest() {
  try {
    const response = await fetch("audio/manifest.json");

    if (!response.ok) {
      throw new Error(`manifest.json: HTTP ${response.status}`);
    }

    const data = await response.json();

    for (const [key, entry] of Object.entries(data)) {
      if (
        !entry ||
        typeof entry.file !== "string" ||
        typeof entry.text !== "string"
      ) {
        continue;
      }

      // Your manifest paths are relative to the app root,
      // not relative to the manifest's audio folder.
      const url = new URL(entry.file, document.baseURI);
      const audioRoot = new URL("audio/", document.baseURI);

      if (
        url.origin !== audioRoot.origin ||
        !url.pathname.startsWith(audioRoot.pathname) ||
        !url.pathname.toLowerCase().endsWith(".mp3")
      ) {
        continue;
      }

      manifest.set(clipKey(key), {
        text: entry.text,
        url: url.href
      });
    }

    if (!manifest.size) {
      throw new Error("No usable recordings in manifest.");
    }

    manifestReady = true;
    updateReplay();
  } catch (error) {
    console.error(error);

    status(
      "Recordings could not load. Check audio/manifest.json " +
      "and that the audio folder has been pushed to GitHub."
    );
  }
}

function recording(key) {
  return manifest.get(clipKey(key));
}

function updateReplay() {
  replayBtn.disabled = !(
    manifestReady &&
    lastReply &&
    lastReply.keys.length &&
    lastReply.keys.every(key => recording(key))
  );
}

// Store a reply for optional replay.
// Only voice mode triggers automatic playback.
function reply(keys, listenAfter = false) {
  keys = Array.isArray(keys) ? keys : [keys];
  keys = keys.filter(Boolean);

  lastReply = keys.length ? { keys: [...keys] } : null;
  updateReplay();

  if (mode === "voice" && keys.length) {
    requestPlayback(keys, listenAfter);
  }
}

function clearReply() {
  lastReply = null;
  updateReplay();
}

// ============================================================
// Audio-file playback — no speechSynthesis
// ============================================================

function stopPlayback(forget = false) {
  playbackVersion++;

  clearTimeout(playbackTimer);
  clearTimeout(autoTimer);
  playbackTimer = null;
  autoTimer = null;

  queuedReply = null;
  playbackActive = false;

  if (cancelClip) {
    cancelClip();
    cancelClip = null;
  }

  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  if (forget) clearReply();
}

function enterTextMode(forget = true) {
  mode = "text";
  stopPlayback(forget);
  stopRecognition(true);
  transcript.textContent = "";
  status("");
}

function requestPlayback(keys, listenAfter) {
  stopPlayback();

  lastReply = { keys: [...keys] };
  updateReplay();

  if (!manifestReady) {
    status("Recordings are not loaded. Check audio/manifest.json.");
    return;
  }

  const missing = keys.find(key => !recording(key));

  if (missing) {
    status(`No recording available for ${missing}. See the screen.`);
    return;
  }

  queuedReply = {
    keys: [...keys],
    listenAfter,
    version: playbackVersion
  };

  if (micState !== "idle") {
    status("Stopping microphone before playing reply...");
    stopRecognition();
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

  const wait = micReleasedAt + HANDOVER_MS - Date.now();

  if (wait > 0) {
    playbackTimer = setTimeout(flushPlayback, wait);
    return;
  }

  queuedReply = null;
  runPlayback(job);
}

async function runPlayback(job) {
  playbackActive = true;

  try {
    for (const key of job.keys) {
      if (
        job.version !== playbackVersion ||
        document.hidden ||
        micState !== "idle"
      ) {
        return;
      }

      const entry = recording(key);
      status(`Playing: ${entry.text}`);

      const completed = await playClip(entry.url);

      if (!completed || job.version !== playbackVersion) {
        return;
      }
    }

    if (job.version !== playbackVersion) return;

    playbackActive = false;
    status("");

    if (
      job.listenAfter &&
      mode === "voice" &&
      autoToggle.checked
    ) {
      autoTimer = setTimeout(() => {
        autoTimer = null;

        if (
          job.version === playbackVersion &&
          mode === "voice" &&
          autoToggle.checked &&
          !document.hidden
        ) {
          startListening(true);
        }
      }, 350);
    }
  } catch (error) {
    if (job.version !== playbackVersion) return;

    playbackActive = false;
    console.error(error);

    if (error.name === "NotAllowedError") {
      status(
        "Safari blocked automatic audio. " +
        "Tap Read reply aloud to play the recording."
      );
    } else {
      status(
        "Could not play the recording. Check the MP3 is uploaded, " +
        "then tap Read reply aloud. " +
        (error.message || "")
      );
    }
  } finally {
    if (job.version === playbackVersion) {
      playbackActive = false;
    }
  }
}

function playClip(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    function finish(error, completed) {
      if (settled) return;
      settled = true;

      clearTimeout(timer);
      audio.onended = null;
      audio.onerror = null;
      cancelClip = null;

      if (!completed) audio.pause();

      if (error) {
        reject(error);
      } else {
        resolve(completed);
      }
    }

    cancelClip = () => finish(null, false);

    audio.onended = () => finish(null, true);

    audio.onerror = () => {
      const code = audio.error ? audio.error.code : "unknown";
      finish(new Error(`Audio error ${code}.`), false);
    };

    // A timeout is failure, not permission to restart listening.
    timer = setTimeout(() => {
      finish(new Error("Audio playback timed out."), false);
    }, 60000);

    audio.src = url;

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
// CSV parsing
// ============================================================

function splitCsvLine(line) {
  const columns = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const ch = line[index];

    if (ch === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      columns.push(value);
      value = "";
    } else {
      value += ch;
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
  let entryArea = "ME10";

  for (const line of lines) {
    const columns = splitCsvLine(line);
    const road = (columns[0] || "").trim();
    const walk = (columns[2] || "").trim();

    if (!road) {
      if (entries.length && entryArea === "ME10") {
        entryArea = "ME9";
      }

      continue;
    }

    if (!walk) continue;

    const letter =
      (columns[1] || "").trim().toUpperCase() ||
      normalise(road.replace(/^THE\s+/i, ""))[0] ||
      "";

    entries.push(makeEntry(road, walk, letter, entryArea));
  }

  return entries;
}

function makeEntry(road, walk, letter, entryArea) {
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
    area: entryArea,
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
  return roads.filter(entry => entry.area === area);
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

function answerPending(query) {
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

  if (!hits.length) {
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
  me10Tab.classList.toggle("active", area === "ME10");
  me9Tab.classList.toggle("active", area === "ME9");
  areaLabel.textContent = area;
}

function setArea(name) {
  if (!ready) return;

  stopPlayback(true);
  area = name;
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
    note(`Showing ${area}. Type or say a road name.`);

    // There is no recorded area-announcement clip.
    if (mode === "voice") {
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
      showDuties(areaRoads().filter(entry => entry.letter === letter));
    });
  });

  const walks = [
    ...new Set(areaRoads().map(entry => walkKey(entry.walk)))
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

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

function note(text) {
  const row = document.createElement("li");
  row.className = "note";
  row.textContent = text;
  results.replaceChildren(row);
  clearReply();
}

function appendNote(text) {
  const row = document.createElement("li");
  row.className = "note";
  row.textContent = text;
  results.appendChild(row);
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

  [...matches]
    .sort((a, b) => a.road.localeCompare(b.road))
    .forEach(entry => results.appendChild(resultRow(entry)));

  const duties = [
    ...new Set(matches.map(entry => walkKey(entry.walk)))
  ];

  // Recordings contain duty announcements, not standalone
  // road names. Keep the road/detail information on screen.
  if (duties.length <= 5) {
    reply(duties.map(duty => `duty:${duty}`));
  } else {
    clearReply();

    if (mode === "voice") {
      status("Multiple results. See the screen for their duties.");
    }
  }
}

function askDetail(matches, message) {
  if (mode !== "voice") {
    showDuties(matches);
    return;
  }

  suggestions = null;
  pending = { matches };
  compact();
  note(message);
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
    reply(`confirm:${options[0].base}`, true);
  } else {
    // No numbered road-name recordings exist in the manifest.
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
  note("Okay. Type or say the road again.");
  reply("prompt:retry", true);
}

function handleSuggestion(alternatives) {
  if (!suggestions) return false;

  const { options, stage, chosen } = suggestions;

  for (const raw of alternatives) {
    const said = cleanSpoken(raw);

    if (CANCEL.has(said)) {
      cancelSuggestions();
      return true;
    }

    if (YES.has(said)) {
      if (stage === "confirm") {
        acceptOption(chosen);
      } else if (options.length === 1) {
        acceptOption(0);
      } else {
        reply("prompt:choose", true);
      }

      return true;
    }

    if (NO.has(said)) {
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
    if (!final) return;
    if (handleSuggestion([query])) return;
    suggestions = null;
  }

  if (pending) {
    const matches = pending.matches;
    const hits = answerPending(query);

    if (hits) {
      showDuties(hits);
      return;
    }

    const requestedArea = areaFromText(query);

    if (requestedArea && final) {
      input.value = requestedArea;
      setArea(requestedArea);
      return;
    }

    if (
      /^\d/.test(normalise(query)) ||
      /^[A-Z]{1,2}\d/.test(normalise(query))
    ) {
      showDuties(matches);
      return;
    }

    pending = null;
  }

  const requestedArea = areaFromText(query);

  if (requestedArea) {
    if (final) {
      setArea(requestedArea);
    } else {
      clearResults();
    }

    return;
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
    if (mode === "voice" && needsDetail(matches)) {
      askDetail(
        matches,
        `${matches[0].base} has ${matches.length} entries. ` +
        "Which house number or postcode?"
      );
    } else {
      // Typed searches always show every matching entry.
      showDuties(matches);
    }

    return;
  }

  const elsewhere = findRoads(
    query,
    roads.filter(entry => entry.area !== area)
  );

  if (elsewhere.length) {
    pending = null;
    suggestions = null;

    note(
      `Not in ${area}. Found in ${elsewhere[0].area}. ` +
      "Select that area to search there."
    );

    // There is no matching recorded area-switch sentence.
    return;
  }

  const options = suggestRoads([query]);

  if (options.length) {
    offerOptions(options);
  } else {
    showDuties([]);
  }
}

// ============================================================
// Voice interpretation
// ============================================================

function cleanSpoken(value) {
  return String(value)
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function heardAsNumber(raw) {
  const text = cleanSpoken(raw).replace(
    /^(number|option|house number|house|the) /,
    ""
  );

  if (Object.prototype.hasOwnProperty.call(NUMBER_ALIASES, text)) {
    return NUMBER_ALIASES[text];
  }

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

  return output.join(" ")
    .replace(/\b(you|u)\s*(\d)/gi, "U$2")
    .replace(/\b(tea|tee|t)\s*(\d)/gi, "T$2")
    .replace(/\b(zed|zee|said|z)\s*(\d)/gi, "Z$2");
}

function handleVoice(alternatives) {
  if (mode !== "voice" || !ready) return;

  if (suggestions && handleSuggestion(alternatives)) return;
  suggestions = null;

  const spoken = alternatives.map(heardAsNumber);

  for (const text of spoken) {
    const requestedArea = areaFromText(text);

    if (requestedArea) {
      input.value = requestedArea;
      setArea(requestedArea);
      return;
    }
  }

  if (pending) {
    for (const text of spoken) {
      const hits = answerPending(text);

      if (hits) {
        input.value = text;
        showDuties(hits);
        return;
      }
    }

    // Keep the question open unless a different road was said.
    const differentRoad = spoken.find(text => findRoads(text).length);

    if (!differentRoad) {
      reply("prompt:detail", true);
      return;
    }

    pending = null;
  }

  for (const text of spoken) {
    const command = text.match(/^(walk|letter)\s+(.+)$/i);
    if (!command) continue;

    if (command[1].toLowerCase() === "walk") {
      switchMode("walk");
      input.value = command[2];
      showDuties(findWalk(command[2]));
    } else {
      switchMode("road");
      const letter = normalise(command[2])[0];

      showDuties(
        areaRoads().filter(entry => entry.letter === letter)
      );
    }

    return;
  }

  const direct = spoken.find(text =>
    findRoads(text).length || findWalk(text).length
  );

  if (direct) {
    input.value = direct;
    lookup(direct);
    return;
  }

  input.value = spoken[0] || "";
  const options = suggestRoads(alternatives);

  if (options.length) {
    offerOptions(options);
  } else {
    note("No road found. Type a road or tap Speak to retry.");
    reply("prompt:no-match", true);
  }
}

// ============================================================
// Microphone
// ============================================================

function updateMic() {
  micBtn.textContent = micState === "idle"
    ? "🎤 Speak"
    : micState === "stopping"
      ? "Stopping..."
      : "Stop listening";
}

function setupMic() {
  if (!SpeechRec) {
    micBtn.hidden = true;
    return;
  }

  micBtn.onclick = () => {
    if (micState !== "idle") {
      enterTextMode(false);
      return;
    }

    stopPlayback(true);
    mode = "voice";
    startListening(false);
  };
}

function stopRecognition(discard = false) {
  if (!recognizer || micState === "idle") return;

  const session = recognizer;
  const wasStopping = micState === "stopping";

  if (discard) session.ignoreResults = true;

  micState = "stopping";
  updateMic();

  try {
    if (discard) {
      session.abort();
    } else if (!wasStopping) {
      session.stop();
    }
  } catch (error) {
    console.warn(error);
  }

  if (stopTimer) return;

  stopTimer = setTimeout(() => {
    stopTimer = null;

    if (recognizer !== session || micState === "idle") return;

    session.ignoreResults = true;

    try {
      session.abort();
    } catch (error) {
      console.warn(error);
    }

    status(
      "Safari has not reported that the microphone stopped. " +
      "Reload the page if it stays stuck."
    );
  }, 6000);
}

function startListening(automatic) {
  if (
    !SpeechRec ||
    !ready ||
    mode !== "voice" ||
    micState !== "idle" ||
    playbackActive ||
    queuedReply ||
    document.hidden ||
    (automatic && !autoToggle.checked)
  ) {
    return;
  }

  let session;

  try {
    session = new SpeechRec();
  } catch (error) {
    status("Could not initialise the microphone.");
    return;
  }

  recognizer = session;
  session.ignoreResults = false;
  session.lang = "en-GB";
  session.continuous = false;
  session.interimResults = false;
  session.maxAlternatives = 5;

  let gotResult = false;
  let hadError = false;

  session.onstart = () => {
    if (recognizer !== session) return;

    if (micState === "stopping" || mode !== "voice") {
      session.ignoreResults = true;

      try {
        session.abort();
      } catch (error) {
        console.warn(error);
      }

      return;
    }

    micState = "listening";
    updateMic();
    transcript.textContent = "Listening...";
  };

  session.onresult = event => {
    if (
      recognizer !== session ||
      session.ignoreResults ||
      gotResult ||
      mode !== "voice"
    ) {
      return;
    }

    const result = event.results[event.resultIndex];
    if (!result || !result.isFinal) return;

    const alternatives = Array.from(
      result,
      item => item.transcript.trim()
    ).filter(Boolean);

    if (!alternatives.length) return;

    gotResult = true;
    transcript.textContent = `Heard: ${alternatives[0]}`;

    try {
      handleVoice(alternatives);
    } catch (error) {
      console.error(error);
      stopPlayback();
      status("Could not process that request. Tap Speak to retry.");
    } finally {
      stopRecognition();
    }
  };

  session.onerror = event => {
    if (recognizer !== session) return;

    hadError = true;
    if (session.ignoreResults || mode !== "voice") return;

    if (event.error === "not-allowed") {
      transcript.textContent = automatic
        ? "Tap Speak to answer."
        : "Microphone access denied. Check Safari permissions.";
    } else if (event.error === "no-speech") {
      transcript.textContent = "Nothing heard. Tap Speak to retry.";
    } else if (event.error !== "aborted" || !gotResult) {
      transcript.textContent =
        `Voice input: ${event.error}. Tap Speak to retry.`;
    }
  };

  session.onend = () => {
    if (recognizer !== session) return;

    clearTimeout(stopTimer);
    stopTimer = null;

    recognizer = null;
    micState = "idle";
    micReleasedAt = Date.now();
    updateMic();

    if (
      !gotResult &&
      !hadError &&
      !session.ignoreResults &&
      mode === "voice"
    ) {
      transcript.textContent = "Nothing heard. Tap Speak to retry.";
    }

    if (queuedReply) {
      flushPlayback();
    }
  };

  micState = "starting";
  updateMic();
  transcript.textContent = "Starting microphone...";
  status("");

  try {
    session.start();
  } catch (error) {
    if (recognizer === session) {
      recognizer = null;
      micState = "idle";
      updateMic();
    }

    transcript.textContent =
      "Could not start listening. Tap Speak to retry.";
  }
}
