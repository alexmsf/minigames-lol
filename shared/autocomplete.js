/* ---------- shared autocomplete ---------- */
/* Powers the "type a champion name" input for both Grid and Chain. Wires up
   input/keydown listeners on the given elements and calls back into the game
   when the player picks (or exact-types) a champion. */

export function normName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildNormIndex(champions) {
  return new Map(champions.map((c) => [normName(c.name), c]));
}

/**
 * @param {Object} opts
 * @param {HTMLInputElement} opts.inputEl
 * @param {HTMLElement} opts.suggestionsEl
 * @param {Array} opts.champions - full champion pool to search
 * @param {(champ) => boolean} opts.isExcluded - true if champ shouldn't be suggested (e.g. already used)
 * @param {(champ) => void} opts.onSelect - called when the player commits to a champion
 * @param {(query: string) => void} [opts.onNoMatch] - called on Enter with no valid match
 */
export function attachAutocomplete({ inputEl, suggestionsEl, champions, isExcluded, onSelect, onNoMatch }) {
  const byNorm = buildNormIndex(champions);
  let suggIndex = -1;
  let currentSuggestions = [];

  function close() {
    suggestionsEl.classList.remove("open");
    suggestionsEl.innerHTML = "";
    suggIndex = -1;
    currentSuggestions = [];
  }

  function render() {
    if (currentSuggestions.length === 0) {
      close();
      return;
    }
    suggestionsEl.innerHTML = "";
    currentSuggestions.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "sugg-item" + (i === suggIndex ? " hi" : "");
      const img = document.createElement("img");
      img.src = c.iconUrl;
      img.alt = "";
      const label = document.createElement("span");
      label.textContent = c.name;
      row.appendChild(img);
      row.appendChild(label);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        close();
        inputEl.value = "";
        onSelect(c);
      });
      suggestionsEl.appendChild(row);
    });
    suggestionsEl.classList.add("open");
  }

  function trySubmitExact() {
    const champ = byNorm.get(normName(inputEl.value));
    if (champ && !isExcluded(champ)) {
      inputEl.value = "";
      close();
      onSelect(champ);
    } else if (onNoMatch) {
      onNoMatch(inputEl.value);
    }
  }

  inputEl.addEventListener("input", () => {
    const q = normName(inputEl.value);
    if (!q) {
      close();
      return;
    }
    currentSuggestions = champions
      .filter((c) => !isExcluded(c) && normName(c.name).includes(q))
      .slice(0, 8);
    suggIndex = -1;
    render();
  });

  inputEl.addEventListener("keydown", (e) => {
    if (!suggestionsEl.classList.contains("open")) {
      if (e.key === "Enter") {
        e.preventDefault();
        trySubmitExact();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      suggIndex = Math.min(suggIndex + 1, currentSuggestions.length - 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      suggIndex = Math.max(suggIndex - 1, 0);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = suggIndex >= 0 ? currentSuggestions[suggIndex] : currentSuggestions[0];
      if (pick) {
        close();
        inputEl.value = "";
        onSelect(pick);
      } else {
        trySubmitExact();
      }
    } else if (e.key === "Escape") {
      close();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".guess-row")) close();
  });

  return { close, refresh: () => byNorm };
}
