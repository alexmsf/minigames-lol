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
let cellHintPick = [];
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
const CHAMP_BY_ID = new Map(CHAMPIONS.map((c) => [c.id, c]));

/* ---------- fun flavor-fact hint (level 2) ---------- */
/* There's no "description" field in the champion data, so the fun hint is
   built out of the structured fields instead — picking a fact whose
   category isn't already given away by the row/column, so it adds
   something new rather than restating the puzzle. */
function championFlavorFacts(champ) {
  const facts = [];
  if (champ.regions && champ.regions.length) {
    facts.push({ group: "region", text: `They call ${champ.regions[0]} home.` });
  }
  if (champ.positions && champ.positions.length) {
    facts.push({ group: "position", text: `You'll usually find them in the ${champ.positions[0]} lane.` });
  }
  if (champ.rangeType && champ.rangeType.length) {
    facts.push({
      group: "rangeType",
      text: champ.rangeType.includes("Melee")
        ? "They like to get up close and personal."
        : "They prefer to keep their distance.",
    });
  }
  if (champ.resource) {
    facts.push({
      group: "resource",
      text: champ.resource === "Manaless"
        ? "They don't need mana to use their skills."
        : `Their abilities run on ${champ.resource.toLowerCase()}.`,
    });
  }
  if (champ.gender) {
    facts.push({ group: "gender", text: `They go by ${champ.gender === "Male" ? "he/him" : champ.gender === "Female" ? "she/her" : champ.gender}.` });
  }
  if (champ.releaseDate) {
    facts.push({ group: "year", text: `They've been on the Rift since ${champ.releaseDate.slice(0, 4)}.` });
  }
  if (champ.species && champ.species.length) {
    facts.push({ group: "species", text: `Their kind: ${champ.species[0]}.` });
  }
  return facts;
}

function buildFlavorHint(champ, rowCat, colCat) {
  const excludeGroups = new Set([rowCat.group, colCat.group]);
  const facts = championFlavorFacts(champ).filter((f) => !excludeGroups.has(f.group));
  if (facts.length === 0) return "No extra trivia to give away on this one!";
  return facts[Math.floor(Math.random() * facts.length)].text;
}

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
const infiniteToggleLabel = document.getElementById("infinite-toggle-label");
const timerToggle = document.getElementById("timer-toggle");
const timerToggleLabel = document.getElementById("timer-toggle-label");
const timerRow = document.getElementById("timer-row");
const timerPill = document.getElementById("timer-pill");
const settingsNote = document.getElementById("settings-note");
const turnTimerRow = document.getElementById("turn-timer-row");
const turnTimerPill = document.getElementById("turn-timer-pill");
const DEFAULT_SETTINGS_NOTE = settingsNote.textContent;
const TURN_SECONDS = 30;
const statsStripEl = document.getElementById("stats-strip");
const newGridBtn = document.getElementById("new-grid-btn");

const mpCreateBtn = document.getElementById("mp-create-btn");
const mpJoinBtn = document.getElementById("mp-join-btn");
const mpCodeInput = document.getElementById("mp-code-input");
const mpLobbyRow = document.getElementById("mp-lobby-row");
const mpCodeDisplay = document.getElementById("mp-code-display");
const mpStatus = document.getElementById("mp-status");
const mpIntro = document.getElementById("mp-intro");
const mpModeRow = document.getElementById("mp-mode-row");
const mpModeRaceBtn = document.getElementById("mp-mode-race");
const mpModeTurnsBtn = document.getElementById("mp-mode-turns");
const coinFlipEl = document.getElementById("coin-flip");
const mpTurnRow = document.getElementById("mp-turn-row");
const mpTagHost = document.getElementById("mp-tag-host");
const mpTagGuest = document.getElementById("mp-tag-guest");
const mpScoreRow = document.getElementById("mp-score-row");
const mpScoreHost = document.getElementById("mp-score-host");
const mpScoreGuest = document.getElementById("mp-score-guest");
const passTurnBtn = document.getElementById("pass-turn-btn");

/* ---------- 1v1 mode selection (Race vs Turns), chosen before a room exists ---------- */
let mpMode = "race";
mpModeRaceBtn.addEventListener("click", () => setMpMode("race"));
mpModeTurnsBtn.addEventListener("click", () => setMpMode("turns"));
function setMpMode(mode) {
  if (mp) return; // locked once a room exists
  mpMode = mode;
  mpModeRaceBtn.classList.toggle("active", mode === "race");
  mpModeTurnsBtn.classList.toggle("active", mode === "turns");
  mpIntro.textContent = mode === "race"
    ? "Same grid, same time — whoever solves it best wins. Create a room and share the code, or join one."
    : "One shared grid — take turns picking a cell and naming a champion. A coin flip decides who goes first. One guess per turn: a wrong answer ends it, and you've got 30 seconds before it passes automatically.";
  updateSettingsUiForMode();
}

/* Whoever creates the room is the sole owner of round settings — infinite
   guesses (race only) and the timer — and those settings are written into
   the room itself so both players play under the exact same rules. Timed
   is always on in 1v1, so that toggle is hidden entirely once you're
   playing multiplayer; infinite guesses is meaningless in Turns mode since
   any guess (right or wrong) always ends your turn, so it's hidden there
   too. */
function updateSettingsUiForMode() {
  const inMp = !!mp;
  const turnsMode = mpMode === "turns";

  timerToggleLabel.style.display = inMp ? "none" : "";
  infiniteToggleLabel.style.display = turnsMode ? "none" : "";

  if (inMp) {
    settingsNote.textContent = mp.mode === "turns"
      ? "1v1 Turns is always timed. One guess per turn — get it wrong and it passes to your opponent, or wait too long (30s) and it passes automatically."
      : "1v1 Race is always timed for a fair comparison. The room owner's infinite-guesses setting applies to both players.";
  } else if (turnsMode) {
    settingsNote.textContent = "1v1 Turns is always timed, and every guess (right or wrong) ends your turn, so there's no infinite-guesses option here.";
  } else {
    settingsNote.textContent = DEFAULT_SETTINGS_NOTE;
  }
}

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
  cellHintPick = Array(9).fill(null);
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
  passTurnBtn.style.display = "none"; // only shown in 1v1 Turns mode
  mpScoreRow.style.display = "none";

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
  isExcluded: (c) => {
    if (mp && mp.mode === "turns" && mp.lastData) {
      const claimedIds = mp.lastData.state.cellChampId || [];
      return claimedIds.includes(c.id);
    }
    return usedChampionIds.has(c.id);
  },
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
  if (mp && mp.mode === "turns") { submitTurnGuess(champ); return; }
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
  hintBtn.disabled = level >= 3;
  hintBtn.textContent = level >= 3 ? "No more hints" : `Hint (${level + 1}/3)`;
  hintText.textContent = cellHintText[idx] || "";
}

// Three hint levels, escalating: (1) how many unused champions fit here at
// all, (2) a fun flavor fact about one of them, (3) that same champion's
// first letter + name length. Levels 2-3 lock onto the same random pick
// (stored in cellHintPick) so the two hints build on each other consistently
// instead of possibly pointing at two different champions.
hintBtn.addEventListener("click", () => {
  if (hintBtn.disabled || !selected || roundOver) return;
  const { r, c } = selected;
  const idx = r * 3 + c;
  if (cellState[idx] !== "unanswered") return;

  const rowCat = grid.rows[r];
  const colCat = grid.cols[c];
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
      const pick = cellHintPick[idx] || unusedAnswers[Math.floor(Math.random() * unusedAnswers.length)];
      cellHintPick[idx] = pick;
      cellHintText[idx] = `${cellHintText[idx]} ${buildFlavorHint(pick, rowCat, colCat)}`;
    }
  } else if (level === 3) {
    if (unusedAnswers.length === 0) {
      cellHintText[idx] += " No pick left to reveal.";
    } else {
      const pick = cellHintPick[idx] || unusedAnswers[Math.floor(Math.random() * unusedAnswers.length)];
      cellHintPick[idx] = pick;
      cellHintText[idx] = `${cellHintText[idx]} One option starts with "${pick.name[0]}" and has ${pick.name.replace(/[^A-Za-z]/g, "").length} letters.`;
    }
  }
  renderHintUI(idx);
});

/* ---------- give up / round end ---------- */
giveUpBtn.addEventListener("click", () => {
  if (mp && mp.mode === "turns") { giveUpTurns(); return; }
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
  let text;
  if (mp && mp.mode === "turns" && mp.lastData) {
    const state = mp.lastData.state;
    const cellOwner = state.cellOwner || Array(9).fill(null);
    const scores = state.scores || { host: 0, guest: 0 };
    const mine = scores[mp.role] || 0;
    const rowsText = [0, 1, 2]
      .map((r) => [0, 1, 2].map((c) => {
        const o = cellOwner[r * 3 + c];
        return o === mp.role ? "🟩" : o ? "🟨" : "⬛";
      }).join(""))
      .join("\n");
    text = `Runeterra Champion Grid (1v1 Turns) — You: ${mine}/9\n${rowsText}`;
  } else {
    const solved = cellState.filter((s) => s === "correct").length;
    const rowsText = [0, 1, 2]
      .map((r) => [0, 1, 2].map((c) => {
        const s = cellState[r * 3 + c];
        return s === "correct" ? "🟩" : s === "wrong" ? "🟥" : "⬛";
      }).join(""))
      .join("\n");
    const timeLine = timedRound ? `\nTime: ${formatTime(timerElapsedSeconds)}` : "";
    text = `Runeterra Champion Grid — ${solved}/${TOTAL_CELLS}${timeLine}\n${rowsText}`;
  }
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

/* ================= multiplayer ================= */
// Two 1v1 modes, chosen before creating/joining a room:
//  - "race": host generates one grid, both players race it independently on
//    their own board (no shared cell locking). When a player finishes,
//    their score+time is written to the room; once both are in, the banner
//    shows a head-to-head result.
//  - "turns": one shared board. Players alternate turns; a coin flip
//    (decided by the host at room creation) picks who goes first. Always
//    timed, infinite guesses on your own turn. Round ends when all 9 cells
//    are claimed or someone gives up; whoever claimed more cells wins.

function setMpStatus(text, live) {
  mpStatus.textContent = text;
  mpStatus.classList.toggle("live", !!live);
}

function setMpResultVerdict(text, verdict) {
  // verdict: "win" | "lose" | "tie" — drives the color-coded banner so it's
  // unmistakable at a glance whether the round was won, lost, or tied.
  mpResultLine.style.display = "block";
  mpResultLine.classList.remove("mp-win", "mp-lose", "mp-tie");
  mpResultLine.classList.add(`mp-${verdict}`);
  mpResultLine.textContent = text;
}

/* ---------- Race mode ---------- */

async function startMpRound(rowIds, colIds, hostInfiniteGuesses) {
  const g = gridFromCategoryIds(rowIds, colIds);
  newGridBtn.disabled = true;
  timerToggle.checked = true; // 1v1 is always timed
  timerToggle.disabled = true;
  infiniteToggle.checked = !!hostInfiniteGuesses; // set by the room owner, applied to both players
  infiniteToggle.disabled = true;
  updateSettingsUiForMode();
  newGame(g);
}

function onRaceUpdate(role, data) {
  mp.lastData = data;
  const bothPresent = data.hostPresent && data.guestPresent;

  if (!bothPresent) {
    setMpStatus(role === "host" ? "Waiting for opponent to join…" : "Waiting for round to start…");
    return;
  }

  // Detect a (re)started round by the grid's identity rather than a
  // one-shot flag. A per-client "already started" flag only ever gets reset
  // by whichever client explicitly clears it — on a rematch that was just
  // the host, so the guest kept showing the previous round's grid and never
  // reported a result for the new one. Comparing the actual row/col ids
  // fixes it for both sides.
  const gridKey = (data.state.rowIds || []).join(",") + "|" + (data.state.colIds || []).join(",");
  if (gridKey !== mp.currentGridKey) {
    mp.currentGridKey = gridKey;
    mp.resultSent = false;
    setMpStatus("Both players in — go!", true);
    startMpRound(data.state.rowIds, data.state.colIds, data.state.infiniteGuesses);
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

async function reportMpResult(solved, gaveUp) {
  if (!mp || mp.mode !== "race" || mp.resultSent) return;
  mp.resultSent = true;
  const result = { solved, timeSeconds: timerElapsedSeconds, gaveUp };
  // Merge against the last known results so a fast opponent's result written
  // moments earlier isn't clobbered by this write (updateRoomState replaces
  // the whole `results` key, it doesn't deep-merge it).
  const existingResults = (mp.lastData && mp.lastData.state && mp.lastData.state.results) || {};
  await updateRoomState(mp.code, { results: { ...existingResults, [mp.role]: result } });
}

function showRaceComparison(mine, theirs) {
  const iWon = mine.solved > theirs.solved || (mine.solved === theirs.solved && mine.timeSeconds < theirs.timeSeconds);
  const tied = mine.solved === theirs.solved && mine.timeSeconds === theirs.timeSeconds;
  const verdict = tied ? "tie" : iWon ? "win" : "lose";
  const headline = tied ? "It's a tie! 🤝" : iWon ? "You win this round! 🏆" : "Your opponent wins this round. 😔";
  setMpResultVerdict(
    `${headline} You: ${mine.solved}/9 (${formatTime(mine.timeSeconds)}) — Opponent: ${theirs.solved}/9 (${formatTime(theirs.timeSeconds)})`,
    verdict
  );
}

/* ---------- Turns mode ---------- */

function initTurnRoundLocal(rowIds, colIds, data) {
  grid = gridFromCategoryIds(rowIds, colIds);
  roundOver = false;
  selected = null;

  cellHintLevel = Array(9).fill(0);
  cellHintText = Array(9).fill(null);
  cellHintPick = Array(9).fill(null);

  guessInput.value = "";
  errLine.textContent = "";
  errLine.className = "err";
  resultBanner.classList.remove("show");
  copyToast.textContent = "";
  giveUpBtn.disabled = false;
  passTurnBtn.style.display = "inline-block";

  timerToggle.checked = true; // 1v1 Turns is always timed
  timerToggle.disabled = true;
  infiniteToggle.disabled = true; // no infinite guesses in Turns — any guess ends your turn
  updateSettingsUiForMode();

  timerRow.style.display = "flex";
  timerElapsedSeconds = 0;
  updateTimerDisplay();
  startTimer();

  mpScoreRow.style.display = "flex";
  mpTurnRow.style.display = "block";

  mp.turnTimeoutHandled = false;
  startTurnTicker();

  renderTurnFromState(data);
}

function renderTurnFromState(fullData) {
  const state = fullData.state;
  const status = fullData.status; // "status" lives at the top level of the room doc, not under state
  const cellOwner = state.cellOwner || Array(9).fill(null);
  const cellChampId = state.cellChampId || Array(9).fill(null);
  const scores = state.scores || { host: 0, guest: 0 };
  const myTurn = state.turn === mp.role;

  mpScoreHost.textContent = scores.host || 0;
  mpScoreGuest.textContent = scores.guest || 0;
  mpTagHost.classList.toggle("turn", state.turn === "host" && status !== "finished");
  mpTagGuest.classList.toggle("turn", state.turn === "guest" && status !== "finished");

  boardEl.innerHTML = "";
  boardEl.appendChild(makeHeadCell("", true));
  grid.cols.forEach((c) => boardEl.appendChild(makeHeadCell(c.label)));
  grid.rows.forEach((rowCat, r) => {
    boardEl.appendChild(makeHeadCell(rowCat.label));
    grid.cols.forEach((colCat, c) => {
      const idx = r * 3 + c;
      const owner = cellOwner[idx];
      const d = document.createElement("div");
      d.className = "cell";
      d.dataset.idx = idx;

      if (owner) {
        const champ = CHAMP_BY_ID.get(cellChampId[idx]);
        d.classList.add("correct", `owned-${owner}`);
        appendChampFace(d, champ);
        const tag = document.createElement("div");
        tag.className = `owner-tag owned-${owner}`;
        tag.textContent = owner === mp.role ? "You" : "Opponent";
        d.appendChild(tag);
      } else {
        d.innerHTML = '<span class="placeholder">?</span>';
        if (selected && selected.r === r && selected.c === c) d.classList.add("active");
        if (myTurn && status !== "finished") {
          d.addEventListener("click", () => selectTurnCell(r, c));
        } else {
          d.style.cursor = "default";
        }
      }
      boardEl.appendChild(d);
    });
  });

  if (status === "finished") return; // finished handling done by onTurnsUpdate

  guessHint.innerHTML = myTurn
    ? (selected ? `Guessing for <b>${grid.rows[selected.r].label}</b> &times; <b>${grid.cols[selected.c].label}</b>` : "Your turn — pick an open cell above.")
    : "Waiting for your opponent's move…";
  guessInput.disabled = !myTurn || !selected;
  passTurnBtn.disabled = !myTurn;
}

function selectTurnCell(r, c) {
  if (roundOver) return;
  selected = { r, c };
  const idx = r * 3 + c;
  errLine.textContent = "";
  errLine.className = "err";
  hintRow.style.display = "flex";
  renderHintUI(idx);
  renderTurnFromState(mp.lastData);
  guessInput.disabled = false;
  guessInput.value = "";
  guessInput.focus();
}

async function submitTurnGuess(champ) {
  if (!mp || roundOver || !selected) return;
  const data = mp.lastData;
  const state = data.state;
  if (state.turn !== mp.role) return;

  const { r, c } = selected;
  const idx = r * 3 + c;
  const rowCat = grid.rows[r];
  const colCat = grid.cols[c];
  const failRow = !rowCat.matches(champ);
  const failCol = !colCat.matches(champ);
  guessInput.value = "";

  const nextTurn = mp.role === "host" ? "guest" : "host";

  if (failRow || failCol) {
    // One guess per turn — a wrong answer ends it and passes to the opponent.
    errLine.textContent = mismatchMessage(rowCat, colCat, champ, failRow, failCol) + " Turn passed.";
    errLine.className = "err info";
    selected = null;
    guessInput.disabled = true;
    hintRow.style.display = "none";
    await updateRoomState(mp.code, { turn: nextTurn, turnStartedAt: Date.now() });
    return;
  }

  const cellOwner = [...(state.cellOwner || Array(9).fill(null))];
  const cellChampId = [...(state.cellChampId || Array(9).fill(null))];
  const scores = { ...(state.scores || { host: 0, guest: 0 }) };
  cellOwner[idx] = mp.role;
  cellChampId[idx] = champ.id;
  scores[mp.role] = (scores[mp.role] || 0) + 1;

  const allClaimed = cellOwner.every((o) => o !== null);

  selected = null;
  guessInput.disabled = true;
  hintRow.style.display = "none";

  await updateRoomState(mp.code, { cellOwner, cellChampId, scores, turn: nextTurn, turnStartedAt: Date.now() });
  if (allClaimed) {
    stopTimer();
    stopTurnTicker();
    await updateRoomFields(mp.code, { status: "finished" });
  }
}

async function passTurnAction() {
  if (!mp || roundOver) return;
  const data = mp.lastData;
  if (!data || data.state.turn !== mp.role) return;
  const nextTurn = mp.role === "host" ? "guest" : "host";
  selected = null;
  guessInput.disabled = true;
  hintRow.style.display = "none";
  await updateRoomState(mp.code, { turn: nextTurn });
}
passTurnBtn.addEventListener("click", () => passTurnAction());

async function giveUpTurns() {
  const ok = window.confirm("Give up? Unclaimed cells stay unclaimed and the round ends now.");
  if (!ok) return;
  stopTimer();
  // "status" is a top-level room field (updateRoomFields); "gaveUpBy" lives
  // inside the nested state blob (updateRoomState) — these are two different
  // writes, not one.
  await updateRoomState(mp.code, { gaveUpBy: mp.role });
  await updateRoomFields(mp.code, { status: "finished" });
}

function onTurnsUpdate(role, data) {
  mp.lastData = data;
  const bothPresent = data.hostPresent && data.guestPresent;

  if (!bothPresent) {
    setMpStatus(role === "host" ? "Waiting for opponent to join…" : "Waiting for round to start…");
    return;
  }

  // Detect a (re)started round by the grid's identity rather than a
  // one-shot flag, so this branch also fires correctly for BOTH players on
  // a rematch (a per-client "already started" flag would only reset for
  // whichever client explicitly set it, leaving the other stuck showing the
  // previous round's grid).
  const gridKey = (data.state.rowIds || []).join(",") + "|" + (data.state.colIds || []).join(",");
  if (gridKey !== mp.currentGridKey) {
    mp.currentGridKey = gridKey;
    newGridBtn.disabled = true;
    timerToggle.disabled = true;
    infiniteToggle.checked = true; // turns mode: infinite guesses on your own turn, by default
    infiniteToggle.disabled = true;
    coinFlipEl.style.display = "block";
    const firstLabel = data.state.firstPlayer === role ? "You go" : "Your opponent goes";
    coinFlipEl.innerHTML = `<span class="coin">🪙</span> Coin flip: ${firstLabel} first!`;
    setMpStatus("Both players in — go!", true);
    if (role === "host") updateRoomState(mp.code, { turnStartedAt: Date.now() }); // real start-of-round clock, not the room-creation timestamp
    initTurnRoundLocal(data.state.rowIds, data.state.colIds, data);
    return;
  }

  if (data.status === "finished") {
    if (!roundOver) {
      roundOver = true;
      stopTimer();
      guessInput.disabled = true;
      giveUpBtn.disabled = true;
      passTurnBtn.disabled = true;
      hintRow.style.display = "none";
      renderTurnFromState(data);

      const scores = data.state.scores || { host: 0, guest: 0 };
      const mine = scores[role] || 0;
      const theirRole = role === "host" ? "guest" : "host";
      const theirs = scores[theirRole] || 0;
      const tied = mine === theirs;
      const iWon = mine > theirs;
      const verdict = tied ? "tie" : iWon ? "win" : "lose";
      const conceded = data.state.gaveUpBy ? (data.state.gaveUpBy === role ? " You gave up." : " Your opponent gave up.") : "";
      const headline = tied ? "It's a tie! 🤝" : iWon ? "You win this round! 🏆" : "Your opponent wins this round. 😔";

      finalScore.textContent = `${mine} / 9`;
      finalLine.textContent = "Cells you personally claimed this round.";
      setMpResultVerdict(`${headline} You: ${mine}/9 — Opponent: ${theirs}/9.${conceded}`, verdict);
      resultBanner.classList.add("show");
    }
    return;
  }

  renderTurnFromState(data);
}

/* ---------- shared room entry ---------- */

mpCreateBtn.addEventListener("click", async () => {
  mpCreateBtn.disabled = true;
  setMpStatus("Creating room…");
  try {
    const g = newLocalGrid();
    if (!g) throw new Error("Could not build a grid, try again.");
    const rowIds = g.rows.map((c) => c.id);
    const colIds = g.cols.map((c) => c.id);
    const initialState = mpMode === "turns"
      ? {
          rowIds, colIds,
          cellOwner: Array(9).fill(null),
          cellChampId: Array(9).fill(null),
          scores: { host: 0, guest: 0 },
          turn: Math.random() < 0.5 ? "host" : "guest",
          firstPlayer: null, // set right after, so `turn` and `firstPlayer` match
          gaveUpBy: null,
          turnStartedAt: Date.now(),
        }
      : { rowIds, colIds, results: {}, infiniteGuesses: infiniteToggle.checked };
    if (mpMode === "turns") initialState.firstPlayer = initialState.turn;
    const { code, role } = await createRoom("grid", initialState);
    await enterMpRoom(code, role, mpMode);
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
    const { role, data } = await joinRoom(code);
    const joinedMode = data.state && data.state.cellOwner ? "turns" : "race";
    await enterMpRoom(code, role, joinedMode);
  } catch (err) {
    setMpStatus(err.message || "Couldn't join that room.");
  } finally {
    mpJoinBtn.disabled = false;
  }
});

async function enterMpRoom(code, role, mode) {
  mpModeRow.style.display = "none";
  mpLobbyRow.style.display = "none";
  mpCodeDisplay.style.display = "block";
  mpCodeDisplay.textContent = code;
  mpIntro.textContent = role === "host"
    ? "Share this code with your opponent. The round starts once they join."
    : "You're in! Waiting for the round to start...";

  mp = { code, role, mode, unsubscribe: null, resultSent: false, lastData: null, currentGridKey: null };
  mp.unsubscribe = await subscribeToRoom(code, (data) => {
    mode === "turns" ? onTurnsUpdate(role, data) : onRaceUpdate(role, data);
  });
}

/* ---------- boot ---------- */
newGridBtn.addEventListener("click", () => newGame());
document.getElementById("play-again-btn").addEventListener("click", () => {
  mpResultLine.style.display = "none";
  mpResultLine.classList.remove("mp-win", "mp-lose", "mp-tie");
  if (mp && mp.mode === "race") {
    // Rematch in the same room: host rolls a fresh grid and writes it; both re-sync.
    if (mp.role === "host") {
      const g = newLocalGrid();
      const rowIds = g.rows.map((c) => c.id);
      const colIds = g.cols.map((c) => c.id);
      // Don't call startMpRound directly here — writing the new rowIds/colIds
      // triggers our own onRaceUpdate via the Firestore subscription, which
      // now detects the grid change and starts the round uniformly for both
      // host and guest. Calling it here too would just start it twice.
      updateRoomState(mp.code, { rowIds, colIds, results: {} });
    } else {
      setMpStatus("Waiting for host to start the next round…");
    }
  } else if (mp && mp.mode === "turns") {
    if (mp.role === "host") {
      const g = newLocalGrid();
      const rowIds = g.rows.map((c) => c.id);
      const colIds = g.cols.map((c) => c.id);
      const nextFirst = Math.random() < 0.5 ? "host" : "guest";
      updateRoomState(mp.code, {
        rowIds, colIds,
        cellOwner: Array(9).fill(null),
        cellChampId: Array(9).fill(null),
        scores: { host: 0, guest: 0 },
        turn: nextFirst,
        firstPlayer: nextFirst,
        gaveUpBy: null,
      }).then(() => updateRoomFields(mp.code, { status: "in_progress" }));
    } else {
      setMpStatus("Waiting for host to start the next round…");
    }
  } else {
    newGame();
  }
});

newGame();