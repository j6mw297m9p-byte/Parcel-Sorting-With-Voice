"use strict";

// ============================================================
// Settings
// ============================================================

const PAUSE_MS = 900;
const SPEECH_RATE = 1;
const MIN_SUGGEST = 0.6;
const AREA_KEY = "sortingArea";

// This delay happens AFTER recognition reports that it ended.
const AUDIO_HANDOVER_MS = 600;
const MIC_STOP_WARNING_MS = 6000;

const AREA_SPOKEN = {
  ME10: "M E ten",
  ME9: "M E nine"
};

const ORDINAL = ["One", "Two", "Three", "Four", "Five"];

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

const NUMBER_ALIASES = {
  won: "1",
  wan: "1",
  to: "2",
  too: "2",
  tu: "2",
  tree: "3",
  free: "3",
  for: "4",
  fore: "4",
  ate: "8",
  first: "1",
  second: "2",
  third: "3",
  fourth: "4",
  fifth: "5"
};

const NUMBER_WORDS = {
  oh: 0,
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
};

const HOUSES_AFTER_NAME =
  /^(.*?)\s+(\d{1,3}(?:-\d{1,3})?(?:\s+\d{1,3}(?:-\d{1,3})?)*)$/;

const SpeechRec =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const synth = window.speechSynthesis || null;

// ============================================================
// State
// ============================================================

let roads = [];
let dataReady = false;
let selectedArea = "ME10";

let pending = null;
let suggestions = null;
let typingTimer = null;

// Microphone states:
// idle -> starting -> listening -> stopping -> idle
let micState = "idle";
let recognizer = null;
let micStopTimer = null;
let micReleasedAt = 0;

// Speech output.
let queuedReply = null;
let lastReply = null;
let currentUtterance = null;
let speechVersion = 0;
let speechStartTimer = null;
let speechWatchdog = null;
let followUpTimer = null;

// Page elements.
let letterGrid;
let walkGrid;
let results;
let roadTab;
let walkTab;
let me10Tab;
let me9Tab;
let areaLabel;
let input;
let micBtn;
let transcriptEl;
let resetBtn;

// Extra controls are created by JavaScript.
let replayBtn;
let audioStatus;
let autoListenToggle;

// ============================================================
// Startup
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  letterGrid = document.getElementById("letterGrid");
  walkGrid = document.getElementById("walkGrid");
  results = document.getElementById("results");
  roadTab = document.getElementById("roadTab");
  walkTab = document.getElementById("walkTab");
  me10Tab = document.getElementById("me10Tab");
  me9Tab = document.getElementById("me9Tab");
  areaLabel = document.getElementById("areaLabel");
  input = document.getElementById("roadSearch");
  micBtn = document.getElementById("micBtn");
  transcriptEl = document.getElementById("transcript");
  resetBtn = document.getElementById("resetBtn");

  createAudioControls();

  roadTab.onclick = () => switchMode("road");
  walkTab.onclick = () => switchMode("walk");

  me10Tab.onclick = () => setArea("ME10", false);
  me9Tab.onclick = () => setArea("ME9", false);

  resetBtn.onclick = reset;

  input.addEventListener("input", () => {
    clearTimeout(typingTimer);
    stopInteraction();

    handleInput(input.value, "live");

    if (pending && isNumberOrPostcode(input.value)) {
      typingTimer = setTimeout(() => {
        handleInput(input.value, "pause");
      }, PAUSE_MS);
    }
  });

  input.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;

    event.preventDefault();
    clearTimeout(typingTimer);
    handleInput(input.value, "final");
  });

  setupVoiceButton();
  loadData();

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;

    clearTimeout(typingTimer);
    stopInteraction();
    setAudioStatus("Paused. Tap Speak when you return.");
  });

  window.addEventListener("pagehide", () => {
    stopInteraction();
  });
});

function createAudioControls() {
  const controls = document.createElement("div");
  controls.style.margin = "10px 0";

  replayBtn = document.createElement("button");
  replayBtn.type = "button";
  replayBtn.textContent = "Read reply aloud";
  replayBtn.disabled = true;
  replayBtn.style.padding = "10px 12px";
  replayBtn.style.fontSize = "16px";

  replayBtn.onclick = () => {
    if (!lastReply) return;

    const reply = lastReply;

    // If the mic is idle, playback is requested directly
    // from this tap. Otherwise we must wait for mic onend.
    speak(reply.text, reply.onDone);
  };

  const label = document.createElement("label");
  label.style.display = "block";
  label.style.marginTop = "10px";

  autoListenToggle = document.createElement("input");
  autoListenToggle.type = "checkbox";
  autoListenToggle.checked = true;
  autoListenToggle.style.marginRight = "8px";

  label.append(
    autoListenToggle,
    document.createTextNode(
      "Listen automatically after spoken questions"
    )
  );

  audioStatus = document.createElement("p");
  audioStatus.setAttribute("role", "status");
  audioStatus.setAttribute("aria-live", "polite");
  audioStatus.style.fontSize = "14px";
  audioStatus.style.margin = "8px 0";

  controls.append(replayBtn, label, audioStatus);

  transcriptEl.insertAdjacentElement("afterend", controls);

  if (!synth) {
    setAudioStatus(
      "This browser does not support built-in spoken replies."
    );
  }
}

function setAudioStatus(message) {
  if (audioStatus) {
    audioStatus.textContent = message;
  }
}

// ============================================================
// Loading and CSV parsing
// ============================================================

async function loadData() {
  showNote("Loading roads...");
  micBtn.disabled = true;

  try {
    const response = await fetch("roads.csv");

    if (!response.ok) {
      throw new Error(`roads.csv: HTTP ${response.status}`);
    }

    roads = parseCsv(await response.text());

    if (!roads.length) {
      throw new Error("No usable road rows found in roads.csv.");
    }

    dataReady = true;
    applyArea(savedArea() || "ME10");
    buildGrids();
    switchMode("road");

    showNote(
      `Showing ${selectedArea}. Type or say a road name.`
    );
  } catch (error) {
    console.error(error);

    showNote(
      "Could not load roads.csv. Check that it is in the " +
      "same folder as index.html and has the expected columns."
    );
  } finally {
    micBtn.disabled = !dataReady;
  }
}

function parseCsv(text) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .slice(1);

  const entries = [];
  let areaName = "ME10";

  for (const line of lines) {
    const columns = splitCsvLine(line);
    const road = (columns[0] || "").trim();

    if (!road) {
      // Your existing file separates ME10 and ME9
      // with blank rows.
      if (entries.length && areaName === "ME10") {
        areaName = "ME9";
      }

      continue;
    }

    const walk = (columns[2] || "").trim();
    if (!walk) continue;

    const letter =
      (columns[1] || "").trim().toUpperCase() ||
      firstLetter(road);

    entries.push(
      makeEntry(road, walk, letter, areaName)
    );
  }

  return entries;
}

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

function makeEntry(road, walk, letter, areaName) {
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

  const detailText = detail
    .replace(/(\d+)\s+-\s+(\d+)/g, "$1-$2")
    .toUpperCase();

  const outcodes = (
    detailText.match(
      /\b[A-Z]{1,2}\d{1,2}(?:\s+\d[A-Z]{0,2})?\b/g
    ) || []
  ).map(normalise);

  const inwards = (
    detailText.match(/\b\d[A-Z]{2}\b/g) || []
  ).map(normalise);

  const ranges = [];
  const singles = [];
  const hasPostcode = outcodes.length > 0;

  const tokens = detailText
    .replace(/[()&,]/g, " ")
    .split(/\s+/);

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const match = token.match(/^(\d+)-(\d+)$/);

    if (match) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      const next = tokens[index + 1];

      let parity = null;

      if (next === "ODD") parity = "odd";
      if (next === "EVEN") parity = "even";

      ranges.push({
        lo: Math.min(first, second),
        hi: Math.max(first, second),
        first,
        parity
      });
    } else if (/^\d+$/.test(token) && !hasPostcode) {
      singles.push(Number(token));
    }
  }

  // Two ranges generally represent the two sides of a road.
  // Use the range's first number rather than assuming
  // the first range is always odd.
  if (ranges.length === 2 && singles.length === 0) {
    for (const range of ranges) {
      if (!range.parity) {
        range.parity = range.first % 2 ? "odd" : "even";
      }
    }
  }

  const fallback =
    /EXCEPT|REMAINDER/i.test(road) ||
    (
      ranges.length === 0 &&
      singles.length === 0 &&
      outcodes.length === 0 &&
      inwards.length === 0
    );

  return {
    road,
    walk,
    letter,
    areaName,
    base,
    detail,
    baseN: normalise(base),
    detailN: normalise(detail),
    ranges,
    singles,
    outcodes,
    inwards,
    fallback
  };
}

function firstLetter(name) {
  return normalise(
    name.replace(/^THE\s+/i, "")
  )[0] || "";
}

// ============================================================
// Matching
// ============================================================

function normalise(value) {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function walkKey(value) {
  const text = normalise(value);
  const match = text.match(/^([TUZ]?)(\d+)$/);

  return match ? String(parseInt(match[2], 10)) : text;
}

function displayWalk(walk) {
  return walkKey(walk);
}

function areaRoads() {
  return roads.filter(
    entry => entry.areaName === selectedArea
  );
}

function findWalk(query) {
  const key = walkKey(query);
  if (!key) return [];

  return areaRoads().filter(
    entry => walkKey(entry.walk) === key
  );
}

function findRoads(query, list = areaRoads()) {
  const text = normalise(query);
  if (!text) return [];

  const exact = list.filter(
    entry => entry.baseN === text
  );

  if (exact.length) return exact;

  const starts = list.filter(
    entry => entry.baseN.startsWith(text)
  );

  if (starts.length) return starts;

  return text.length >= 4
    ? list.filter(entry => entry.baseN.includes(text))
    : [];
}

function needsDetail(matches) {
  return (
    matches.length > 1 &&
    matches.every(
      entry => entry.baseN === matches[0].baseN
    ) &&
    matches.some(entry => entry.detail)
  );
}

function looksLikeRoad(query) {
  return (
    normalise(query).length >= 3 &&
    findRoads(query).length > 0
  );
}

function isNumberOrPostcode(query) {
  const text = normalise(query);

  return (
    /^\d+[A-Z]?$/.test(text) ||
    /^[A-Z]{1,2}\d/.test(text) ||
    /^\d[A-Z]{2}$/.test(text)
  );
}

function housesMatch(entry, number) {
  if (entry.singles.includes(number)) return true;

  return entry.ranges.some(range => {
    if (number < range.lo || number > range.hi) {
      return false;
    }

    if (!range.parity) return true;

    return (
      (range.parity === "odd") ===
      (number % 2 === 1)
    );
  });
}

function postcodeMatch(entry, text) {
  return (
    entry.outcodes.some(
      code => code.startsWith(text) || text.startsWith(code)
    ) ||
    entry.inwards.some(
      inward => text === inward || text.endsWith(inward)
    )
  );
}

function answerPending(query) {
  if (!pending) return null;

  const list = pending.matches;
  const text = normalise(query);

  if (!text) return null;

  let hits;

  if (/^\d+[A-Z]?$/.test(text)) {
    hits = list.filter(entry =>
      housesMatch(entry, parseInt(text, 10))
    );
  } else if (
    /^[A-Z]{1,2}\d/.test(text) ||
    /^\d[A-Z]{2}$/.test(text)
  ) {
    hits = list.filter(entry =>
      postcodeMatch(entry, text)
    );
  } else if (text.length >= 3) {
    hits = list.filter(entry =>
      entry.detailN.includes(text)
    );

    return hits.length ? hits : null;
  } else {
    return null;
  }

  if (!hits.length) {
    hits = list.filter(entry => entry.fallback);
  }

  return hits.length ? hits : null;
}

// ============================================================
// Forgiving road-name matching
// ============================================================

function coreName(value) {
  const words = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(word => word && !SUFFIXES.has(word));

  return words.length ? words.join("") : normalise(value);
}

function editDistance(first, second) {
  let previous = Array.from(
    { length: second.length + 1 },
    (_, index) => index
  );

  for (let row = 1; row <= first.length; row++) {
    const current = [row];

    for (let column = 1; column <= second.length; column++) {
      const cost =
        first[row - 1] === second[column - 1] ? 0 : 1;

      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost
      );
    }

    previous = current;
  }

  return previous[second.length];
}

function similarity(first, second) {
  const longest = Math.max(first.length, second.length);

  return longest
    ? 1 - editDistance(first, second) / longest
    : 0;
}

function scoreName(spoken, candidate) {
  if (!spoken || !candidate) return 0;
  if (spoken === candidate) return 1;

  let score = similarity(spoken, candidate);

  if (
    Math.min(spoken.length, candidate.length) >= 4 &&
    (
      candidate.startsWith(spoken) ||
      spoken.startsWith(candidate)
    )
  ) {
    score = Math.max(score, 0.8);
  }

  return score;
}

function suggestRoads(spokenList, limit = 3) {
  const bases = new Map();

  for (const entry of areaRoads()) {
    if (!bases.has(entry.baseN)) {
      bases.set(entry.baseN, {
        base: entry.base,
        baseN: entry.baseN,
        core: coreName(entry.base)
      });
    }
  }

  const best = new Map();

  for (const spoken of spokenList) {
    const said = coreName(spoken);
    if (said.length < 3) continue;

    for (const candidate of bases.values()) {
      const score = scoreName(said, candidate.core);
      if (score < MIN_SUGGEST) continue;

      const previous = best.get(candidate.baseN);

      if (!previous || score > previous.score) {
        best.set(candidate.baseN, {
          ...candidate,
          score
        });
      }
    }
  }

  return [...best.values()]
    .sort((first, second) => second.score - first.score)
    .slice(0, limit);
}

// ============================================================
// Spoken-text normalisation
// ============================================================

function cleanSpoken(value) {
  return String(value)
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wordsToDigits(text) {
  const words = text.toLowerCase().trim().split(/\s+/);
  const output = [];

  for (let index = 0; index < words.length; index++) {
    const value = NUMBER_WORDS[words[index]];

    if (value === undefined) {
      output.push(words[index]);
      continue;
    }

    const next = NUMBER_WORDS[words[index + 1]];

    if (
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
    /^(number|option|house number|house|the) /,
    ""
  );

  if (
    Object.prototype.hasOwnProperty.call(
      NUMBER_ALIASES,
      text
    )
  ) {
    return NUMBER_ALIASES[text];
  }

  return wordsToDigits(text);
}

function fixCodes(text) {
  return text
    .replace(/\b(you|u)\s*(\d)/gi, "U$2")
    .replace(/\b(tea|tee|t)\s*(\d)/gi, "T$2")
    .replace(/\b(zed|zee|said|z)\s*(\d)/gi, "Z$2");
}

function choiceIndex(raw, count) {
  const number = Number(heardAsNumber(raw));

  return (
    Number.isInteger(number) &&
    number >= 1 &&
    number <= count
  ) ? number - 1 : -1;
}

// ============================================================
// Area selection
// ============================================================

function areaFromText(text) {
  const value = normalise(text);

  return value === "ME10" || value === "ME9"
    ? value
    : null;
}

function savedArea() {
  try {
    const value = localStorage.getItem(AREA_KEY);

    return value === "ME10" || value === "ME9"
      ? value
      : null;
  } catch (error) {
    return null;
  }
}

function rememberArea(name) {
  try {
    localStorage.setItem(AREA_KEY, name);
  } catch (error) {
    // The app can still work without saved preferences.
  }
}

function applyArea(name) {
  selectedArea = name;

  me10Tab.classList.toggle("active", name === "ME10");
  me9Tab.classList.toggle("active", name === "ME9");
  areaLabel.textContent = name;
}

function setArea(name, speakIt) {
  if (!dataReady) return;

  stopInteraction();
  clearTimeout(typingTimer);

  applyArea(name);
  rememberArea(name);

  pending = null;
  suggestions = null;

  buildGrids();

  const query = input.value.trim();

  if (query && !areaFromText(query)) {
    handleInput(query, speakIt ? "final" : "live");
    return;
  }

  input.value = "";
  clearResults();

  showNote(`Showing ${name}. Type or say a road name.`);

  if (speakIt) {
    speak(`Showing ${AREA_SPOKEN[name]}.`, listenAuto);
  }
}

// ============================================================
// Tabs and grids
// ============================================================

function buildGrids() {
  letterGrid.innerHTML = "";
  walkGrid.innerHTML = "";

  const letters = [
    ...new Set(
      areaRoads()
        .map(entry => entry.letter)
        .filter(letter => /^[A-Z]$/.test(letter))
    )
  ].sort();

  letters.forEach(letter => {
    addButton(letterGrid, letter, () => {
      stopInteraction();
      showLetter(letter);
    });
  });

  const walks = [
    ...new Set(
      areaRoads().map(entry => walkKey(entry.walk))
    )
  ].sort((first, second) =>
    first.localeCompare(second, undefined, {
      numeric: true
    })
  );

  walks.forEach(walk => {
    addButton(walkGrid, walk, () => {
      stopInteraction();
      showByWalk(walk);
    });
  });
}

function addButton(parent, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.onclick = onClick;
  parent.appendChild(button);
}

function switchMode(mode) {
  stopInteraction();
  clearTimeout(typingTimer);

  const isRoad = mode === "road";
  pending = null;

  roadTab.classList.toggle("active", isRoad);
  walkTab.classList.toggle("active", !isRoad);
  letterGrid.classList.toggle("hidden", !isRoad);
  walkGrid.classList.toggle("hidden", isRoad);

  clearResults();
}

function compactGrids() {
  letterGrid.classList.add("compact");
  walkGrid.classList.add("compact");
}

function clearResults() {
  suggestions = null;
  results.innerHTML = "";

  letterGrid.classList.remove("compact");
  walkGrid.classList.remove("compact");
}

function reset() {
  clearTimeout(typingTimer);
  stopInteraction();

  pending = null;
  suggestions = null;
  input.value = "";
  transcriptEl.textContent = "";

  clearResults();
  setAudioStatus("");
}

// ============================================================
// Results and prompts
// ============================================================

function showLetter(letter, speakIt = false) {
  pending = null;

  showDuties(
    areaRoads().filter(entry => entry.letter === letter),
    speakIt
  );
}

function showByWalk(key, speakIt = false) {
  pending = null;

  showDuties(
    areaRoads().filter(
      entry => walkKey(entry.walk) === key
    ),
    speakIt
  );
}

function showDuties(matches, speakIt) {
  pending = null;
  suggestions = null;
  compactGrids();
  results.innerHTML = "";

  if (!matches.length) {
    showNote("No road found");
  } else {
    [...matches]
      .sort((first, second) =>
        first.road.localeCompare(second.road)
      )
      .forEach(entry => {
        results.appendChild(resultRow(entry));
      });
  }

  if (speakIt) speakDuties(matches);
}

function resultRow(entry) {
  const row = document.createElement("li");
  const name = document.createElement("span");

  name.className = "road";
  name.textContent = entry.base;

  if (entry.detail) {
    const detail = document.createElement("small");
    detail.textContent = entry.detail;

    name.append(
      document.createElement("br"),
      detail
    );
  }

  const walk = document.createElement("span");
  walk.className = "walk";
  walk.textContent = displayWalk(entry.walk);

  row.append(name, walk);
  return row;
}

function makeNote(text) {
  const row = document.createElement("li");
  row.className = "note";
  row.textContent = text;
  return row;
}

function showNote(text) {
  suggestions = null;
  results.innerHTML = "";
  results.appendChild(makeNote(text));
}

function optionRow(label, onClick, dashed = false) {
  const row = document.createElement("li");
  const button = document.createElement("button");

  button.type = "button";
  button.textContent = label;

  Object.assign(button.style, {
    width: "100%",
    textAlign: "left",
    padding: "12px",
    fontSize: "17px",
    background: "#fff",
    color: dashed ? "#555" : "#1d1d1f",
    border: "1px solid #d9d9d6",
    borderRadius: "8px"
  });

  if (dashed) button.style.borderStyle = "dashed";

  button.onclick = () => {
    stopInteraction();
    onClick();
  };

  row.appendChild(button);
  return row;
}

function askDetail(matches, message, speakIt) {
  pending = { matches };
  compactGrids();
  showNote(message);

  if (speakIt) speak(message, listenAuto);
}

// ============================================================
// "Did you mean" choices and confirmation
// ============================================================

function offerOptions(options, speakIt) {
  suggestions = {
    options,
    stage: "choose",
    chosen: -1
  };

  renderChoose(speakIt);
}

function renderChoose(speakIt) {
  if (!suggestions) return;

  const options = suggestions.options;
  compactGrids();
  results.innerHTML = "";

  results.appendChild(
    makeNote(
      options.length === 1
        ? "Did you mean this?"
        : "Did you mean one of these?"
    )
  );

  options.forEach((option, index) => {
    const label = options.length > 1
      ? `${index + 1}. ${option.base}`
      : option.base;

    results.appendChild(
      optionRow(label, () => pickOption(index))
    );
  });

  results.appendChild(
    optionRow("None of these", cancelSuggestions, true)
  );

  if (speakIt) {
    speak(choosePrompt(options), listenAuto);
  }
}

function renderConfirm(speakIt) {
  if (!suggestions) return;

  const index = suggestions.chosen;
  const option = suggestions.options[index];

  if (!option) return;

  compactGrids();
  results.innerHTML = "";

  results.appendChild(
    makeNote(
      `${ORDINAL[index]}: ${option.base}. Is that right?`
    )
  );

  results.appendChild(
    optionRow("Yes, that one", () => acceptOption(index))
  );

  results.appendChild(
    optionRow("No, choose again", backToChoose, true)
  );

  if (speakIt) {
    speak(confirmPrompt(index), listenAuto);
  }
}

function choosePrompt(options) {
  if (options.length === 1) {
    return (
      `Did you mean ${options[0].base}? ` +
      "Say yes or no."
    );
  }

  const choices = options.map(
    (option, index) => `${index + 1}, ${option.base}`
  ).join(". ");

  return `Did you mean: ${choices}? Say the number.`;
}

function confirmPrompt(index) {
  const option = suggestions.options[index];

  const entries = areaRoads().filter(
    entry => entry.baseN === option.baseN
  );

  const duty = entries.length === 1
    ? `, duty ${displayWalk(entries[0].walk)}`
    : "";

  return (
    `${ORDINAL[index]}: ${option.base}${duty}. ` +
    "Is that right? Say yes or no."
  );
}

function pickOption(index) {
  if (!suggestions || !suggestions.options[index]) {
    return;
  }

  if (suggestions.options.length === 1) {
    acceptOption(0);
    return;
  }

  suggestions.stage = "confirm";
  suggestions.chosen = index;
  renderConfirm(true);
}

function backToChoose() {
  if (!suggestions) return;

  suggestions.stage = "choose";
  suggestions.chosen = -1;

  renderChoose(true);
}

function acceptOption(index) {
  if (!suggestions || !suggestions.options[index]) {
    return;
  }

  const option = suggestions.options[index];

  suggestions = null;
  input.value = option.base;

  lookup(option.base, true);
}

function cancelSuggestions() {
  suggestions = null;
  pending = null;
  input.value = "";

  showNote("Okay. Say or type the road name again.");
  speak("Okay. Say the road again.", listenAuto);
}

function handleSuggestionVoice(alternatives) {
  if (!suggestions) return false;

  const { options, stage, chosen } = suggestions;

  for (const raw of alternatives) {
    const said = cleanSpoken(raw);

    if (CANCEL_WORDS.has(said)) {
      cancelSuggestions();
      return true;
    }

    if (stage === "confirm") {
      if (YES_WORDS.has(said)) {
        acceptOption(chosen);
        return true;
      }

      if (NO_WORDS.has(said)) {
        backToChoose();
        return true;
      }
    } else {
      if (YES_WORDS.has(said)) {
        if (options.length === 1) {
          acceptOption(0);
        } else {
          speak(
            "Say the number of the road you want.",
            listenAuto
          );
        }

        return true;
      }

      if (NO_WORDS.has(said)) {
        cancelSuggestions();
        return true;
      }
    }

    const index = choiceIndex(raw, options.length);

    if (index !== -1) {
      pickOption(index);
      return true;
    }

    const core = coreName(raw);

    const named = options.filter(
      option => option.core === core
    );

    if (named.length === 1) {
      pickOption(options.indexOf(named[0]));
      return true;
    }
  }

  return false;
}

// ============================================================
// Typed input and lookup
// ============================================================

function handleInput(text, mode) {
  if (!dataReady) return;

  const query = text.trim();

  if (!query) {
    pending = null;
    clearResults();
    return;
  }

  if (suggestions) {
    if (mode !== "final") return;

    if (handleSuggestionVoice([query])) return;
    suggestions = null;
  }

  if (pending) {
    const hits = answerPending(query);

    if (hits) {
      showDuties(hits, mode !== "live");
      return;
    }

    const area = areaFromText(query);

    if (area && mode === "final") {
      input.value = area;
      setArea(area, true);
      return;
    }

    if (
      isNumberOrPostcode(query) ||
      (query.length >= 3 && !looksLikeRoad(query))
    ) {
      if (mode === "final") {
        askDetail(
          pending.matches,
          `No match for ${query}. ` +
          "Try another house number or postcode.",
          true
        );
      }

      return;
    }

    pending = null;
  }

  const area = areaFromText(query);

  if (area) {
    if (mode === "final") {
      setArea(area, true);
    } else {
      clearResults();
    }

    return;
  }

  if (
    mode === "live" &&
    query.length < 3 &&
    !findWalk(query).length
  ) {
    clearResults();
    return;
  }

  lookup(query, mode === "final");
}

function lookup(query, speakIt) {
  const walkHits = findWalk(query);

  if (walkHits.length) {
    showDuties(walkHits, speakIt);
    return;
  }

  const matches = findRoads(query);

  if (!matches.length) {
    const elsewhere = findRoads(
      query,
      roads.filter(
        entry => entry.areaName !== selectedArea
      )
    );

    if (elsewhere.length) {
      const otherArea = elsewhere[0].areaName;

      showNote(
        `Not in ${selectedArea}. Found in ${otherArea}. ` +
        `Say or type ${otherArea} to switch.`
      );

      if (speakIt) {
        speak(
          `Not in ${AREA_SPOKEN[selectedArea]}. ` +
          `Found in ${AREA_SPOKEN[otherArea]}. ` +
          `Say ${AREA_SPOKEN[otherArea]} to switch.`,
          listenAuto
        );
      }

      return;
    }

    const options = suggestRoads([query]);

    if (options.length) {
      offerOptions(options, speakIt);
    } else {
      showDuties([], speakIt);
    }

    return;
  }

  if (needsDetail(matches)) {
    askDetail(
      matches,
      `${matches[0].base} has ${matches.length} entries. ` +
      "Which house number or postcode?",
      speakIt
    );

    return;
  }

  showDuties(matches, speakIt);
}

// ============================================================
// Spoken input interpretation
// ============================================================

function handleVoice(alternatives) {
  if (!dataReady || !alternatives.length) return;

  if (
    suggestions &&
    handleSuggestionVoice(alternatives)
  ) {
    return;
  }

  suggestions = null;

  const spoken = alternatives.map(
    value => fixCodes(heardAsNumber(value))
  );

  // Area commands take precedence over pending detail answers.
  for (const value of spoken) {
    const area = areaFromText(value);

    if (area) {
      input.value = area;
      setArea(area, true);
      return;
    }
  }

  if (pending) {
    for (const value of spoken) {
      const hits = answerPending(value);

      if (hits) {
        input.value = value;
        showDuties(hits, true);
        return;
      }
    }
  }

  for (const value of spoken) {
    const command = value.match(/^(walk|letter)\s+(.+)$/i);

    if (!command) continue;

    pending = null;

    if (command[1].toLowerCase() === "walk") {
      switchMode("walk");
      input.value = command[2];
      showDuties(findWalk(command[2]), true);
    } else {
      switchMode("road");
      showLetter(normalise(command[2])[0], true);
    }

    return;
  }

  const direct = spoken.find(
    value => findRoads(value).length || findWalk(value).length
  );

  if (direct) {
    input.value = direct;
    handleInput(direct, "final");
    return;
  }

  const numeric = spoken.find(isNumberOrPostcode);

  if (pending && numeric) {
    input.value = numeric;
    handleInput(numeric, "final");
    return;
  }

  pending = null;
  input.value = spoken[0];

  const options = suggestRoads(alternatives);

  if (options.length) {
    offerOptions(options, true);
    return;
  }

  showNote("No road found. Tap Speak to try again.");
  speak("No road found. Say the road again.", listenAuto);
}

// ============================================================
// Speech output
// ============================================================

function clearSpeechTimers() {
  clearTimeout(speechStartTimer);
  clearTimeout(speechWatchdog);
  clearTimeout(followUpTimer);

  speechStartTimer = null;
  speechWatchdog = null;
  followUpTimer = null;
}

function cancelSpeech(forgetReply = false) {
  speechVersion++;
  clearSpeechTimers();

  queuedReply = null;
  currentUtterance = null;

  if (synth) {
    synth.cancel();
  }

  if (forgetReply) {
    lastReply = null;

    if (replayBtn) {
      replayBtn.disabled = true;
    }
  }
}

function stopInteraction() {
  cancelSpeech(true);

  // Abort discards any late recognition result from an
  // interaction the user has deliberately left.
  requestRecognitionStop(true);
}

function speak(text, onDone) {
  text = String(text || "").trim();
  if (!text) return;

  const wasSpeaking = Boolean(
    currentUtterance ||
    (synth && (synth.speaking || synth.pending))
  );

  cancelSpeech();

  const reply = {
    text,
    onDone,
    version: speechVersion,
    notBefore: wasSpeaking ? Date.now() + 150 : 0
  };

  lastReply = { text, onDone };
  replayBtn.disabled = !synth;

  if (!synth) {
    setAudioStatus(
      "Spoken replies are not supported in this browser."
    );
    return;
  }

  queuedReply = reply;

  if (micState !== "idle") {
    setAudioStatus("Stopping microphone before reading reply...");
    requestRecognitionStop();
    return;
  }

  flushSpeech();
}

function flushSpeech() {
  clearTimeout(speechStartTimer);
  speechStartTimer = null;

  if (
    !queuedReply ||
    micState !== "idle" ||
    document.hidden
  ) {
    return;
  }

  const reply = queuedReply;

  if (reply.version !== speechVersion) {
    queuedReply = null;
    return;
  }

  const earliestStart = Math.max(
    micReleasedAt + AUDIO_HANDOVER_MS,
    reply.notBefore
  );

  const remaining = earliestStart - Date.now();

  if (remaining > 0) {
    speechStartTimer = setTimeout(
      flushSpeech,
      remaining
    );
    return;
  }

  queuedReply = null;
  playSpeech(reply);
}

function playSpeech(reply) {
  if (
    !synth ||
    reply.version !== speechVersion ||
    micState !== "idle" ||
    document.hidden
  ) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(reply.text);
  utterance.lang = "en-GB";
  utterance.rate = SPEECH_RATE;

  const voices = synth.getVoices();

  const britishVoice = voices.find(
    voice => voice.lang.toLowerCase() === "en-gb"
  );

  if (britishVoice) {
    utterance.voice = britishVoice;
  }

  currentUtterance = utterance;

  function isCurrent() {
    return (
      reply.version === speechVersion &&
      currentUtterance === utterance
    );
  }

  function fail(message) {
    if (!isCurrent()) return;

    clearTimeout(speechWatchdog);
    speechWatchdog = null;
    currentUtterance = null;

    // Do not automatically restart listening after failure.
    setAudioStatus(
      `${message} Tap Read reply aloud to retry.`
    );
  }

  utterance.onstart = () => {
    if (isCurrent()) {
      setAudioStatus("Reading reply...");
    }
  };

  utterance.onend = () => {
    if (!isCurrent()) return;

    clearTimeout(speechWatchdog);
    speechWatchdog = null;
    currentUtterance = null;

    setAudioStatus("");

    if (typeof reply.onDone === "function") {
      followUpTimer = setTimeout(() => {
        followUpTimer = null;

        if (
          reply.version === speechVersion &&
          !document.hidden &&
          !currentUtterance &&
          !queuedReply
        ) {
          reply.onDone();
        }
      }, 300);
    }
  };

  utterance.onerror = event => {
    console.error("Speech playback failed:", event.error);

    fail(
      `Audio failed: ${event.error || "unknown error"}.`
    );
  };

  // A timeout is treated as failure, not successful playback.
  // That prevents the microphone reopening over a silent reply.
  const timeout = Math.max(
    15000,
    5000 + reply.text.length * 160
  );

  speechWatchdog = setTimeout(() => {
    if (!isCurrent()) return;

    fail("Safari did not finish the spoken reply.");
    synth.cancel();
  }, timeout);

  setAudioStatus("Starting spoken reply...");

  try {
    synth.speak(utterance);
  } catch (error) {
    console.error(error);
    fail("Could not start spoken reply.");
  }
}

function speakDuties(matches) {
  if (!matches.length) {
    speak("No road found.");
    return;
  }

  if (matches.length > 5) {
    speak(`${matches.length} entries. See the screen.`);
    return;
  }

  const message = matches.map(
    entry =>
      `${entry.base}, duty ${displayWalk(entry.walk)}`
  ).join(". ");

  speak(message);
}

function listenAuto() {
  if (
    !autoListenToggle.checked ||
    document.hidden ||
    micState !== "idle"
  ) {
    return;
  }

  startListening(true);
}

// ============================================================
// Speech recognition
// ============================================================

function updateMicButton() {
  if (!micBtn) return;

  if (micState === "idle") {
    micBtn.textContent = "🎤 Speak";
  } else if (micState === "stopping") {
    micBtn.textContent = "Stopping...";
  } else {
    micBtn.textContent = "Stop listening";
  }
}

function setupVoiceButton() {
  if (!SpeechRec) {
    micBtn.hidden = true;

    setAudioStatus(
      "Voice input is unavailable. You can still type searches."
    );

    return;
  }

  micBtn.onclick = () => {
    if (micState !== "idle") {
      requestRecognitionStop();
      return;
    }

    clearTimeout(typingTimer);
    cancelSpeech();
    startListening(false);
  };
}

function requestRecognitionStop(discardResult = false) {
  if (!recognizer || micState === "idle") return;

  const session = recognizer;

  if (discardResult) {
    session.ignoreResults = true;
  }

  const alreadyStopping = micState === "stopping";
  micState = "stopping";
  updateMicButton();

  try {
    if (discardResult) {
      session.abort();
    } else if (!alreadyStopping) {
      session.stop();
    }
  } catch (error) {
    console.warn("Could not stop recognition:", error);
  }

  if (micStopTimer) return;

  micStopTimer = setTimeout(() => {
    micStopTimer = null;

    if (
      recognizer !== session ||
      micState === "idle"
    ) {
      return;
    }

    // Ask Safari to abort, but do NOT claim the mic is
    // released until onend actually arrives.
    session.ignoreResults = true;

    try {
      session.abort();
    } catch (error) {
      console.warn("Could not abort recognition:", error);
    }

    setAudioStatus(
      "Safari has not reported that the microphone stopped. " +
      "If it stays stuck, reload the page."
    );
  }, MIC_STOP_WARNING_MS);
}

function startListening(automatic) {
  if (
    !SpeechRec ||
    !dataReady ||
    document.hidden ||
    micState !== "idle"
  ) {
    return;
  }

  if (currentUtterance || queuedReply) return;

  let session;

  try {
    session = new SpeechRec();
  } catch (error) {
    console.error(error);
    setAudioStatus("Could not initialise voice input.");
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

    // If the user stopped while startup was pending,
    // keep the stopping state and ask Safari to abort.
    if (micState === "stopping") {
      try {
        session.abort();
      } catch (error) {
        console.warn(error);
      }

      return;
    }

    micState = "listening";
    updateMicButton();

    transcriptEl.textContent = "Listening...";
  };

  session.onresult = event => {
    if (
      recognizer !== session ||
      session.ignoreResults ||
      gotResult
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

    transcriptEl.textContent =
      `Heard: ${alternatives[0]}`;

    try {
      // The microphone is still marked active here,
      // so any spoken response is queued.
      handleVoice(alternatives);
    } catch (error) {
      console.error(error);
      cancelSpeech();

      setAudioStatus(
        "Could not process that request. Tap Speak to try again."
      );
    } finally {
      // Explicitly stop after a final result.
      requestRecognitionStop();
    }
  };

  session.onerror = event => {
    if (recognizer !== session) return;

    hadError = true;

    if (session.ignoreResults) return;

    console.warn("Recognition error:", event.error);

    if (event.error === "no-speech") {
      transcriptEl.textContent =
        "Didn't hear anything. Tap Speak to try again.";
    } else if (event.error === "not-allowed") {
      transcriptEl.textContent = automatic
        ? "Tap Speak and say your choice."
        : (
          "Microphone access was denied. Check Safari's " +
          "microphone permission for this site."
        );
    } else if (event.error === "audio-capture") {
      transcriptEl.textContent =
        "Microphone unavailable. Check other apps or audio devices.";
    } else if (event.error === "aborted") {
      if (!gotResult) {
        transcriptEl.textContent =
          "Listening stopped. Tap Speak to try again.";
      }
    } else {
      transcriptEl.textContent =
        `Voice input failed: ${event.error}. Tap Speak to retry.`;
    }

    // Errors do not prove that the audio session ended.
    // Only onend releases the queued speech.
  };

  session.onend = () => {
    if (recognizer !== session) return;

    clearTimeout(micStopTimer);
    micStopTimer = null;

    recognizer = null;
    micState = "idle";
    micReleasedAt = Date.now();

    updateMicButton();

    if (
      !gotResult &&
      !hadError &&
      !session.ignoreResults
    ) {
      transcriptEl.textContent =
        "Didn't hear anything. Tap Speak to try again.";
    }

    if (queuedReply) {
      flushSpeech();
    } else if (!currentUtterance && !document.hidden) {
      setAudioStatus("");
    }
  };

  micState = "starting";
  updateMicButton();
  transcriptEl.textContent = "Starting microphone...";
  setAudioStatus("");

  try {
    session.start();
  } catch (error) {
    console.error(error);

    // start() threw, so this session did not start.
    if (recognizer === session) {
      recognizer = null;
      micState = "idle";
      updateMicButton();
    }

    transcriptEl.textContent =
      "Could not start listening. Tap Speak to try again.";

    if (automatic) {
      setAudioStatus(
        "Safari may require another tap to start the microphone."
      );
    }
  }
}