import { CHAMPIONS } from "../shared/champions-data.js";
import { buildCategories, generateGrid, intersectionAnswers } from "../shared/attributes.js";
import { attachAutocomplete } from "../shared/autocomplete.js";
import { createStatsStore, formatTime } from "../shared/stats.js";
import { createRoom, joinRoom, subscribeToRoom, updateRoomState, updateRoomFields } from "../shared/multiplayer.js";

/* ---------- stats ---------- */
const { load: loadStats, save: saveStats } = createStatsStore("runeterra-grid-stats", {
  gamesPlayed: 0, perfectGrids: 0, currentStreak: 0, bestStreak: 0, bestTimeSeconds: null,
});
let stats = loadStats();

function renderStatsStrip() {
  const bestTime = stats.bestTimeSeconds != null ? formatTime(stats.bestTimeSeconds) : "—";
  statsStripEl.innerHTML =
    `<span><b>${stats.gamesPlayed}</b> played</span>` +
    `<span><b>${stats.perfectGrids}</b> perfect</span>` +
    `<span>Best streak <b>${stats.bestStreak}</b></span>` +
    `<span>Best time <b>${bestTime}</b></span>`;
}

/* ---------- game state ---------- */
let grid = null;
let cellState = [];
let cellAnswer = [];
let cellAttempts = [];
let cellHintLevel = [];
let cellHintText = [];
let usedChampionIds = new Set();
let selected = null;
let roundOver = true;
let infiniteGuesses = false;
let timedRound = false;
let settingsLocked = false;
const TOTAL_CELLS = 9;

let timerInterval = null;
let timerStartMs = null;
let timerElapsedSeconds = 0;

const ALL_CATEGORIES = buildCategories(CHAMPIONS);
const CATEGORY_BY_ID = new Map(ALL_CATEGORIES.map((c) => [c.id, c]));

/* ---------- multiplayer state ---------- */
let mp = null; // { code, role, unsubscribe }

const boardEl = document.getElementById("board");
const guessInput = document.getElementById("guess-input");
const suggestionsEl = document.getElementById("suggestions");
const guessHint = document.getElementById("guess-hint");
const errLine = document.getElementById("err-line");
const statScore = document.getElementById("stat-score");
const statLeft = document.getElementById("stat-left");
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
const timerToggle = document.getElementById("timer-toggle");
const timerToggleLabel = document.getElementById("timer-toggle-label");
const timerRow = document.getElementById("timer-row");
const timerPill = document.getElementById("timer-pill");
const statsStripEl = document.getElementById("stats-strip");
const newGridBtn = document.getElementById("new-grid-btn");

const mpCreateBtn = document.getElementById("mp-create-btn");
const mpJoinBtn = document.getElementById("mp-join-btn");
const mpCodeInput = document.getElementById("mp-code-input");
const mpLobbyRow = document.getElementById("mp-lobby-row");
const mpCodeDisplay = document.getElementById("mp-code-display");
const mpStatus = document.getElementById("mp-status");
const mpIntro = document.getElementById("mp-intro");

/* ---------- building/rebuilding a grid from category ids (deterministic across clients) ---------- */
function gridFromCategoryIds(rowIds, colIds) {
  const rows = rowIds.map((id) => CATEGORY_BY_ID.get(id));
  const cols = colIds.map((id) => CATEGORY_BY_ID.get(id));
  const cells = rows.map((r) => cols.map((c) => intersectionAnswers(r, c, CHAMPIONS)));
  return { rows, cols, cells };
}

function newLocalGrid() {
  return generateGrid(CHAMPIONS, ALL_CATEGORIES, { minAnswers: 2, maxAnswers: 15, maxTries: 5000 });
}

/* ---------- round lifecycle ---------- */
function newGame(forcedGrid) {
  const g = forcedGrid || newLocalGrid();
  if (!g) {
    boardEl.innerHTML = '<p style="color:var(--blood-red);grid-column:1/-1;">Could not build a grid — try again.</p>';
    return;
  }
  grid = g;

  infiniteGuesses = infiniteToggle.checked;
  timedRound = mp ? true : timerToggle.checked; // 1v1 rounds are always timed, for a fair comparison

  cellState = Array(9).fill("unanswered");
  cellAnswer = Array(9).fill(null);
  cellAttempts = Array(9).fill(0);
  cellHintLevel = Array(9).fill(0);
  cellHintText = Array(9).fill(null);
  usedChampionIds = new Set();
  selected = null;
  roundOver = false;
  guessInput.value = "";
  guessInput.disabled = true;
  errLine.textContent = "";
  errLine.className = "err";
  guessHint.innerHTML = "Select a cell above to start guessing.";
  hintRow.style.display = "none";
  giveUpBtn.disabled = false;
  resultBanner.classList.remove("show");
  copyToast.textContent = "";

  settingsLocked = false;
  setSettingsLocked(false);

  stopTimer();
  timerElapsedSeconds = 0;
  timerRow.style.display = timedRound ? "flex" : "none";
  updateTimerDisplay();
  if (mp) startTimer(); // 1v1: clock starts the moment the round is live for both

  renderBoard();
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
  if (timedRound && !mp) startTimer(); // mp already started its own timer at round start
  timerRow.style.display = timedRound ? "flex" : "none";
}

infiniteToggle.addEventListener("change", () => {
  infiniteGuesses = infiniteToggle.checked;
  if (infiniteGuesses && !roundOver) {
    let revived = false;
    cellState.forEach((s, idx) => {
      if (s === "wrong") {
        cellState[idx] = "unanswered";
        cellAnswer[idx] = null;
        revived = true;
      }
    });
    if (revived) {
      renderBoard();
      updateStats();
    }
  }
});

/* ---------- timer ---------- */
function updateTimerDisplay() {
  timerPill.textContent = formatTime(timerElapsedSeconds);
}
function startTimer() {
  if (timerInterval) return;
  timerStartMs = Date.now() - timerElapsedSeconds * 1000;
  timerInterval = setInterval(() => {
    timerElapsedSeconds = Math.floor((Date.now() - timerStartMs) / 1000);
    updateTimerDisplay();
  }, 250);
}
function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

/* ---------- board rendering ---------- */
function renderBoard() {
  boardEl.innerHTML = "";
  boardEl.appendChild(makeHeadCell("", true));
  grid.cols.forEach((c) => boardEl.appendChild(makeHeadCell(c.label)));
  grid.rows.forEach((rowCat, r) => {
    boardEl.appendChild(makeHeadCell(rowCat.label));
    grid.cols.forEach((colCat, c) => boardEl.appendChild(makeCell(r, c)));
  });
}

function makeHeadCell(text, corner) {
  const d = document.createElement("div");
  d.className = "headcell" + (corner ? " corner" : "");
  d.textContent = corner ? "x" : text;
  return d;
}

function cellSolutionsLeft(r, c) {
  return grid.cells[r][c].filter((champ) => !usedChampionIds.has(champ.id)).length;
}

function makeCell(r, c) {
  const idx = r * 3 + c;
  const d = document.createElement("div");
  d.className = "cell";
  d.dataset.idx = idx;

  const state = cellState[idx];
  if (state === "correct") {
    d.classList.add("correct");
    appendChampFace(d, cellAnswer[idx]);
  } else if (state === "wrong") {
    d.classList.add("wrong");
    d.innerHTML = '<span class="xmark">&times;</span>';
  } else if (state === "revealed") {
    d.classList.add("revealed");
    appendChampFace(d, cellAnswer[idx]);
    const tag = document.createElement("div");
    tag.className = "missed-tag";
    tag.textContent = "Missed";
    d.appendChild(tag);
  } else {
    d.innerHTML = '<span class="placeholder">?</span>';
    if (selected && selected.r === r && selected.c === c) d.classList.add("active");
    if (cellAttempts[idx] > 0) {
      const badge = document.createElement("div");
      badge.className = "attempt-badge";
      badge.textContent = "×" + cellAttempts[idx];
      d.appendChild(badge);
    }
    if (cellSolutionsLeft(r, c) === 0) {
      d.classList.add("dead");
      const deadTag = document.createElement("div");
      deadTag.className = "dead-tag";
      deadTag.textContent = "No matches left";
      d.appendChild(deadTag);
    }
    d.addEventListener("click", () => selectCell(r, c));
  }
  return d;
}

function appendChampFace(container, champ) {
  const fill = document.createElement("div");
  fill.className = "fill";
  fill.style.backgroundImage = `url('${champ.splashUrl}')`;
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const name = document.createElement("div");
  name.className = "champname";
  name.textContent = champ.name;
  container.appendChild(fill);
  container.appendChild(scrim);
  container.appendChild(name);
}

function selectCell(r, c) {
  if (roundOver) return;
  const idx = r * 3 + c;
  if (cellState[idx] !== "unanswered") return;
  selected = { r, c };
  renderBoard();
  guessInput.disabled = false;
  guessInput.value = "";
  guessInput.focus();
  errLine.textContent = "";
  errLine.className = "err";
  guessHint.innerHTML = `Guessing for <b>${grid.rows[r].label}</b> &times; <b>${grid.cols[c].label}</b>`;
  autocomplete.close();
  renderHintUI(idx);
}

function updateStats() {
  const solved = cellState.filter((s) => s === "correct").length;
  const remaining = infiniteGuesses ? TOTAL_CELLS - solved : cellState.filter((s) => s === "unanswered").length;
  statScore.textContent = `${solved}/${TOTAL_CELLS}`;
  statLeft.textContent = remaining;
  statStreak.textContent = stats.currentStreak;

  if (roundOver) return;
  const everyCellDone = infiniteGuesses ? solved === TOTAL_CELLS : cellState.every((s) => s !== "unanswered");
  if (everyCellDone) finishRound(false);
}

/* ---------- autocomplete ---------- */
const autocomplete = attachAutocomplete({
  inputEl: guessInput,
  suggestionsEl,
  champions: CHAMPIONS,
  isExcluded: (c) => usedChampionIds.has(c.id),
  onSelect: (champ) => submitGuess(champ),
  onNoMatch: () => {
    errLine.textContent = "Enter a valid, unused champion name.";
    errLine.className = "err";
  },
});

/* ---------- guess resolution ---------- */
function mismatchMessage(rowCat, colCat, champ, failRow, failCol) {
  if (failRow && failCol) return `${champ.name} doesn't fit "${rowCat.label}" or "${colCat.label}".`;
  if (failRow) return `${champ.name} doesn't fit "${rowCat.label}".`;
  return `${champ.name} doesn't fit "${colCat.label}".`;
}

function submitGuess(champ) {
  if (!selected || roundOver) return;
  lockSettingsForRound();

  const { r, c } = selected;
  const idx = r * 3 + c;
  if (cellState[idx] !== "unanswered") return;

  const rowCat = grid.rows[r];
  const colCat = grid.cols[c];
  const failRow = !rowCat.matches(champ);
  const failCol = !colCat.matches(champ);
  const isCorrect = !failRow && !failCol;

  guessInput.value = "";

  if (isCorrect) {
    usedChampionIds.add(champ.id);
    cellState[idx] = "correct";
    cellAnswer[idx] = champ;
    selected = null;
    guessInput.disabled = true;
    errLine.textContent = "";
    errLine.className = "err";
    guessHint.innerHTML = "Select a cell above to start guessing.";
    hintRow.style.display = "none";
    renderBoard();
    updateStats();
    return;
  }

  cellAttempts[idx]++;
  const msg = mismatchMessage(rowCat, colCat, champ, failRow, failCol);

  if (infiniteGuesses) {
    errLine.textContent = msg;
    errLine.className = "err info";
    renderBoard();
    guessInput.disabled = false;
    guessInput.focus();
  } else {
    cellState[idx] = "wrong";
    cellAnswer[idx] = champ;
    selected = null;
    guessInput.disabled = true;
    errLine.textContent = msg;
    errLine.className = "err info";
    guessHint.innerHTML = "Select a cell above to start guessing.";
    hintRow.style.display = "none";
    renderBoard();
  }
  updateStats();
}

/* ---------- hints ---------- */
function renderHintUI(idx) {
  hintRow.style.display = "flex";
  const level = cellHintLevel[idx];
  hintBtn.disabled = level >= 2;
  hintBtn.textContent = level >= 2 ? "No more hints" : `Hint (${level + 1}/2)`;
  hintText.textContent = cellHintText[idx] || "";
}

hintBtn.addEventListener("click", () => {
  if (hintBtn.disabled || !selected || roundOver) return;
  const { r, c } = selected;
  const idx = r * 3 + c;
  if (cellState[idx] !== "unanswered") return;

  const unusedAnswers = grid.cells[r][c].filter((a) => !usedChampionIds.has(a.id));
  const level = cellHintLevel[idx] + 1;
  cellHintLevel[idx] = level;

  if (level === 1) {
    cellHintText[idx] = unusedAnswers.length === 0
      ? "Every champion that fit here has already been used elsewhere!"
      : `${unusedAnswers.length} unused champion${unusedAnswers.length === 1 ? "" : "s"} fit both.`;
  } else if (level === 2) {
    if (unusedAnswers.length === 0) {
      cellHintText[idx] += " No pick left to reveal.";
    } else {
      const pick = unusedAnswers[Math.floor(Math.random() * unusedAnswers.length)];
      cellHintText[idx] = `${cellHintText[idx]} One option starts with "${pick.name[0]}" and has ${pick.name.replace(/[^A-Za-z]/g, "").length} letters.`;
    }
  }
  renderHintUI(idx);
});

/* ---------- give up / round end ---------- */
giveUpBtn.addEventListener("click", () => {
  if (roundOver) return;
  const ok = window.confirm("Give up this round? The grid will be revealed.");
  if (!ok) return;
  finishRound(true);
});

function finishRound(gaveUp) {
  if (roundOver) return;
  roundOver = true;
  stopTimer();
  selected = null;
  guessInput.disabled = true;
  guessInput.value = "";
  autocomplete.close();
  hintRow.style.display = "none";
  guessHint.innerHTML = "Round complete.";
  errLine.textContent = "";
  errLine.className = "err";
  giveUpBtn.disabled = true;
  setSettingsLocked(false);

  const reserved = new Set(usedChampionIds);
  for (let idx = 0; idx < TOTAL_CELLS; idx++) {
    if (cellState[idx] === "correct") continue;
    const r = Math.floor(idx / 3);
    const c = idx % 3;
    const answers = grid.cells[r][c];
    let pick = answers.find((a) => !reserved.has(a.id));
    if (!pick) pick = answers[0];
    reserved.add(pick.id);
    cellState[idx] = "revealed";
    cellAnswer[idx] = pick;
  }
  renderBoard();

  const solved = cellState.filter((s) => s === "correct").length;
  const perfect = !gaveUp && solved === TOTAL_CELLS;

  statScore.textContent = `${solved}/${TOTAL_CELLS}`;
  statLeft.textContent = 0;
  finalScore.textContent = `${solved} / ${TOTAL_CELLS}`;
  let line = gaveUp ? "Round ended early — here's the full solved grid." : "Champions guessed correctly this round.";

  stats.gamesPlayed += 1;
  if (perfect) {
    stats.perfectGrids += 1;
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

  finalLine.textContent = line;
  resultBanner.classList.add("show");

  if (mp) reportMpResult(solved, gaveUp);
}

/* ---------- share result ---------- */
shareBtn.addEventListener("click", async () => {
  const solved = cellState.filter((s) => s === "correct").length;
  const rowsText = [0, 1, 2]
    .map((r) => [0, 1, 2].map((c) => {
      const s = cellState[r * 3 + c];
      return s === "correct" ? "🟩" : s === "wrong" ? "🟥" : "⬛";
    }).join(""))
    .join("\n");
  const timeLine = timedRound ? `\nTime: ${formatTime(timerElapsedSeconds)}` : "";
  const text = `Runeterra Champion Grid — ${solved}/${TOTAL_CELLS}${timeLine}\n${rowsText}`;
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

/* ================= multiplayer (1v1 race) ================= */
// Design: host generates one grid, both players race it independently on
// their own board (no shared cell locking — that avoids write races). When
// a player finishes, their score+time is written to the room; once both are
// in, the banner shows a head-to-head result.

function setMpStatus(text, live) {
  mpStatus.textContent = text;
  mpStatus.classList.toggle("live", !!live);
}

async function startMpRound(rowIds, colIds) {
  const g = gridFromCategoryIds(rowIds, colIds);
  newGridBtn.disabled = true;
  timerToggle.disabled = true;
  infiniteToggle.checked = false; // 1v1 keeps single-guess-per-cell for a fair race
  infiniteToggle.disabled = true;
  newGame(g);
}

mpCreateBtn.addEventListener("click", async () => {
  mpCreateBtn.disabled = true;
  setMpStatus("Creating room…");
  try {
    const g = newLocalGrid();
    if (!g) throw new Error("Could not build a grid, try again.");
    const rowIds = g.rows.map((c) => c.id);
    const colIds = g.cols.map((c) => c.id);
    const { code, role } = await createRoom("grid", { rowIds, colIds, results: {} });
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

  mp = { code, role, unsubscribe: null, roundStarted: false, resultSent: false, lastData: null };
  mp.unsubscribe = await subscribeToRoom(code, (data) => onMpUpdate(role, code, data));
}

function onMpUpdate(role, code, data) {
  mp.lastData = data;
  const bothPresent = data.hostPresent && data.guestPresent;

  if (bothPresent && !mp.roundStarted) {
    mp.roundStarted = true;
    setMpStatus("Both players in — go!", true);
    startMpRound(data.state.rowIds, data.state.colIds);
  } else if (!bothPresent) {
    setMpStatus(role === "host" ? "Waiting for opponent to join…" : "Waiting for round to start…");
  }

  const results = data.state.results || {};
  const mine = results[role];
  const theirRole = role === "host" ? "guest" : "host";
  const theirs = results[theirRole];

  if (roundOver && mine && theirs) {
    showMpComparison(mine, theirs);
  } else if (roundOver && mine && !theirs) {
    mpResultLine.style.display = "block";
    mpResultLine.textContent = "Waiting for your opponent to finish…";
  }
}

async function reportMpResult(solved, gaveUp) {
  if (!mp || mp.resultSent) return;
  mp.resultSent = true;
  const result = { solved, timeSeconds: timerElapsedSeconds, gaveUp };
  // Merge against the last known results so a fast opponent's result written
  // moments earlier isn't clobbered by this write (updateRoomState replaces
  // the whole `results` key, it doesn't deep-merge it).
  const existingResults = (mp.lastData && mp.lastData.state && mp.lastData.state.results) || {};
  await updateRoomState(mp.code, { results: { ...existingResults, [mp.role]: result } });
}

function showMpComparison(mine, theirs) {
  mpResultLine.style.display = "block";
  const iWon = mine.solved > theirs.solved || (mine.solved === theirs.solved && mine.timeSeconds < theirs.timeSeconds);
  const tied = mine.solved === theirs.solved && mine.timeSeconds === theirs.timeSeconds;
  const verdict = tied ? "It's a tie!" : iWon ? "You win this round! 🏆" : "Your opponent wins this round.";
  mpResultLine.textContent = `${verdict} You: ${mine.solved}/9 (${formatTime(mine.timeSeconds)}) — Opponent: ${theirs.solved}/9 (${formatTime(theirs.timeSeconds)})`;
}

/* ---------- boot ---------- */
newGridBtn.addEventListener("click", () => newGame());
document.getElementById("play-again-btn").addEventListener("click", () => {
  mpResultLine.style.display = "none";
  if (mp) {
    // Rematch in the same room: host rolls a fresh grid and writes it; both re-sync.
    if (mp.role === "host") {
      const g = newLocalGrid();
      const rowIds = g.rows.map((c) => c.id);
      const colIds = g.cols.map((c) => c.id);
      mp.resultSent = false;
      updateRoomState(mp.code, { rowIds, colIds, results: {} }).then(() => startMpRound(rowIds, colIds));
    } else {
      setMpStatus("Waiting for host to start the next round…");
    }
  } else {
    newGame();
  }
});

newGame();
