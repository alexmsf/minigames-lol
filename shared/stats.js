/* ---------- persistent stats (localStorage) ---------- */
/* Generalized so each game keeps its own stats under its own key, but shares
   the load/save/corrupt-data-handling logic. */

export function createStatsStore(storageKey, defaultShape) {
  function load() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) throw new Error("no stats yet");
      return { ...defaultShape, ...JSON.parse(raw) };
    } catch {
      return { ...defaultShape };
    }
  }

  function save(stats) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(stats));
    } catch {
      /* localStorage unavailable (private browsing, etc.) — stats just won't persist */
    }
  }

  return { load, save };
}

export function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
