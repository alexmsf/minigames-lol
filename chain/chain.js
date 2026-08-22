import { CHAMPIONS } from "../shared/champions-data.js";
import { sharedAttributes, sharedAttributesExcluding, isValidChainLink } from "../shared/attributes.js";
import { attachAutocomplete } from "../shared/autocomplete.js";
import { createStatsStore, formatTime } from "../shared/stats.js";
import { createRoom, joinRoom, subscribeToRoom, updateRoomState, updateRoomFields } from "../shared/multiplayer.js";

const GROUP_LABELS = { region: "region", species: "species", position: "position", year: "release year" };

const CHAMP_BY_ID = new Map(CHAMPIONS.map((c) => [c.id, c]));

// Every chain is timed now. You get TURN_TIME_START seconds for your first
// link; each successful link shaves TURN_TIME_STEP off the *next* turn's
// clock, down to a TURN_TIME_FLOOR floor so it never becomes literally
// impossible. Running out of time always ends the round, regardless of the
// sudden-death setting — sudden death only governs whether a *wrong* guess
// (made in time) also ends it.
const TURN_TIME_START = 30;
const TURN_TIME_FLOOR = 5;
const TURN_TIME_STEP = 1;
function turnDurationForLength(length) {
  return Math.max(TURN_TIME_FLOOR, TURN_TIME_START - (length - 1) * TURN_TIME_STEP);
}

/* ---------- stats ---------- */
const { load: loadStats, save: saveStats } = createStatsStore("runeterra-chain-stats", {
  gamesPlayed: 0, longestChain: 0, bestTimeSeconds: null,
});
let stats = loadStats();

function renderStatsStrip() {
  const bestTime = stats.bestTimeSeconds != null ? formatTime(stats.bestTimeSeconds) : "—";
  statsStripEl.innerHTML =
    `<span><b>${stats.gamesPlayed}</b> played</span>` +
    `<span>Longest <b>${stats.longestChain}</b></span>` +
    `<span>Best timed run <b>${bestTime}</b></span>`;
}

/* ---------- game state ---------- */
let chain = [];              // array of champion objects, in order
let linkAttrs = [];          // linkAttrs[i] = shared attribute used between chain[i-1] and chain[i]
let usedIds = new Set();
let misses = 0;
let roundOver = true;
let suddenDeath = false;
let settingsLocked = false;
let hintLevel = 0;
let hintTextValue = "";

let timerInterval = null;
let roundStartMs = null;     // when the current round began (for the elapsed/best-time stat)
let turnDeadlineMs = null;   // when the current turn's clock hits zero
let timerElapsedSeconds = 0;
let turnRemainingSeconds = TURN_TIME_START;

let mp = null;          // { code, role, unsubscribe, currentRound, lastKnownRound }
let mpIsMyTurn = false; // only the active player's client should act on a timeout

const chainEl = document.getElementById("chain");
const chainScrollEl = document.getElementById("chain-scroll") || chainEl.parentElement;
const guessInput = document.getElementById("guess-input");
const suggestionsEl = document.getElementById("suggestions");
const guessHint = document.getElementById("guess-hint");
const errLine = document.getElementById("err-line");
const statLength = document.getElementById("stat-length");
const statMisses = document.getElementById("stat-misses");
const statBest = document.getElementById("stat-best");
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
const settingsRow = document.querySelector(".settings-row");
const suddenToggle = document.getElementById("sudden-toggle");
const suddenToggleLabel = document.getElementById("sudden-toggle-label");
const timerRow = document.getElementById("timer-row");
const timerPill = document.getElementById("timer-pill");
const statsStripEl = document.getElementById("stats-strip");
const newChainBtn = document.getElementById("new-chain-btn");

const mpCreateBtn = document.getElementById("mp-create-btn");
const mpJoinBtn = document.getElementById("mp-join-btn");
const mpCodeInput = document.getElementById("mp-code-input");
const mpLobbyRow = document.getElementById("mp-lobby-row");
const mpCodeDisplay = document.getElementById("mp-code-display");
const mpStatus = document.getElementById("mp-status");
const mpIntro = document.getElementById("mp-intro");
const mpTurnRow = document.getElementById("mp-turn-row");
const mpTagHost = document.getElementById("mp-tag-host");
const mpTagGuest = document.getElementById("mp-tag-guest");
const mpSettingsLine = document.getElementById("mp-settings-line");

function randomStartChampion() {
  return CHAMPIONS[Math.floor(Math.random() * CHAMPIONS.length)];
}

/* ---------- round lifecycle (solo) ---------- */
function newChain(forcedStart) {
  const start = forcedStart || randomStartChampion();
  chain = [start];
  linkAttrs = [null];
  usedIds = new Set([start.id]);
  misses = 0;
  roundOver = false;
  hintLevel = 0;
  hintTextValue = "";

  suddenDeath = suddenToggle.checked;

  guessInput.value = "";
  guessInput.disabled = false;
  errLine.textContent = "";
  errLine.className = "err";
  guessHint.innerHTML = "Name a champion who connects to the last link.";
  giveUpBtn.disabled = false;
  resultBanner.classList.remove("show");
  copyToast.textContent = "";
  mpResultLine.style.display = "none";

  settingsLocked = false;
  setSettingsLocked(false);

  stopTimer();
  roundStartMs = null;
  timerElapsedSeconds = 0;
  timerRow.style.display = "flex";
  startTurnTimer();

  renderChain();
  renderHintUI();
  updateStatsBar();
  renderStatsStrip();
  guessInput.focus();
}

function setSettingsLocked(locked) {
  suddenToggle.disabled = locked || !!mp;
  suddenToggleLabel.classList.toggle("disabled", locked || !!mp);
}

function lockSettingsForRound() {
  if (settingsLocked) return;
  settingsLocked = true;
  setSettingsLocked(true);
}

/* ---------- timer ---------- */
// One continuous per-turn countdown. It doesn't pause or reset on a wrong
// guess — you're free to keep guessing (unless sudden death is on) as long
// as the clock hasn't hit zero. A fresh, shorter clock starts the moment a
// link lands.
function updateTimerDisplay() {
  timerPill.textContent = formatTime(turnRemainingSeconds);
  timerPill.classList.toggle("warn", turnRemainingSeconds <= 5);
}

function startTurnTimer(turnStartMsOverride) {
  const start = turnStartMsOverride != null ? turnStartMsOverride : Date.now();
  if (roundStartMs == null) roundStartMs = start;
  const duration = turnDurationForLength(chain.length);
  turnDeadlineMs = start + duration * 1000;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 200);
  tickTimer();
}

function tickTimer() {
  const now = Date.now();
  timerElapsedSeconds = Math.max(0, Math.floor((now - roundStartMs) / 1000));
  turnRemainingSeconds = Math.max(0, Math.ceil((turnDeadlineMs - now) / 1000));
  updateTimerDisplay();
  if (turnDeadlineMs - now <= 0) onTurnTimeout();
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function onTurnTimeout() {
  if (roundOver) { stopTimer(); return; }
  if (mp) {
    // Both clients tick down in sync, but only the player whose turn it
    // actually is should end the round — otherwise both would race to.
    if (mpIsMyTurn) { stopTimer(); timeoutMp(); }
  } else {
    stopTimer();
    finishRound(false, false, true);
  }
}

/* ---------- rendering ---------- */
function renderChain() {
  chainEl.innerHTML = "";
  chain.forEach((champ, i) => {
    if (i > 0) {
      const connector = document.createElement("div");
      connector.className = "chain-connector";
      const attr = document.createElement("span");
      attr.className = "attr";
      attr.textContent = linkAttrs[i] ? linkAttrs[i].label : "";
      connector.appendChild(attr);
      chainEl.appendChild(connector);
    }
    const row = document.createElement("div");
    row.className = "chain-link" + (i === chain.length - 1 ? " latest" : "");
    const idx = document.createElement("div");
    idx.className = "idx";
    idx.textContent = i + 1;
    const img = document.createElement("img");
    img.src = champ.iconUrl;
    img.alt = "";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = champ.name;
    row.appendChild(idx);
    row.appendChild(img);
    row.appendChild(name);
    if (i === 0) {
      const tag = document.createElement("div");
      tag.className = "chain-start-tag";
      tag.textContent = "Start";
      row.appendChild(tag);
    }
    chainEl.appendChild(row);
  });
  // Scroll the actual overflow container (.chain-scroll), not #chain itself —
  // #chain has no overflow/scrollbar of its own, so setting scrollTop on it
  // was a no-op and the list never auto-scrolled as it grew.
  requestAnimationFrame(() => {
    chainScrollEl.scrollTop = chainScrollEl.scrollHeight;
  });
}

function updateStatsBar() {
  statLength.textContent = chain.length;
  statMisses.textContent = misses;
  statBest.textContent = stats.longestChain;
}

/* ---------- autocomplete ---------- */
const autocomplete = attachAutocomplete({
  inputEl: guessInput,
  suggestionsEl,
  champions: CHAMPIONS,
  isExcluded: (c) => usedIds.has(c.id),
  onSelect: (champ) => submitGuess(champ),
  onNoMatch: () => {
    errLine.textContent = "Enter a valid, unused champion name.";
    errLine.className = "err";
  },
});

/* ---------- guess resolution (solo) ---------- */
function submitGuess(champ) {
  if (roundOver) return;
  if (mp) { submitMpGuess(champ); return; }

  lockSettingsForRound();
  if (usedIds.has(champ.id)) {
    errLine.textContent = `${champ.name} is already in the chain.`;
    errLine.className = "err";
    return;
  }

  const last = chain[chain.length - 1];
  const prevGroup = linkAttrs[linkAttrs.length - 1] ? linkAttrs[linkAttrs.length - 1].group : null;
  const usable = sharedAttributesExcluding(last, champ, prevGroup);

  if (usable.length > 0) {
    chain.push(champ);
    linkAttrs.push(usable[0]);
    usedIds.add(champ.id);
    hintLevel = 0;
    hintTextValue = "";
    guessInput.value = "";
    errLine.textContent = "";
    errLine.className = "err";
    renderChain();
    renderHintUI();
    updateStatsBar();
    startTurnTimer(); // fresh, shorter clock for the next link
    return;
  }

  misses++;
  const rawShared = sharedAttributes(last, champ);
  errLine.textContent = rawShared.length > 0
    ? `${champ.name} only connects via ${GROUP_LABELS[prevGroup] || prevGroup}, same as the last link — try a different kind of connection.`
    : `${champ.name} doesn't share a region, species, position, or release year with ${last.name}.`;
  errLine.className = "err info";
  updateStatsBar();
  if (suddenDeath) {
    finishRound(false, true, false);
  }
  // Otherwise: keep guessing — the clock (not the miss) is what ends it.
}

/* ---------- hints ---------- */
function unusedValidCandidates() {
  const last = chain[chain.length - 1];
  const prevGroup = linkAttrs[linkAttrs.length - 1] ? linkAttrs[linkAttrs.length - 1].group : null;
  return CHAMPIONS.filter((c) => !usedIds.has(c.id) && isValidChainLink(last, c, prevGroup));
}

function renderHintUI() {
  hintRow.style.display = "flex";
  hintBtn.disabled = hintLevel >= 2 || roundOver;
  hintBtn.textContent = hintLevel >= 2 ? "No more hints" : `Hint (${hintLevel + 1}/2)`;
  hintText.textContent = hintTextValue;
}

hintBtn.addEventListener("click", () => {
  if (hintBtn.disabled || roundOver) return;
  const candidates = unusedValidCandidates();
  const level = hintLevel + 1;
  hintLevel = level;

  if (level === 1) {
    hintTextValue = candidates.length === 0
      ? "No unused champion connects to the last link — this may be the end of the road!"
      : `${candidates.length} unused champion${candidates.length === 1 ? "" : "s"} could extend the chain.`;
  } else if (level === 2) {
    if (candidates.length === 0) {
      hintTextValue += " Nothing left to reveal.";
    } else {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      const prevGroup = linkAttrs[linkAttrs.length - 1] ? linkAttrs[linkAttrs.length - 1].group : null;
      const attr = sharedAttributesExcluding(chain[chain.length - 1], pick, prevGroup)[0];
      hintTextValue = `${hintTextValue} One option connects via "${attr.label}" and starts with "${pick.name[0]}".`;
    }
  }
  renderHintUI();
});

/* ---------- give up / round end (solo) ---------- */
giveUpBtn.addEventListener("click", () => {
  if (roundOver) return;
  if (mp) { concedeMp(); return; }
  const ok = window.confirm("End this chain here?");
  if (!ok) return;
  finishRound(true, false, false);
});

function finishRound(gaveUp, suddenDeathEnd, timedOut) {
  if (roundOver) return;
  roundOver = true;
  stopTimer();
  guessInput.disabled = true;
  autocomplete.close();
  hintRow.style.display = "none";
  giveUpBtn.disabled = true;
  setSettingsLocked(false);
  guessHint.innerHTML = "Chain complete.";

  const length = chain.length;
  finalScore.textContent = `Chain of ${length}`;
  let line = timedOut
    ? "Time's up — the clock beat you to it."
    : suddenDeathEnd
      ? "Sudden death — a wrong guess ended the run here."
      : gaveUp
        ? "You called it there."
        : "Chain complete.";

  stats.gamesPlayed += 1;
  if (length > stats.longestChain) {
    stats.longestChain = length;
    line += " New longest chain!";
  }
  if (length >= stats.longestChain) {
    if (stats.bestTimeSeconds == null || timerElapsedSeconds < stats.bestTimeSeconds) {
      stats.bestTimeSeconds = timerElapsedSeconds;
    }
  }
  saveStats(stats);
  renderStatsStrip();
  updateStatsBar();

  finalLine.textContent = line;
  resultBanner.classList.add("show");
}

/* ---------- share result ---------- */
shareBtn.addEventListener("click", async () => {
  const names = chain.map((c) => c.name).join(" → ");
  const text = `Runeterra Champion Chain — length ${chain.length}\nTime: ${formatTime(timerElapsedSeconds)}\n${names}`;
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

/* ================= multiplayer (1v1 turn-based) ================= */
// One shared chain. Players alternate turns adding a link. The room host
// sets the round's parameters (currently: sudden death) at creation time —
// they apply to both players and can't be changed mid-room. Every 1v1
// round is timed; there's no toggle for it. Giving up on your turn, or
// running out of your turn's clock, concedes the round to your opponent —
// the chain's final length is the shared result either way.

function setMpStatus(text, live) {
  mpStatus.textContent = text;
  mpStatus.classList.toggle("live", !!live);
}

function rebuildChainFromIds(ids) {
  chain = ids.map((id) => CHAMP_BY_ID.get(id));
  linkAttrs = [null];
  for (let i = 1; i < chain.length; i++) {
    const prevGroup = linkAttrs[i - 1] ? linkAttrs[i - 1].group : null;
    const usable = sharedAttributesExcluding(chain[i - 1], chain[i], prevGroup);
    linkAttrs.push(usable[0] || sharedAttributes(chain[i - 1], chain[i])[0]);
  }
  usedIds = new Set(ids);
}

mpCreateBtn.addEventListener("click", async () => {
  mpCreateBtn.disabled = true;
  setMpStatus("Creating room…");
  try {
    const start = randomStartChampion();
    const hostSuddenDeath = suddenToggle.checked;
    const { code, role } = await createRoom("chain", {
      chainIds: [start.id], turn: "guest", status: "waiting", round: 1,
      suddenDeath: hostSuddenDeath, turnStartedAt: Date.now(),
    });
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
  mpTurnRow.style.display = "block";
  mpIntro.textContent = role === "host"
    ? "Share this code with your opponent. They move first once they join."
    : "You're in! You move first.";

  // The room's settings are locked in by the host — no per-player choice
  // once you're in a room.
  settingsRow.style.display = "none";

  mp = { code, role, unsubscribe: null, currentRound: null, lastKnownRound: 1 };
  mp.unsubscribe = await subscribeToRoom(code, (data) => onMpUpdate(role, code, data));
}

function onMpUpdate(role, code, data) {
  const bothPresent = data.hostPresent && data.guestPresent;
  mp.lastKnownRound = data.state.round || 1;
  suddenDeath = !!data.state.suddenDeath;
  rebuildChainFromIds(data.state.chainIds);
  renderChain();
  updateStatsBar();

  mpSettingsLine.style.display = "block";
  mpSettingsLine.textContent = `Room settings (set by host) — Sudden death: ${suddenDeath ? "On" : "Off"} · every round timed`;

  mpTagHost.classList.toggle("turn", data.state.turn === "host" && data.status !== "finished");
  mpTagGuest.classList.toggle("turn", data.state.turn === "guest" && data.status !== "finished");

  if (!bothPresent) {
    setMpStatus(role === "host" ? "Waiting for opponent to join…" : "Waiting for round to start…");
    return;
  }

  // Detect a (re)started round by a server-assigned round counter rather
  // than a one-shot local flag, so the timer correctly restarts for BOTH
  // players on a rematch — a per-client flag only ever got reset by
  // whichever client initiated the rematch (the host), leaving the guest's
  // clock stuck not restarting.
  const thisRound = data.state.round;
  if (thisRound !== mp.currentRound) {
    mp.currentRound = thisRound;
    roundOver = false;
    guessInput.disabled = false;
    giveUpBtn.disabled = false;
    hintRow.style.display = "none"; // hints stay solo-only, to keep 1v1 fair
    resultBanner.classList.remove("show");
    setMpStatus("Both players in — go!", true);
    roundStartMs = Date.now();
    timerRow.style.display = "flex";
  }

  if (data.status === "finished") {
    roundOver = true;
    stopTimer();
    guessInput.disabled = true;
    giveUpBtn.disabled = true;
    setMpStatus("Round finished.", true);
    const iLost = data.state.loserRole === role;
    const lostToTimeout = data.state.loserReason === "timeout";
    mpResultLine.style.display = "block";
    mpResultLine.classList.remove("mp-win", "mp-lose");
    mpResultLine.classList.add(iLost ? "mp-lose" : "mp-win");
    finalScore.textContent = `Chain of ${chain.length}`;
    finalLine.textContent = iLost
      ? (lostToTimeout ? "⏱️ You ran out of time — your opponent wins this round." : "😔 You couldn't extend the chain — your opponent wins this round.")
      : (lostToTimeout ? "⏱️ Your opponent ran out of time — you win this round!" : "🏆 Your opponent couldn't extend the chain — you win this round!");
    mpResultLine.textContent = `Final chain length: ${chain.length}`;
    resultBanner.classList.add("show");
    return;
  }

  const myTurn = data.state.turn === role;
  mpIsMyTurn = myTurn;
  guessInput.disabled = !myTurn;
  errLine.textContent = "";
  errLine.className = "err";
  guessHint.innerHTML = myTurn
    ? `Your move — connect to <b>${chain[chain.length - 1].name}</b>`
    : `Waiting for opponent's move…`;

  // Both clients sync their countdown off the shared turnStartedAt so the
  // clock reads the same for both players, even though only the active
  // player's client acts on a timeout.
  startTurnTimer(data.state.turnStartedAt);

  if (myTurn) guessInput.focus();
}

async function submitMpGuess(champ) {
  const myTurn = mp && !roundOver; // guessInput is disabled unless it's my turn, so a submit implies it's my turn
  if (!myTurn) return;
  if (usedIds.has(champ.id)) {
    errLine.textContent = `${champ.name} is already in the chain.`;
    errLine.className = "err";
    return;
  }
  const last = chain[chain.length - 1];
  const prevGroup = linkAttrs[linkAttrs.length - 1] ? linkAttrs[linkAttrs.length - 1].group : null;
  const shared = sharedAttributesExcluding(last, champ, prevGroup);
  if (shared.length === 0) {
    const rawShared = sharedAttributes(last, champ);
    errLine.textContent = rawShared.length > 0
      ? `${champ.name} only connects via ${GROUP_LABELS[prevGroup] || prevGroup}, same as the last link — try a different kind of connection.`
      : `${champ.name} doesn't share a region, species, position, or release year with ${last.name}.`;
    errLine.className = "err info";
    return;
  }
  guessInput.value = "";
  guessInput.disabled = true; // avoid double-submits while the write is in flight
  const nextTurn = mp.role === "host" ? "guest" : "host";
  const newChainIds = [...chain.map((c) => c.id), champ.id];
  await updateRoomState(mp.code, { chainIds: newChainIds, turn: nextTurn, turnStartedAt: Date.now() });
}

async function concedeMp() {
  const ok = window.confirm("Give up your turn? Your opponent wins this round.");
  if (!ok) return;
  await updateRoomFields(mp.code, { status: "finished" });
  await updateRoomState(mp.code, { loserRole: mp.role, loserReason: "conceded" });
}

async function timeoutMp() {
  if (!mp || roundOver) return;
  await updateRoomFields(mp.code, { status: "finished" });
  await updateRoomState(mp.code, { loserRole: mp.role, loserReason: "timeout" });
}

/* ---------- boot ---------- */
newChainBtn.addEventListener("click", () => newChain());
document.getElementById("play-again-btn").addEventListener("click", () => {
  mpResultLine.style.display = "none";
  if (mp) {
    if (mp.role === "host") {
      const start = randomStartChampion();
      const nextRound = (mp.lastKnownRound || 1) + 1;
      updateRoomState(mp.code, {
        chainIds: [start.id], turn: "guest", loserRole: null, loserReason: null,
        round: nextRound, turnStartedAt: Date.now(),
      }).then(() => updateRoomFields(mp.code, { status: "in_progress" }));
    } else {
      setMpStatus("Waiting for host to start the next round…");
    }
  } else {
    newChain();
  }
});

newChain();