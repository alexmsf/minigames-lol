import { CHAMPIONS } from "../shared/champions-data.js";
import { sharedAttributes, sharedAttributesExcluding, isValidChainLink } from "../shared/attributes.js";
import { attachAutocomplete } from "../shared/autocomplete.js";
import { createStatsStore, formatTime } from "../shared/stats.js";
import { createRoom, joinRoom, subscribeToRoom, updateRoomState, updateRoomFields } from "../shared/multiplayer.js";

const GROUP_LABELS = { region: "region", species: "species", position: "position", year: "release year" };

const CHAMP_BY_ID = new Map(CHAMPIONS.map((c) => [c.id, c]));

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
let timedRun = false;
let settingsLocked = false;
let hintLevel = 0;
let hintTextValue = "";

let timerInterval = null;
let timerStartMs = null;
let timerElapsedSeconds = 0;

let mp = null; // { code, role, unsubscribe, roundStarted, resultSent }

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
const suddenToggle = document.getElementById("sudden-toggle");
const suddenToggleLabel = document.getElementById("sudden-toggle-label");
const timerToggle = document.getElementById("timer-toggle");
const timerToggleLabel = document.getElementById("timer-toggle-label");
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
  timedRun = mp ? true : timerToggle.checked;

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
  timerElapsedSeconds = 0;
  timerRow.style.display = timedRun ? "flex" : "none";
  updateTimerDisplay();
  if (mp) startTimer();

  renderChain();
  renderHintUI();
  updateStatsBar();
  renderStatsStrip();
  if (!mp) guessInput.focus();
}

function setSettingsLocked(locked) {
  timerToggle.disabled = locked || !!mp;
  timerToggleLabel.classList.toggle("disabled", locked || !!mp);
  suddenToggle.disabled = locked || !!mp;
  suddenToggleLabel.classList.toggle("disabled", locked || !!mp);
}

function lockSettingsForRound() {
  if (settingsLocked) return;
  timedRun = mp ? true : timerToggle.checked;
  suddenDeath = mp ? false : suddenToggle.checked;
  settingsLocked = true;
  setSettingsLocked(true);
  if (timedRun && !mp) startTimer();
  timerRow.style.display = timedRun ? "flex" : "none";
}

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
    finishRound(false, true);
  }
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
  finishRound(true, false);
});

function finishRound(gaveUp, suddenDeathEnd) {
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
  let line = suddenDeathEnd
    ? "Sudden death — a wrong guess ended the run here."
    : gaveUp
      ? "You called it there."
      : "Chain complete.";

  stats.gamesPlayed += 1;
  if (length > stats.longestChain) {
    stats.longestChain = length;
    line += " New longest chain!";
  }
  if (timedRun && length >= stats.longestChain) {
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
  const timeLine = timedRun ? `\nTime: ${formatTime(timerElapsedSeconds)}` : "";
  const text = `Runeterra Champion Chain — length ${chain.length}${timeLine}\n${names}`;
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
// One shared chain. Players alternate turns adding a link. Giving up on your
// turn concedes the round to your opponent — the chain's final length is the
// shared result either way.

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
    const { code, role } = await createRoom("chain", {
      chainIds: [start.id], turn: "guest", status: "waiting", round: 1,
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

  mp = { code, role, unsubscribe: null, roundStarted: false, currentRound: null };
  mp.unsubscribe = await subscribeToRoom(code, (data) => onMpUpdate(role, code, data));
}

function onMpUpdate(role, code, data) {
  const bothPresent = data.hostPresent && data.guestPresent;
  mp.lastKnownRound = data.state.round || 1;
  rebuildChainFromIds(data.state.chainIds);
  renderChain();
  updateStatsBar();

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
    // 1v1 rounds are always timed — otherwise a chain can drag on forever.
    // (This was previously never wired up for multiplayer at all.)
    timedRun = true;
    timerElapsedSeconds = 0;
    timerRow.style.display = "flex";
    updateTimerDisplay();
    startTimer();
  }

  const myTurn = data.state.turn === role;

  if (data.status === "finished") {
    roundOver = true;
    stopTimer();
    guessInput.disabled = true;
    giveUpBtn.disabled = true;
    setMpStatus("Round finished.", true);
    const iLost = data.state.loserRole === role;
    mpResultLine.style.display = "block";
    mpResultLine.classList.remove("mp-win", "mp-lose");
    mpResultLine.classList.add(iLost ? "mp-lose" : "mp-win");
    finalScore.textContent = `Chain of ${chain.length}`;
    finalLine.textContent = iLost
      ? "😔 You couldn't extend the chain — your opponent wins this round."
      : "🏆 Your opponent couldn't extend the chain — you win this round!";
    mpResultLine.textContent = `Final chain length: ${chain.length}`;
    resultBanner.classList.add("show");
    return;
  }

  guessInput.disabled = !myTurn;
  errLine.textContent = "";
  errLine.className = "err";
  guessHint.innerHTML = myTurn
    ? `Your move — connect to <b>${chain[chain.length - 1].name}</b>`
    : `Waiting for opponent's move…`;
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
  await updateRoomState(mp.code, { chainIds: newChainIds, turn: nextTurn });
}

async function concedeMp() {
  const ok = window.confirm("Give up your turn? Your opponent wins this round.");
  if (!ok) return;
  await updateRoomFields(mp.code, { status: "finished" });
  await updateRoomState(mp.code, { loserRole: mp.role });
}

/* ---------- boot ---------- */
newChainBtn.addEventListener("click", () => newChain());
document.getElementById("play-again-btn").addEventListener("click", () => {
  mpResultLine.style.display = "none";
  if (mp) {
    if (mp.role === "host") {
      const start = randomStartChampion();
      const nextRound = (mp.lastKnownRound || 1) + 1;
      updateRoomState(mp.code, { chainIds: [start.id], turn: "guest", loserRole: null, round: nextRound })
        .then(() => updateRoomFields(mp.code, { status: "in_progress" }));
    } else {
      setMpStatus("Waiting for host to start the next round…");
    }
  } else {
    newChain();
  }
});

newChain();
