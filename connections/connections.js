import { CHAMPIONS } from "../shared/champions-data.js";
import {
  buildCategories, buildConnectionsPuzzle, connectionsPuzzleToSpec,
  connectionsPuzzleFromSpec, shuffle,
} from "../shared/attributes.js";
import { createStatsStore, formatTime } from "../shared/stats.js";
import { createRoom, joinRoom, subscribeToRoom, updateRoomState } from "../shared/multiplayer.js";

const GROUP_SIZE = 4;
const NUM_GROUPS = 4;
const MAX_MISTAKES = 4;
const DIFFICULTY_EMOJI = { yellow: "🟨", green: "🟩", blue: "🟦", purple: "🟪" };
const GROUP_TYPE_LABELS = {
  role: "Role", resource: "Resource type", damageType: "Damage type",
  difficulty: "Difficulty rating", gender: "Gender", region: "Region",
  species: "Species", position: "Position", rangeType: "Range type",
};

const ALL_CATEGORIES = buildCategories(CHAMPIONS);
const CATEGORY_BY_ID = new Map(ALL_CATEGORIES.map((c) => [c.id, c]));
const CHAMP_BY_ID = new Map(CHAMPIONS.map((c) => [c.id, c]));

/* ---------- stats ---------- */
const { load: loadStats, save: saveStats } = createStatsStore("runeterra-connections-stats", {
  gamesPlayed: 0, perfectSolves: 0, currentStreak: 0, bestStreak: 0, bestTimeSeconds: null,
});
let stats = loadStats();

function renderStatsStrip() {
  const bestTime = stats.bestTimeSeconds != null ? formatTime(stats.bestTimeSeconds) : "—";
  statsStripEl.innerHTML =
    `<span><b>${stats.gamesPlayed}</b> played</span>` +
    `<span><b>${stats.perfectSolves}</b> perfect</span>` +
    `<span>Best streak <b>${stats.bestStreak}</b></span>` +
    `<span>Best time <b>${bestTime}</b></span>`;
}

/* ---------- game state ---------- */
let puzzle = null;              // 4 groups: { category, champions, difficulty }, hardest first
let champDifficulty = new Map(); // championId -> difficulty, for this puzzle
let tileOrder = [];             // championIds, shuffled, stable for the round
let solvedGroupIdxs = [];       // indices into puzzle, in the order actually solved
let lastSolvedCount = 0;        // solvedGroupIdxs.length at the moment the round ended (before reveal)
let selectedIds = new Set();
let guessHistory = [];          // one emoji string per submitted attempt, for the share text
let mistakes = 0;
let roundOver = true;
let infiniteMistakes = false;
let timedRound = false;
let settingsLocked = false;
let hintLevel = 0;
let hintTextValue = "";
let hintTargetGroupIdx = null;

let timerInterval = null;
let timerStartMs = null;
let timerElapsedSeconds = 0;

let mp = null; // { code, role, unsubscribe, resultSent, lastData, currentPuzzleKey }

const connBoardEl = document.getElementById("conn-board");
const mistakesEl = document.getElementById("conn-mistakes");
const guessHint = document.getElementById("guess-hint");
const errLine = document.getElementById("err-line");
const statScore = document.getElementById("stat-score");
const statMistakes = document.getElementById("stat-mistakes");
const statStreak = document.getElementById("stat-streak");
const resultBanner = document.getElementById("result-banner");
const finalScore = document.getElementById("final-score");
const finalLine = document.getElementById("final-line");
const mpResultLine = document.getElementById("mp-result-line");
const hintRow = document.getElementById("hint-row");
const hintBtn = document.getElementById("hint-btn");
const hintText = document.getElementById("hint-text");
const giveUpBtn = document.getElementById("give-up-btn");
const shareBtn = document.getElementById("share-btn");
const copyToast = document.getElementById("copy-toast");
const infiniteToggle = document.getElementById("infinite-toggle");
const infiniteToggleLabel = document.getElementById("infinite-toggle-label");
const timerToggle = document.getElementById("timer-toggle");
const timerToggleLabel = document.getElementById("timer-toggle-label");
const timerRow = document.getElementById("timer-row");
const timerPill = document.getElementById("timer-pill");
const settingsNote = document.getElementById("settings-note");
const DEFAULT_SETTINGS_NOTE = settingsNote.textContent;
const statsStripEl = document.getElementById("stats-strip");
const newPuzzleBtn = document.getElementById("new-puzzle-btn");
const deselectBtn = document.getElementById("deselect-btn");
const submitBtn = document.getElementById("submit-group-btn");

const mpCreateBtn = document.getElementById("mp-create-btn");
const mpJoinBtn = document.getElementById("mp-join-btn");
const mpCodeInput = document.getElementById("mp-code-input");
const mpLobbyRow = document.getElementById("mp-lobby-row");
const mpCodeDisplay = document.getElementById("mp-code-display");
const mpStatus = document.getElementById("mp-status");
const mpIntro = document.getElementById("mp-intro");

/* ---------- puzzle (de)serialization for multiplayer ---------- */
function newLocalPuzzle() {
  return buildConnectionsPuzzle(CHAMPIONS, ALL_CATEGORIES, { groupSize: GROUP_SIZE, numGroups: NUM_GROUPS, maxTries: 4000 });
}
function specFromPuzzle(p) { return connectionsPuzzleToSpec(p); }
function puzzleFromSpec(spec) { return connectionsPuzzleFromSpec(spec, CATEGORY_BY_ID, CHAMP_BY_ID); }
function puzzleKeyFor(groupsSpec) {
  return (groupsSpec || []).map((g) => g.categoryId + ":" + g.champIds.join(",")).join("|");
}

/* ---------- round lifecycle ---------- */
function newGame(forcedPuzzle) {
  const p = forcedPuzzle || newLocalPuzzle();
  if (!p) {
    connBoardEl.innerHTML = '<p style="color:var(--blood-red);">Could not build a puzzle — try again.</p>';
    return;
  }
  puzzle = p;
  champDifficulty = new Map();
  puzzle.forEach((g) => g.champions.forEach((c) => champDifficulty.set(c.id, g.difficulty)));
  tileOrder = shuffle(puzzle.flatMap((g) => g.champions.map((c) => c.id)));

  solvedGroupIdxs = [];
  lastSolvedCount = 0;
  selectedIds.clear();
  guessHistory = [];
  mistakes = 0;
  roundOver = false;
  hintLevel = 0;
  hintTextValue = "";
  hintTargetGroupIdx = null;

  infiniteMistakes = infiniteToggle.checked;
  timedRound = mp ? true : timerToggle.checked;

  errLine.textContent = "";
  errLine.className = "err";
  guessHint.textContent = "Select 4 champions that share something, then submit.";
  giveUpBtn.disabled = false;
  submitBtn.disabled = true;
  resultBanner.classList.remove("show");
  copyToast.textContent = "";
  mpResultLine.style.display = "none";

  settingsLocked = false;
  setSettingsLocked(false);

  stopTimer();
  timerElapsedSeconds = 0;
  timerRow.style.display = timedRound ? "flex" : "none";
  updateTimerDisplay();
  if (mp) startTimer(); // 1v1: clock starts the moment the round is live for both

  renderMistakes();
  renderBoard();
  renderHintUI();
  updateStats();
  renderStatsStrip();
}

function setSettingsLocked(locked) {
  timerToggle.disabled = locked || !!mp;
  timerToggleLabel.classList.toggle("disabled", locked || !!mp);
}
function lockSettingsForRound() {
  if (settingsLocked) return;
  timedRound = mp ? true : timerToggle.checked;
  settingsLocked = true;
  setSettingsLocked(true);
  if (timedRound && !mp) startTimer();
  timerRow.style.display = timedRound ? "flex" : "none";
}

// Infinite-mistakes stays live all round (even after locking in the timer),
// same as Grid's infinite-guesses toggle — it's a safe thing to flip mid-run.
infiniteToggle.addEventListener("change", () => {
  infiniteMistakes = infiniteToggle.checked;
  renderMistakes();
});

/* ---------- timer ---------- */
function updateTimerDisplay() { timerPill.textContent = formatTime(timerElapsedSeconds); }
function startTimer() {
  if (timerInterval) return;
  timerStartMs = Date.now() - timerElapsedSeconds * 1000;
  timerInterval = setInterval(() => {
    timerElapsedSeconds = Math.floor((Date.now() - timerStartMs) / 1000);
    updateTimerDisplay();
  }, 250);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

/* ---------- rendering ---------- */
function renderMistakes() {
  if (infiniteMistakes) { mistakesEl.style.display = "none"; mistakesEl.innerHTML = ""; return; }
  mistakesEl.style.display = "flex";
  mistakesEl.innerHTML = "";
  for (let i = 0; i < MAX_MISTAKES; i++) {
    const dot = document.createElement("div");
    dot.className = "conn-mistake-dot" + (i < mistakes ? " used" : "");
    mistakesEl.appendChild(dot);
  }
}

function renderBoard() {
  connBoardEl.innerHTML = "";

  solvedGroupIdxs.forEach((gi) => {
    const g = puzzle[gi];
    const row = document.createElement("div");
    row.className = `conn-solved-row diff-${g.difficulty}`;
    const label = document.createElement("div");
    label.className = "cat-label";
    label.textContent = g.category.label;
    const champs = document.createElement("div");
    champs.className = "cat-champs";
    champs.textContent = g.champions.map((c) => c.name).join(" · ");
    row.appendChild(label);
    row.appendChild(champs);
    connBoardEl.appendChild(row);
  });

  const solvedChampIds = new Set(solvedGroupIdxs.flatMap((gi) => puzzle[gi].champions.map((c) => c.id)));
  const remainingIds = tileOrder.filter((id) => !solvedChampIds.has(id));
  if (remainingIds.length > 0) {
    const gridEl = document.createElement("div");
    gridEl.className = "conn-grid";
    remainingIds.forEach((id) => gridEl.appendChild(makeTile(id)));
    connBoardEl.appendChild(gridEl);
  }
}

function makeTile(champId) {
  const champ = CHAMP_BY_ID.get(champId);
  const d = document.createElement("div");
  d.className = "conn-tile" + (selectedIds.has(champId) ? " selected" : "");
  d.dataset.id = champId;
  const img = document.createElement("img");
  img.src = champ.iconUrl;
  img.alt = "";
  const name = document.createElement("div");
  name.className = "tname";
  name.textContent = champ.name;
  d.appendChild(img);
  d.appendChild(name);
  if (!roundOver) d.addEventListener("click", () => toggleTile(champId));
  return d;
}

function updateStats() {
  statScore.textContent = `${solvedGroupIdxs.length}/${NUM_GROUPS}`;
  statMistakes.textContent = mistakes;
  statStreak.textContent = stats.currentStreak;
}

/* ---------- selection & guessing ---------- */
function toggleTile(champId) {
  if (roundOver) return;
  if (selectedIds.has(champId)) {
    selectedIds.delete(champId);
  } else {
    if (selectedIds.size >= GROUP_SIZE) return;
    selectedIds.add(champId);
  }
  submitBtn.disabled = selectedIds.size !== GROUP_SIZE;
  errLine.textContent = "";
  errLine.className = "err";
  renderBoard();
}

deselectBtn.addEventListener("click", () => {
  if (roundOver || selectedIds.size === 0) return;
  selectedIds.clear();
  submitBtn.disabled = true;
  errLine.textContent = "";
  errLine.className = "err";
  renderBoard();
});

function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
function intersectCount(a, b) {
  const s = new Set(a);
  return b.filter((x) => s.has(x)).length;
}
function shakeSelectedTiles(ids) {
  requestAnimationFrame(() => {
    ids.forEach((id) => {
      const el = connBoardEl.querySelector(`.conn-tile[data-id="${id}"]`);
      if (!el) return;
      el.classList.add("shake");
      setTimeout(() => el.classList.remove("shake"), 400);
    });
  });
}

function submitGroup() {
  if (roundOver || selectedIds.size !== GROUP_SIZE) return;
  lockSettingsForRound();

  const selArr = [...selectedIds];
  guessHistory.push(selArr.map((id) => DIFFICULTY_EMOJI[champDifficulty.get(id)]).join(""));

  const matchIdx = puzzle.findIndex((g, i) => !solvedGroupIdxs.includes(i) && setsEqual(g.champions.map((c) => c.id), selArr));

  if (matchIdx !== -1) {
    solvedGroupIdxs.push(matchIdx);
    selectedIds.clear();
    submitBtn.disabled = true;
    errLine.textContent = "";
    errLine.className = "err";
    if (hintTargetGroupIdx === matchIdx) { hintLevel = 0; hintTextValue = ""; hintTargetGroupIdx = null; }
    renderBoard();
    renderHintUI();
    updateStats();
    if (solvedGroupIdxs.length === NUM_GROUPS) finishRound(false, false);
    return;
  }

  mistakes++;
  const oneAway = puzzle.some((g, i) => !solvedGroupIdxs.includes(i) && intersectCount(g.champions.map((c) => c.id), selArr) === GROUP_SIZE - 1);
  errLine.textContent = oneAway ? "So close — one away!" : "Not a group — try again.";
  errLine.className = "err info";
  shakeSelectedTiles(selArr);
  renderMistakes();
  updateStats();
  if (!infiniteMistakes && mistakes >= MAX_MISTAKES) finishRound(false, true);
}
submitBtn.addEventListener("click", () => submitGroup());

/* ---------- hints ---------- */
function pickHintTargetIdx() {
  for (let i = 0; i < puzzle.length; i++) {
    if (!solvedGroupIdxs.includes(i)) return i;
  }
  return null;
}

function renderHintUI() {
  hintRow.style.display = "flex";
  hintBtn.disabled = hintLevel >= 3 || roundOver || solvedGroupIdxs.length === NUM_GROUPS;
  hintBtn.textContent = hintLevel >= 3 ? "No more hints" : `Hint (${hintLevel + 1}/3)`;
  hintText.textContent = hintTextValue;
}

// Always targets the hardest remaining unsolved group — that's the one
// players actually get stuck on. Levels build on the same target so they
// stay coherent, and re-target automatically once that group is solved.
hintBtn.addEventListener("click", () => {
  if (hintBtn.disabled || roundOver) return;
  if (hintTargetGroupIdx == null || solvedGroupIdxs.includes(hintTargetGroupIdx)) {
    hintTargetGroupIdx = pickHintTargetIdx();
    hintLevel = 0;
    hintTextValue = "";
  }
  if (hintTargetGroupIdx == null) return;
  const g = puzzle[hintTargetGroupIdx];
  const level = hintLevel + 1;
  hintLevel = level;

  if (level === 1) {
    hintTextValue = `One unsolved group's category: ${GROUP_TYPE_LABELS[g.category.group] || g.category.group}.`;
  } else if (level === 2) {
    const pick = g.champions[Math.floor(Math.random() * g.champions.length)];
    hintTextValue = `${hintTextValue} ${pick.name} belongs to it.`;
  } else if (level === 3) {
    const others = g.champions.filter((c) => !hintTextValue.includes(c.name));
    const pick2 = others[Math.floor(Math.random() * others.length)] || g.champions[0];
    hintTextValue = `${hintTextValue} So does ${pick2.name}.`;
  }
  renderHintUI();
});

/* ---------- give up / round end ---------- */
giveUpBtn.addEventListener("click", () => {
  if (roundOver) return;
  const ok = window.confirm("Give up this round? The remaining groups will be revealed.");
  if (!ok) return;
  finishRound(true, false);
});

function finishRound(gaveUp, ranOutOfMistakes) {
  if (roundOver) return;
  roundOver = true;
  stopTimer();
  selectedIds.clear();
  submitBtn.disabled = true;
  hintRow.style.display = "none";
  errLine.textContent = "";
  errLine.className = "err";
  giveUpBtn.disabled = true;
  setSettingsLocked(false);

  lastSolvedCount = solvedGroupIdxs.length; // genuinely found, before revealing the rest
  for (let i = 0; i < puzzle.length; i++) {
    if (!solvedGroupIdxs.includes(i)) solvedGroupIdxs.push(i);
  }
  guessHint.textContent = "Round complete.";
  renderBoard();

  const perfect = !gaveUp && !ranOutOfMistakes && mistakes === 0 && lastSolvedCount === NUM_GROUPS;
  statScore.textContent = `${lastSolvedCount}/${NUM_GROUPS}`;
  finalScore.textContent = `${lastSolvedCount} / ${NUM_GROUPS}`;
  let line = ranOutOfMistakes
    ? "Out of mistakes — here are the remaining groups."
    : gaveUp
      ? "Round ended early — here are the remaining groups."
      : "All four groups found!";

  stats.gamesPlayed += 1;
  if (perfect) {
    stats.perfectSolves += 1;
    stats.currentStreak += 1;
    stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak);
  } else {
    stats.currentStreak = 0;
  }
  if (timedRound && perfect && !mp) {
    if (stats.bestTimeSeconds == null || timerElapsedSeconds < stats.bestTimeSeconds) {
      stats.bestTimeSeconds = timerElapsedSeconds;
      line += ` New best time: ${formatTime(timerElapsedSeconds)}!`;
    } else {
      line += ` Time: ${formatTime(timerElapsedSeconds)}.`;
    }
  }
  saveStats(stats);
  renderStatsStrip();
  statStreak.textContent = stats.currentStreak;
  statMistakes.textContent = mistakes;

  finalLine.textContent = line;
  resultBanner.classList.add("show");

  if (mp) reportMpResult(lastSolvedCount, gaveUp);
}

/* ---------- share result ---------- */
shareBtn.addEventListener("click", async () => {
  const rows = guessHistory.join("\n");
  const timeLine = timedRound ? `\nTime: ${formatTime(timerElapsedSeconds)}` : "";
  const text = `Runeterra Champion Connections — ${lastSolvedCount}/${NUM_GROUPS}${timeLine}\n${rows}`;
  try {
    await navigator.clipboard.writeText(text);
    copyToast.textContent = "Copied to clipboard!";
  } catch {
    copyToast.textContent = text;
  }
  setTimeout(() => {
    if (copyToast.textContent === "Copied to clipboard!") copyToast.textContent = "";
  }, 2500);
});

/* ================= multiplayer (1v1 Race) ================= */
// Same shape as Grid's Race mode: the host builds one puzzle and writes it
// (serialized to plain ids) into the room; both players solve it
// independently on their own board, and results are compared once both are
// in. The room owner's mistake-limit setting applies to both players, and
// every 1v1 round is timed — there's no toggle for either in multiplayer.

function setMpStatus(text, live) {
  mpStatus.textContent = text;
  mpStatus.classList.toggle("live", !!live);
}

function updateSettingsUiForMp() {
  timerToggleLabel.style.display = mp ? "none" : "";
  settingsNote.textContent = mp
    ? "1v1 rounds are always timed for a fair comparison. The room owner's mistake-limit setting applies to both players."
    : DEFAULT_SETTINGS_NOTE;
}

async function startMpRound(groupsSpec, hostInfiniteMistakes) {
  const p = puzzleFromSpec(groupsSpec);
  newPuzzleBtn.disabled = true;
  timerToggle.checked = true; // 1v1 is always timed
  timerToggle.disabled = true;
  infiniteToggle.checked = !!hostInfiniteMistakes; // set by the room owner, applied to both players
  infiniteToggle.disabled = true;
  newGame(p);
}

function onMpUpdate(role, data) {
  mp.lastData = data;
  const bothPresent = data.hostPresent && data.guestPresent;

  if (!bothPresent) {
    setMpStatus(role === "host" ? "Waiting for opponent to join…" : "Waiting for round to start…");
    return;
  }

  const key = puzzleKeyFor(data.state.groups);
  if (key !== mp.currentPuzzleKey) {
    mp.currentPuzzleKey = key;
    mp.resultSent = false;
    setMpStatus("Both players in — go!", true);
    startMpRound(data.state.groups, data.state.infiniteMistakes);
    return;
  }

  const results = data.state.results || {};
  const mine = results[role];
  const theirRole = role === "host" ? "guest" : "host";
  const theirs = results[theirRole];

  if (roundOver && mine && theirs) {
    showRaceComparison(mine, theirs);
  } else if (roundOver && mine && !theirs) {
    mpResultLine.style.display = "block";
    mpResultLine.classList.remove("mp-win", "mp-lose", "mp-tie");
    mpResultLine.textContent = "Waiting for your opponent to finish…";
  }
}

async function reportMpResult(solvedCount, gaveUp) {
  if (!mp || mp.resultSent) return;
  mp.resultSent = true;
  const result = { solved: solvedCount, mistakes, timeSeconds: timerElapsedSeconds, gaveUp };
  const existingResults = (mp.lastData && mp.lastData.state && mp.lastData.state.results) || {};
  await updateRoomState(mp.code, { results: { ...existingResults, [mp.role]: result } });
}

function showRaceComparison(mine, theirs) {
  const iWon = mine.solved > theirs.solved || (mine.solved === theirs.solved && mine.timeSeconds < theirs.timeSeconds);
  const tied = mine.solved === theirs.solved && mine.timeSeconds === theirs.timeSeconds;
  const verdict = tied ? "tie" : iWon ? "win" : "lose";
  const headline = tied ? "It's a tie! 🤝" : iWon ? "You win this round! 🏆" : "Your opponent wins this round. 😔";
  mpResultLine.style.display = "block";
  mpResultLine.classList.remove("mp-win", "mp-lose", "mp-tie");
  mpResultLine.classList.add(`mp-${verdict}`);
  mpResultLine.textContent = `${headline} You: ${mine.solved}/${NUM_GROUPS} (${formatTime(mine.timeSeconds)}) — Opponent: ${theirs.solved}/${NUM_GROUPS} (${formatTime(theirs.timeSeconds)})`;
}

mpCreateBtn.addEventListener("click", async () => {
  mpCreateBtn.disabled = true;
  setMpStatus("Creating room…");
  try {
    const p = newLocalPuzzle();
    if (!p) throw new Error("Could not build a puzzle — try again.");
    const hostInfiniteMistakes = infiniteToggle.checked;
    const initialState = { groups: specFromPuzzle(p), results: {}, infiniteMistakes: hostInfiniteMistakes };
    const { code, role } = await createRoom("connections", initialState);
    await enterMpRoom(code, role);
  } catch (err) {
    setMpStatus(err.message || "Couldn't create a room. Check your Firebase config.");
  } finally {
    mpCreateBtn.disabled = false;
  }
});

mpJoinBtn.addEventListener("click", async () => {
  const code = mpCodeInput.value.trim();
  if (!code) return;
  mpJoinBtn.disabled = true;
  setMpStatus("Joining room…");
  try {
    const { role } = await joinRoom(code);
    await enterMpRoom(code, role);
  } catch (err) {
    setMpStatus(err.message || "Couldn't join that room.");
  } finally {
    mpJoinBtn.disabled = false;
  }
});

async function enterMpRoom(code, role) {
  mpLobbyRow.style.display = "none";
  mpCodeDisplay.style.display = "block";
  mpCodeDisplay.textContent = code;
  mpIntro.textContent = role === "host"
    ? "Share this code with your opponent. The round starts once they join."
    : "You're in! Waiting for the round to start...";

  mp = { code, role, unsubscribe: null, resultSent: false, lastData: null, currentPuzzleKey: null };
  updateSettingsUiForMp();
  mp.unsubscribe = await subscribeToRoom(code, (data) => onMpUpdate(role, data));
}

/* ---------- boot ---------- */
newPuzzleBtn.addEventListener("click", () => newGame());
document.getElementById("play-again-btn").addEventListener("click", () => {
  mpResultLine.style.display = "none";
  mpResultLine.classList.remove("mp-win", "mp-lose", "mp-tie");
  if (mp) {
    if (mp.role === "host") {
      const p = newLocalPuzzle();
      updateRoomState(mp.code, { groups: specFromPuzzle(p), results: {} });
    } else {
      setMpStatus("Waiting for host to start the next round…");
    }
  } else {
    newGame();
  }
});

newGame();
