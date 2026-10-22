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
function splitCsv
