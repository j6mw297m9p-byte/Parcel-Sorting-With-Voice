"use strict";

// ---------- Settings ----------
const PAUSE_MS = 900;          // pause after typing before a house number or postcode is read aloud
const SPEECH_RATE = 1.0;       // 1 is normal speed. Try 0.9 if it still sounds fast
const MIN_SUGGEST = 0.6;       // 0 to 1: how close a name must be to be offered as "did you mean"
const AREA_KEY = "sortingArea";
const AREA_SPOKEN = { ME10: "ME ten", ME9: "ME nine" };
const ORDINAL = ["One", "Two", "Three", "Four", "Five"];
const OPTION_STYLE = "width:100%;text-align:left;padding:12px;font-size:17px;background:#fff;color:#1d1d1f;border:1px solid #d9d9d6;border-radius:8px;";

// Words ignored when comparing names, so "Chalkwell" matches "Chalkwell Road"
const SUFFIXES = new Set([
  "ROAD", "RD", "STREET", "ST", "AVENUE", "AVE", "CLOSE", "DRIVE", "DR", "LANE", "WAY",
  "COURT", "CT", "TERRACE", "CRESCENT", "GARDENS", "GROVE", "PARK", "WALK", "PLACE",
  "MEWS", "RISE", "HOUSE", "THE"
]);

const YES_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "correct", "right", "thats right", "thats it",
  "that one", "ok", "okay", "sure", "confirm"
]);
const NO_WORDS = new Set(["no", "nope", "wrong", "incorrect", "not that"]);
const CANCEL_WORDS = new Set(["none", "neither", "none of these", "cancel", "try again", "start again"]);

// Words the recogniser often produces for numbers. Only whole phrases are changed
const NUMBER_ALIASES = {
  won: "1", wan: "1", to: "2", too: "2", tu: "2", tree: "3", free: "3",
  for: "4", fore: "4", ate: "8", first: "1", second: "2", third: "3", fourth: "4", fifth: "5"
};

// ---------- State ----------
let roads = [];               // every row from roads.csv, each tagged with its area
let selectedArea = "ME10";    // "ME10" or "ME9"
let pending = null;           // { matches } while waiting for a house number or postcode
let suggestions = null;       // { options, stage: "choose" or "confirm", chosen } for "did you mean"
let typingTimer = null;
let speechUnlocked = false;
let currentUtterance = null;

let letterGrid, walkGrid, results, roadTab, walkTab, me10Tab, me9Tab, areaLabel;
let input, micBtn, transcriptEl, resetBtn;

let recognizer = null;
let listening = false;
let autoStart = false;
let lastError = null;

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

// Trailing house list with no " - " separator, e.g. "QUARTZ WAY 1-5 7 9 11"
const HOUSES_AFTER_NAME = /^(.*?)\s+(\d{1,3}(?:-\d{1,3})?(?:\s+\d{1,3}(?:-\d{1,3})?)*)$/;

const NUMBER_WORDS = {
  oh: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

// ---------- Startup ----------
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

  roadTab.onclick = () => switchMode("road");
  walkTab.onclick = () => switchMode("walk");
  me10Tab.onclick = () => setArea("ME10", false);
  me9Tab.onclick = () => setArea("ME9", false);
  resetBtn.onclick = reset;

  // The first tap anywhere on the page unlocks spoken replies on iPhone
  document.addEventListener("pointerdown", unlockSpeech);

  input.addEventListener("input", () => {
    clearTimeout(typingTimer);
    handleInput(input.value, "live");
    if (pending && isNumberOrPostcode(input.value)) {
      typingTimer = setTimeout(() => handleInput(input.value, "pause"), PAUSE_MS);
    }
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      clearTimeout(typingTimer);
      unlockSpeech();
      handleInput(input.value, "final");
    }
  });

  setupVoice();
  loadData();
});

// ---------- Loading ----------
function loadData() {
  fetch("roads.csv")
    .then(res => {
      if (!res.ok) throw new Error(`roads.csv: HTTP ${res.status}`);
      return res.text();
    })
    .then(text => {
      roads = parseCsv(text);
      applyArea(savedArea() || "ME10");
      buildGrids();
      switchMode("road");
    })
    .catch(err => {
      console.error(err);
      showNote("Could not load roads.csv. Check it is in the same folder as index.html.");
    });
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).slice(1);
  const out = [];
  let areaName = "ME10";

  for (const line of lines) {
    const cols = splitCsvLine(line);
    const road = (cols[0] || "").trim();

    if (!road) {
      // Blank rows sit between the ME10 list and the ME9 list
      if (out.length && areaName === "ME10") areaName = "ME9";
      continue;
    }

    const walk = (cols[2] || "").trim();   // Duty column
    if (!walk) continue;

    const letter = (cols[1] || "").trim().toUpperCase() || firstLetter(road);
    out.push(makeEntry(road, walk, letter, areaName));
  }
  return out;
}

// Handles quoted fields, so a comma inside "..." does not split the column
function splitCsvLine(line) {
  const cols = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { cols.push(cur); cur = ""; }
    else cur += ch;
  }
  cols.push(cur);
  return cols;
}

function makeEntry(road, walk, letter, areaName) {
  // Split "BASE - DETAIL", or a trailing house list, into a base name and a detail
  const sep = road.indexOf(" - ");
  let base, detail;
  if (sep !== -1) {
    base = road.slice(0, sep).trim();
    detail = road.slice(sep + 3).trim();
  } else {
    const m = road.match(HOUSES_AFTER_NAME);
    base = m ? m[1].trim() : road;
    detail = m ? m[2] : "";
  }

  // "72 - 82" becomes "72-82" so it reads as one range
  const d = detail.replace(/(\d+)\s+-\s+(\d+)/g, "$1-$2").toUpperCase();

  const outcodes = (d.match(/\b[A-Z]{1,2}\d{1,2}(?:\s+\d[A-Z]{0,2})?\b/g) || []).map(normalise);
  const inwards = (d.match(/\b\d[A-Z]{2}\b/g) || []).map(normalise);
  const hasPostcode = outcodes.length > 0;

  const ranges = [];
  const singles = [];
  for (const tok of d.replace(/[()&,]/g, " ").split(/\s+/)) {
    const r = tok.match(/^(\d+)-(\d+)$/);
    if (r) {
      ranges.push({ lo: Math.min(+r[1], +r[2]), hi: Math.max(+r[1], +r[2]), parity: null });
    } else if (/^\d+$/.test(tok) && !hasPostcode) {
      singles.push(+tok);
    }
  }
  // Two ranges and nothing else are the odd side then the even side, e.g. "1-157  2-96"
  if (ranges.length === 2 && singles.length === 0) {
    ranges[0].parity = "odd";
    ranges[1].parity = "even";
  }

  // Entries with no house or postcode detail act as the catch-all for their name
  const fallback = /EXCEPT|REMAINDER/i.test(road) ||
    (ranges.length === 0 && singles.length === 0 && outcodes.length === 0 && inwards.length === 0);

  return {
    road,
    areaName,
    base,
    detail,
    walk,
    letter,
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
  // Matches the file's own convention: "THE CEDARS" is filed under C
  return normalise(name.replace(/^THE\s+/i, ""))[0] || "";
}

// ---------- Matching ----------
function normalise(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// T, U and Z codes join their number: T61, U070 and Z10 become 61, 70 and 10
function walkKey(s) {
  const n = normalise(s);
  const m = n.match(/^([TUZ]?)(\d+)$/);
  return m ? String(parseInt(m[2], 10)) : n;
}

function areaRoads() {
  return roads.filter(r => r.areaName === selectedArea);
}

function findWalk(q) {
  const k = walkKey(q);
  if (!k) return [];
  return areaRoads().filter(r => walkKey(r.walk) === k);
}

function findRoads(q, list = areaRoads()) {
  const n = normalise(q);
  if (!n) return [];
  const exact = list.filter(r => r.baseN === n);
  if (exact.length) return exact;
  const starts = list.filter(r => r.baseN.startsWith(n));
  if (starts.length) return starts;
  return n.length >= 4 ? list.filter(r => r.baseN.includes(n)) : [];
}

function needsDetail(matches) {
  return matches.length > 1 &&
    matches.every(m => m.baseN === matches[0].baseN) &&
    matches.some(m => m.detail);
}

function looksLikeRoad(q) {
  return normalise(q).length >= 3 && findRoads(q).length > 0;
}

function isNumberOrPostcode(q) {
  const n = normalise(q);
  return /^\d+[A-Z]?$/.test(n) || /^[A-Z]{1,2}\d/.test(n);
}

function housesMatch(e, num) {
  if (e.singles.includes(num)) return true;
  return e.ranges.some(r =>
    num >= r.lo && num <= r.hi &&
    (r.parity === null || (r.parity === "odd") === (num % 2 === 1)));
}

function postcodeMatch(e, n) {
  return e.outcodes.some(pc => pc.startsWith(n) || n.startsWith(pc)) ||
    e.inwards.some(iw => n.length > iw.length && n.endsWith(iw));
}

// Returns the matching entries for an answer to the open question, or null
function answerPending(q) {
  const list = pending.matches;
  const n = normalise(q);
  if (!n) return null;

  let hits;
  if (/^\d+[A-Z]?$/.test(n)) {
    const num = parseInt(n, 10);
    hits = list.filter(e => housesMatch(e, num));
  } else if (/^[A-Z]{1,2}\d/.test(n)) {
    hits = list.filter(e => postcodeMatch(e, n));
  } else if (n.length >= 3) {
    // Words such as "newgardens" match the detail text, with no catch-all
    hits = list.filter(e => e.detailN.includes(n));
    return hits.length ? hits : null;
  } else {
    return null;
  }

  if (!hits.length) hits = list.filter(e => e.fallback);
  return hits.length ? hits : null;
}

// ---------- Forgiving matching ----------
// Reduces a name to its distinctive part: "Chalkwell Road" becomes "CHALKWELL"
function coreName(s) {
  const words = String(s).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/)
    .filter(w => w && !SUFFIXES.has(w));
  return words.length ? words.join("") : normalise(s);
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - editDistance(a, b) / max : 0;
}

function scoreName(spokenCore, cand) {
  if (!spokenCore || !cand) return 0;
  if (spokenCore === cand) return 1;
  let score = similarity(spokenCore, cand);
  const shorter = Math.min(spokenCore.length, cand.length);
  // Covers a partial name such as "Chalk", or "Bell Rod" heard as BELLROD for BELL
  if (shorter >= 4 && (cand.startsWith(spokenCore) || spokenCore.startsWith(cand))) {
    score = Math.max(score, 0.8);
  }
  return score;
}

// Returns the closest road names in the selected area, best first
function suggestRoads(spokenList, limit = 3) {
  const bases = new Map();
  for (const r of areaRoads()) {
    if (!bases.has(r.baseN)) {
      bases.set(r.baseN, { base: r.base, baseN: r.baseN, core: coreName(r.base) });
    }
  }

  const best = new Map();
  for (const spoken of spokenList) {
    const said = coreName(spoken);
    if (said.length < 3) continue;
    for (const b of bases.values()) {
      const score = scoreName(said, b.core);
      if (score < MIN_SUGGEST) continue;
      const prev = best.get(b.baseN);
      if (!prev || prev.score < score) best.set(b.baseN, { ...b, score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// Speech often hears letter codes as words: "you 70" for U070, "tea 61" for T61
function fixCodes(s) {
  return s
    .replace(/\b(you|u)\s*(\d)/gi, "U$2")
    .replace(/\b(tea|tee|t)\s*(\d)/gi, "T$2")
    .replace(/\b(zed|zee|said|z)\s*(\d)/gi, "Z$2");
}

// ---------- Spoken text ----------
function cleanSpoken(s) {
  return String(s).toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

// "number two", "option 2", "to" and "won" all become a digit string where possible
function heardAsNumber(raw) {
  const s = cleanSpoken(raw).replace(/^(number|option|house number|house|the) /, "");
  if (NUMBER_ALIASES[s] !== undefined) return NUMBER_ALIASES[s];
  return wordsToDigits(s);
}

// Returns the index of a numbered choice, or -1 if the words are not a valid number
function choiceIndex(raw, count) {
  const n = Number(heardAsNumber(raw));
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : -1;
}

function wordsToDigits(text) {
  const words = text.toLowerCase().trim().split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const v = NUMBER_WORDS[words[i]];
    if (v === undefined) {
      out.push(words[i]);
      continue;
    }
    // "twenty one" becomes 21
    const next = NUMBER_WORDS[words[i + 1]];
    if (v >= 20 && next !== undefined && next > 0 && next < 10) {
      out.push(String(v + next));
      i++;
    } else {
      out.push(String(v));
    }
  }
  return out.join(" ");
}

// ---------- Area (ME10 / ME9) ----------
function areaFromText(text) {
  const n = normalise(text);
  return n === "ME10" || n === "ME9" ? n : null;
}

function savedArea() {
  try {
    const v = localStorage.getItem(AREA_KEY);
    return v === "ME10" || v === "ME9" ? v : null;
  } catch (e) {
    return null;   // some private browsing modes block storage
  }
}

function rememberArea(name) {
  try {
    localStorage.setItem(AREA_KEY, name);
  } catch (e) {
    // ignore: the choice just won't be remembered
  }
}

function applyArea(name) {
  selectedArea = name;
  me10Tab.classList.toggle("active", name === "ME10");
  me9Tab.classList.toggle("active", name === "ME9");
  areaLabel.textContent = name;
}

// speakIt is true for typed or spoken changes, false for taps
function setArea(name, speakIt) {
  applyArea(name);
  rememberArea(name);
  pending = null;
  suggestions = null;
  clearTimeout(typingTimer);
  buildGrids();

  const q = input.value.trim();
  if (q && !areaFromText(q)) {
    // Run the current search again in the new area
    handleInput(q, speakIt ? "final" : "live");
    return;
  }

  input.value = "";
  clearResults();
  showNote(`Showing ${name}. Type or say a road name.`);
  if (speakIt) speak(`Showing ${AREA_SPOKEN[name]}`, listenAuto);
}

// ---------- Grids and tabs ----------
function buildGrids() {
  buildLetterGrid();
  buildWalkGrid();
}

function buildLetterGrid() {
  letterGrid.innerHTML = "";
  const letters = [...new Set(areaRoads().map(r => r.letter).filter(l => /^[A-Z]$/.test(l)))].sort();
  letters.forEach(letter => addButton(letterGrid, letter, () => showLetter(letter)));
}

function buildWalkGrid() {
  walkGrid.innerHTML = "";
  const groups = [...new Set(areaRoads().map(r => walkKey(r.walk)))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  groups.forEach(key => addButton(walkGrid, key, () => showByWalk(key)));
}

function addButton(parent, label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.onclick = onClick;
  parent.appendChild(btn);
}

function switchMode(mode) {
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
  pending = null;
  suggestions = null;
  input.value = "";
  transcriptEl.textContent = "";
  clearResults();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---------- Display ----------
function showLetter(letter, speakIt = false) {
  pending = null;
  showDuties(areaRoads().filter(r => r.letter === letter), speakIt);
}

function showByWalk(key, speakIt = false) {
  pending = null;
  showDuties(areaRoads().filter(r => walkKey(r.walk) === key), speakIt);
}

function showDuties(matches, speakIt) {
  suggestions = null;
  compactGrids();
  results.innerHTML = "";

  if (!matches.length) {
    showNote("No road found");
  } else {
    [...matches]
      .sort((a, b) => a.road.localeCompare(b.road))
      .forEach(m => results.appendChild(resultRow(m)));
  }

  if (speakIt) speakDuties(matches);
}

function resultRow(m) {
  const li = document.createElement("li");

  const name = document.createElement("span");
  name.className = "road";
  name.textContent = m.base;
  if (m.detail) {
    name.appendChild(document.createElement("br"));
    const small = document.createElement("small");
    small.textContent = m.detail;
    name.appendChild(small);
  }

  const walk = document.createElement("span");
  walk.className = "walk";
  walk.textContent = m.walk;

  li.append(name, walk);
  return li;
}

function makeNote(text) {
  const li = document.createElement("li");
  li.className = "note";
  li.textContent = text;
  return li;
}

function showNote(text) {
  suggestions = null;
  results.innerHTML = "";
  results.appendChild(makeNote(text));
}

function optionRow(label, onClick, dashed = false) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.style.cssText = OPTION_STYLE + (dashed ? "color:#555;border-style:dashed;" : "");
  btn.onclick = onClick;
  li.appendChild(btn);
  return li;
}

function askDetail(matches, message, speakIt) {
  pending = { matches };
  compactGrids();
  showNote(message);
  if (speakIt) speak(message, listenAuto);
}

// ---------- "Did you mean" with read-back ----------
// Stage "choose": the options are listed and the user says a number or a name.
// Stage "confirm": the chosen option is read back and the user says yes or no.
function offerOptions(options, speakIt) {
  suggestions = { options, stage: "choose", chosen: -1 };
  renderChoose(speakIt);
}

function renderChoose(speakIt) {
  const options = suggestions.options;
  compactGrids();
  results.innerHTML = "";
  results.appendChild(makeNote(options.length === 1 ? "Did you mean this?" : "Did you mean one of these?"));

  options.forEach((opt, i) => {
    const label = options.length > 1 ? `${i + 1}. ${opt.base}` : opt.base;
    results.appendChild(optionRow(label, () => pickOption(i)));
  });
  results.appendChild(optionRow("None of these", cancelSuggestions, true));

  if (speakIt) speak(choosePrompt(options), listenAuto);
}

function renderConfirm(speakIt) {
  const i = suggestions.chosen;
  compactGrids();
  results.innerHTML = "";
  results.appendChild(makeNote(`${ORDINAL[i]}: ${suggestions.options[i].base}. Is that right?`));
  results.appendChild(optionRow("Yes, that one", () => acceptOption(i)));
  results.appendChild(optionRow("No, choose again", backToChoose, true));

  if (speakIt) speak(confirmPrompt(i), listenAuto);
}

function choosePrompt(options) {
  if (options.length === 1) return `Did you mean ${options[0].base}? Say yes or no.`;
  return `Did you mean: ${options.map((o, i) => `${i + 1}, ${o.base}`).join(". ")}? Say the number.`;
}

function confirmPrompt(i) {
  const opt = suggestions.options[i];
  const entries = areaRoads().filter(r => r.baseN === opt.baseN);
  const duty = entries.length === 1 ? `, duty ${spokenCode(entries[0].walk)}` : "";
  return `${ORDINAL[i]}: ${opt.base}${duty}. Is that right? Say yes or no.`;
}

function pickOption(i) {
  if (!suggestions || !suggestions.options[i]) return;
  if (suggestions.options.length === 1) {
    acceptOption(0);
    return;
  }
  suggestions.stage = "confirm";
  suggestions.chosen = i;
  renderConfirm(true);
}

function backToChoose() {
  if (!suggestions) return;
  suggestions.stage = "choose";
  suggestions.chosen = -1;
  renderChoose(true);
}

function acceptOption(i) {
  if (!suggestions || !suggestions.options[i]) return;
  const opt = suggestions.options[i];
  suggestions = null;
  input.value = opt.base;
  lookup(opt.base, true);   // a road with several entries still asks for the house number
}

function cancelSuggestions() {
  suggestions = null;
  input.value = "";
  showNote("Okay. Say or type the road name again.");
  speak("Okay. Say the road again.", listenAuto);
}

// Handles yes, no, a number, a name, or a cancel. Returns true if it was used.
function handleSuggestionVoice(alts) {
  const { options, stage, chosen } = suggestions;

  for (const raw of alts) {
    const said = cleanSpoken(raw);

    if (CANCEL_WORDS.has(said)) {
      cancelSuggestions();
      return true;
    }

    if (stage === "confirm") {
      if (YES_WORDS.has(said)) { acceptOption(chosen); return true; }
      if (NO_WORDS.has(said)) { backToChoose(); return true; }
    } else {
      if (YES_WORDS.has(said)) {
        if (options.length === 1) { acceptOption(0); return true; }
        speak("Say the number of the road you want.", listenAuto);
        return true;
      }
      if (NO_WORDS.has(said)) {
        cancelSuggestions();
        return true;
      }
    }

    const idx = choiceIndex(raw, options.length);
    if (idx !== -1) {
      pickOption(idx);
      return true;
    }

    // A name only counts if exactly one option has that name
    const core = coreName(raw);
    const named = options.filter(o => o.core === core);
    if (named.length === 1) {
      pickOption(options.indexOf(named[0]));
      return true;
    }
  }
  return false;
}

// ---------- Typed and spoken input ----------
// mode "live":  while typing, shows results without speaking
// mode "pause": after typing stops, speaks only a house number or postcode answer
// mode "final": on Enter or after a voice result, always speaks
function handleInput(text, mode) {
  const q = text.trim();

  if (!q) {
    pending = null;
    clearResults();
    return;
  }

  if (suggestions) {
    // Typing alone does not change a pending choice. Enter does
    if (mode !== "final") return;
    if (handleSuggestionVoice([q])) return;
    suggestions = null;   // a different search has been typed
  }

  if (pending) {
    const hits = answerPending(q);
    if (hits) {
      showDuties(hits, mode !== "live");
      return;
    }

    const area = areaFromText(q);
    if (area && mode === "final") {
      setArea(area, true);
      return;
    }

    // Still waiting for a house number or postcode
    if (isNumberOrPostcode(q) || (q.length >= 3 && !looksLikeRoad(q))) {
      if (mode === "final") {
        askDetail(pending.matches, `No match for ${q}. Try another house number or postcode.`, true);
      }
      return;
    }
    pending = null;   // a different road name has been typed
  }

  const area = areaFromText(q);
  if (area) {
    // Typing "ME9" switches only on Enter, so a half-typed postcode is not lost
    if (mode === "final") setArea(area, true);
    else clearResults();
    return;
  }

  if (mode === "live" && q.length < 3 && !findWalk(q).length) {
    clearResults();
    return;
  }

  lookup(q, mode === "final");
}

function lookup(q, speakIt) {
  const walkHits = findWalk(q);
  if (walkHits.length) {
    showDuties(walkHits, speakIt);
    return;
  }

  const matches = findRoads(q);
  if (!matches.length) {
    const elsewhere = findRoads(q, roads.filter(r => r.areaName !== selectedArea));
    if (elsewhere.length) {
      const otherArea = elsewhere[0].areaName;
      showNote(`Not in ${selectedArea}. Found in ${otherArea}. Say or type ${otherArea} to switch.`);
      if (speakIt) speak(`Not in ${AREA_SPOKEN[selectedArea]}. Found in ${AREA_SPOKEN[otherArea]}.`);
      return;
    }

    const options = suggestRoads([q]);
    if (options.length) offerOptions(options, speakIt);
    else showDuties([], speakIt);
    return;
  }

  if (needsDetail(matches)) {
    askDetail(matches, `${matches[0].base} has ${matches.length} entries. Which house number or postcode?`, speakIt);
    return;
  }
  showDuties(matches, speakIt);
}

function handleVoice(alts) {
  // An open "did you mean" question comes first
  if (suggestions && handleSuggestionVoice(alts)) return;
  suggestions = null;

  // Number words become digits and letter codes are fixed, e.g. "you seventy" becomes U70
  const spoken = alts.map(a => fixCodes(heardAsNumber(a)));

  // An open question about a house number or postcode
  if (pending) {
    for (const s of spoken) {
      const hits = answerPending(s);
      if (hits) {
        input.value = s;
        showDuties(hits, true);
        return;
      }
    }
  }

  // "ME nine" or "ME ten" switches area
  for (const s of spoken) {
    const area = areaFromText(s);
    if (area) {
      setArea(area, true);
      return;
    }
  }

  // "walk 12" and "letter m" are shortcuts
  for (const s of spoken) {
    const m = s.match(/^(walk|letter)\s+(.+)$/i);
    if (!m) continue;
    pending = null;
    if (m[1].toLowerCase() === "walk") {
      switchMode("walk");
      input.value = m[2];
      showDuties(findWalk(m[2]), true);
    } else {
      switchMode("road");
      showLetter(normalise(m[2])[0], true);
    }
    return;
  }

  // An exact match, or the start of a road name, is used straight away
  const direct = spoken.find(s => findRoads(s).length || findWalk(s).length);
  if (direct) {
    input.value = direct;
    handleInput(direct, "final");
    return;
  }

  // A house number or postcode while a question is open
  const numeric = spoken.find(s => isNumberOrPostcode(s));
  if (pending && numeric) {
    input.value = numeric;
    handleInput(numeric, "final");
    return;
  }

  // Nothing matched exactly, so offer the closest names and wait for confirmation
  pending = null;
  input.value = spoken[0];
  const options = suggestRoads(alts);
  if (options.length) {
    offerOptions(options, true);
    return;
  }
  showNote("No road found. Tap Speak to try again.");
  speak("No road found. Say the road again.", listenAuto);
}

// ---------- Speech output ----------
// speak() can report when the reply has finished, so listening can start after it
function speak(text, onDone) {
  if (!("speechSynthesis" in window)) {
    if (onDone) onDone();
    return;
  }

  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-GB";
  u.rate = SPEECH_RATE;
  currentUtterance = u;

  if (onDone) {
    let finished = false;
    const finish = () => {
      if (finished || u !== currentUtterance) return;
      finished = true;
      onDone();
    };
    u.onend = finish;
    // Safety net in case iOS never reports the end of the speech
    setTimeout(finish, 1500 + text.length * 100);
  }

  speechSynthesis.speak(u);
}

// iOS only allows speech after a user tap, so an empty utterance is started inside the first one
function unlockSpeech() {
  if (speechUnlocked || !("speechSynthesis" in window)) return;
  speechUnlocked = true;
  speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

// "U070" becomes "U 0 7 0" so each character is read separately
function spokenCode(code) {
  return /^\d+$/.test(code) ? code : code.split("").join(" ");
}

function speakDuties(matches) {
  if (!matches.length) {
    speak("No road found");
    return;
  }
  if (matches.length > 5) {
    speak(`${matches.length} entries. See the screen.`);
    return;
  }
  speak(matches.map(m => `${m.base}, duty ${spokenCode(m.walk)}`).join(". "));
}

// ---------- Speech input ----------
function startListening(auto) {
  if (!recognizer) return;
  if (listening) return;

  autoStart = auto;
  lastError = null;
  try {
    recognizer.start();
    listening = true;
    transcriptEl.textContent = "Listening...";
  } catch (e) {
    listening = false;
    transcriptEl.textContent = "Tap Speak and say your choice.";
  }
}

// Called once a spoken question has finished. iOS may refuse this, in which case the user taps Speak
function listenAuto() {
  startListening(true);
}

function setupVoice() {
  if (!SpeechRec) {
    micBtn.hidden = true;
    return;
  }

  recognizer = new SpeechRec();
  recognizer.lang = "en-GB";
  recognizer.continuous = false;
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 5;

  recognizer.onresult = e => {
    const alts = Array.from(e.results[0], a => a.transcript);
    transcriptEl.textContent = `Heard: ${alts[0]}`;
    handleVoice(alts);
  };

  recognizer.onerror = e => {
    lastError = e.error;
    listening = false;

    if (e.error === "no-speech") {
      transcriptEl.textContent = "Didn't hear anything. Tap Speak to try again.";
    } else if (e.error === "not-allowed") {
      transcriptEl.textContent = autoStart
        ? "Tap Speak and say your choice."
        : "Microphone is blocked. Allow it for this site in Safari's settings, then reload.";
    } else if (e.error === "aborted") {
      if (autoStart) transcriptEl.textContent = "Tap Speak and say your choice.";
    } else {
      transcriptEl.textContent = "Didn't catch that. Tap Speak and try again.";
    }
  };

  recognizer.onend = () => {
    listening = false;
    if (!lastError && transcriptEl.textContent === "Listening...") {
      transcriptEl.textContent = "Didn't hear anything. Tap Speak to try again.";
    }
  };

  micBtn.onclick = () => {
    unlockSpeech();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    startListening(false);
  };
}
