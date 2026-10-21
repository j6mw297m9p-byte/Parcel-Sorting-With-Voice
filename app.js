"use strict";

// ---------- State ----------
let roads = [];       // parsed rows from roads.csv
let pending = null;   // { matches } while waiting for a house number or postcode

let letterGrid, walkGrid, results, roadTab, walkTab;
let input, micBtn, transcriptEl, resetBtn;

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

// Matches a trailing house list such as "QUARTZ WAY 1-5 7 9 11" (no " - " separator)
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
  input = document.getElementById("roadSearch");
  micBtn = document.getElementById("micBtn");
  transcriptEl = document.getElementById("transcript");
  resetBtn = document.getElementById("resetBtn");

  roadTab.onclick = () => switchMode("road");
  walkTab.onclick = () => switchMode("walk");
  resetBtn.onclick = reset;

  input.addEventListener("input", () => handleInput(input.value, true));
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      unlockSpeech();
      handleInput(input.value, false);
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
      buildLetterGrid();
      buildWalkGrid();
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

  for (const line of lines) {
    const cols = splitCsvLine(line);
    const road = (cols[0] || "").trim();
    const walk = (cols[2] || "").trim();   // Duty column
    if (!road || !walk) continue;          // skips the blank separator rows

    const letter = (cols[1] || "").trim().toUpperCase() || firstLetter(road);
    out.push(makeEntry(road, walk, letter));
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

function makeEntry(road, walk, letter) {
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

// ---------- Matching helpers ----------
function normalise(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// "U070" and "U70" compare equal
function walkKey(s) {
  return normalise(s).replace(/^([A-Z]*)0+(?=\d)/, "$1");
}

function findWalk(q) {
  const k = walkKey(q);
  if (!k) return [];
  return roads.filter(r => walkKey(r.walk) === k);
}

function findRoads(q) {
  const n = normalise(q);
  if (!n) return [];
  const exact = roads.filter(r => r.baseN === n);
  if (exact.length) return exact;
  const starts = roads.filter(r => r.baseN.startsWith(n));
  if (starts.length) return starts;
  return n.length >= 4 ? roads.filter(r => r.baseN.includes(n)) : [];
}

function needsDetail(matches) {
  return matches.length > 1 &&
    matches.every(m => m.baseN === matches[0].baseN) &&
    matches.some(m => m.detail);
}

function isNumberOrPostcode(q) {
  const n = normalise(q);
  return /^\d+[A-Z]?$/.test(n) || (/^[A-Z]{1,2}\d/.test(n) && n.length <= 8);
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

// ---------- Grids ----------
function buildLetterGrid() {
  letterGrid.innerHTML = "";
  const letters = [...new Set(roads.map(r => r.letter).filter(l => /^[A-Z]$/.test(l)))].sort();
  letters.forEach(letter => addButton(letterGrid, letter, () => showLetter(letter)));
}

function buildWalkGrid() {
  walkGrid.innerHTML = "";
  const walks = [...new Set(roads.map(r => r.walk))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  walks.forEach(walk => addButton(walkGrid, walk, () => showByWalk(walk)));
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
  results.innerHTML = "";
  letterGrid.classList.remove("compact");
  walkGrid.classList.remove("compact");
}

function reset() {
  pending = null;
  input.value = "";
  transcriptEl.textContent = "";
  clearResults();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---------- Display ----------
function showLetter(letter) {
  pending = null;
  showDuties(roads.filter(r => r.letter === letter), false);
}

function showByWalk(walk) {
  pending = null;
  showDuties(roads.filter(r => r.walk === walk), false);
}

function showDuties(matches, speakIt) {
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

function showNote(text) {
  results.innerHTML = "";
  const li = document.createElement("li");
  li.className = "note";
  li.textContent = text;
  results.appendChild(li);
}

function askDetail(matches, message, speakIt) {
  pending = { matches };
  compactGrids();
  showNote(message);
  if (speakIt) speak(message);
}

// ---------- Typed and spoken input ----------
// live = true while typing (no speech); false on Enter or after a voice result
function handleInput(text, live) {
  const q = text.trim();
  if (!q) {
    clearResults();
    pending = null;
    return;
  }

  if (pending && isNumberOrPostcode(q)) {
    const hits = answerPending(q);
    if (hits) {
      showDuties(hits, !live);
    } else if (!live) {
      askDetail(pending.matches, `No match for ${q}. Try another house number or postcode.`, true);
    }
    return;
  }

  if (pending && !live) {
    const hits = answerPending(q);
    if (hits) {
      showDuties(hits, true);
      return;
    }
  }

  pending = null;
  if (live && q.length < 3 && !findWalk(q).length) {
    clearResults();
    return;
  }
  lookup(q, !live);
}

function lookup(q, speakIt) {
  const walkHits = findWalk(q);
  if (walkHits.length) {
    showDuties(walkHits, speakIt);
    return;
  }

  const matches = findRoads(q);
  if (!matches.length) {
    showDuties([], speakIt);
    return;
  }

  if (needsDetail(matches)) {
    askDetail(matches, `${matches[0].base} has ${matches.length} entries. Which house number or postcode?`, speakIt);
    return;
  }
  showDuties(matches, speakIt);
}

function handleVoice(alts) {
  const spoken = alts.map(wordsToDigits);

  // An open question comes first, so "fifteen" answers "which house number?"
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
      showLetter(normalise(m[2])[0]);
    }
    return;
  }

  // Otherwise use the first alternative that matches something
  const pick = spoken.find(s => findWalk(s).length || findRoads(s).length) || spoken[0];
  input.value = pick;
  handleInput(pick, false);
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
    // "twenty one" -> 21
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

// ---------- Speech ----------
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-GB";
  speechSynthesis.speak(u);
}

// iOS only allows speech output after a tap, so start an empty utterance inside one
function unlockSpeech() {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

// "U070" -> "U 0 7 0" so each character is read separately
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

function setupVoice() {
  if (!SpeechRec) {
    micBtn.hidden = true;
    return;
  }

  const rec = new SpeechRec();
  rec.lang = "en-GB";
  rec.continuous = false;
  rec.interimResults = false;
  rec.maxAlternatives = 5;

  // start() must run directly inside the tap on iOS
  micBtn.onclick = () => {
    unlockSpeech();
    transcriptEl.textContent = "Listening...";
    try {
      rec.start();
    } catch (e) {
      // already listening
    }
  };

  rec.onresult = e => {
    const alts = Array.from(e.results[0], a => a.transcript);
    transcriptEl.textContent = `Heard: ${alts[0]}`;
    handleVoice(alts);
  };

  rec.onerror = e => {
    transcriptEl.textContent = e.error === "not-allowed"
      ? "Microphone is blocked. Allow it for this site in Safari's settings, then reload."
      : "Didn't catch that. Tap Speak and try again.";
  };

  rec.onend = () => {
    if (transcriptEl.textContent === "Listening...") {
      transcriptEl.textContent = "Didn't hear anything. Tap Speak to try again.";
    }
  };
}
