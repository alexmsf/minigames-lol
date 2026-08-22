/* ---------- shared champion-attribute logic ---------- */
/* Used by Grid (needs "categories" you can build a puzzle grid from) and by
   Chain (needs "what do these two specific champions have in common"). Both
   are views onto the same underlying champion fields, so they live together. */

export const ROLES = ["Fighter", "Tank", "Mage", "Assassin", "Marksman", "Support"];

export const DIFFICULTY_TIERS = [
  { id: "easy", label: "Low difficulty (1-3)", min: 1, max: 3 },
  { id: "medium", label: "Medium difficulty (4-6)", min: 4, max: 6 },
  { id: "hard", label: "High difficulty (7-10)", min: 7, max: 10 },
];

/* ---------- category builders (Grid game) ---------- */

export function buildRoleCategories() {
  return ROLES.map((role) => ({
    id: `role:${role}`,
    label: role,
    group: "role",
    exclusive: false,
    matches: (c) => c.tags.includes(role),
  }));
}

export function buildResourceCategories(champions) {
  const resources = [...new Set(champions.map((c) => c.resource || "Manaless"))].sort();
  return resources.map((resource) => ({
    id: `resource:${resource}`,
    label: `Resource: ${resource === "Manaless" ? "Manaless" : resource}`,
    group: "resource",
    exclusive: true,
    matches: (c) => (c.resource || "Manaless") === resource,
  }));
}

export function buildDamageTypeCategories() {
  const labels = { AD: "Primarily AD", AP: "Primarily AP", Hybrid: "Hybrid damage" };
  return Object.entries(labels).map(([dtype, label]) => ({
    id: `damage:${dtype}`,
    label,
    group: "damageType",
    exclusive: true,
    matches: (c) => c.damageType === dtype,
  }));
}

export function buildDifficultyCategories() {
  return DIFFICULTY_TIERS.map((tier) => ({
    id: `difficulty:${tier.id}`,
    label: tier.label,
    group: "difficulty",
    exclusive: true,
    matches: (c) => c.difficulty >= tier.min && c.difficulty <= tier.max,
  }));
}

export function buildGenderCategories(champions) {
  const values = [...new Set(champions.map((c) => c.gender).filter(Boolean))].sort();
  return values.map((value) => ({
    id: `gender:${value}`,
    label: `Gender: ${value}`,
    group: "gender",
    exclusive: true,
    matches: (c) => c.gender === value,
  }));
}

// region / species / position / rangeType are LIST fields on the champion
// (a champion can belong to more than one), so these are never exclusive.
export function buildListFieldCategories(champions, field, group, labelPrefix) {
  const values = [...new Set(champions.flatMap((c) => c[field] || []))].sort();
  return values.map((value) => ({
    id: `${field}:${value}`,
    label: `${labelPrefix}: ${value}`,
    group,
    exclusive: false,
    matches: (c) => (c[field] || []).includes(value),
  }));
}

export function buildCategories(champions) {
  return [
    ...buildRoleCategories(),
    ...buildResourceCategories(champions),
    ...buildDamageTypeCategories(),
    ...buildDifficultyCategories(),
    ...buildGenderCategories(champions),
    ...buildListFieldCategories(champions, "regions", "region", "Region"),
    ...buildListFieldCategories(champions, "species", "species", "Species"),
    ...buildListFieldCategories(champions, "positions", "position", "Position"),
    ...buildListFieldCategories(champions, "rangeType", "rangeType", "Range"),
  ];
}

/* ---------- grid builder (Grid game) ---------- */

export function getAnswers(category, champions) {
  return champions.filter((c) => category.matches(c));
}

export function intersectionAnswers(rowCat, colCat, champions) {
  return champions.filter((c) => rowCat.matches(c) && colCat.matches(c));
}

export function pairIsStructurallyValid(a, b) {
  if (a.id === b.id) return false;
  if (a.exclusive && b.exclusive && a.group === b.group) return false;
  return true;
}

export function isValidCell(rowCat, colCat, champions, minAnswers, maxAnswers) {
  if (!pairIsStructurallyValid(rowCat, colCat)) return false;
  const answers = intersectionAnswers(rowCat, colCat, champions);
  return answers.length >= minAnswers && answers.length <= maxAnswers;
}

export function viableCategories(categories, champions, minAnswers) {
  return categories.filter((c) => getAnswers(c, champions).length >= minAnswers);
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A grid is only actually solvable if there's a way to assign 9 *distinct*
// champions to the 9 cells such that every champion satisfies its cell's row
// AND column. Checking each cell's answer count in isolation (as the loop
// below does) is NOT enough to guarantee that: two cells can each have
// plenty of individual answers while still sharing almost the same small
// pool of champions, so a player who fills other cells first can strand a
// later cell with zero unused matches left ("no matches left" — e.g. a
// small-species row like God-Warrior crossed with columns that happen to
// share the same handful of champions). This is exactly Hall's marriage
// problem, so we verify a genuine perfect matching exists (via Kuhn's
// augmenting-path algorithm — trivially fast for 9 cells) before accepting
// a candidate grid, and reject/retry otherwise.
function hasPerfectMatching(cells) {
  const cellAnswerIds = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      cellAnswerIds.push(cells[r][c].map((champ) => champ.id));
    }
  }
  const n = cellAnswerIds.length; // always 9 (3x3)
  const matchedCellForChamp = new Map(); // championId -> cellIndex currently assigned

  function tryAssign(cellIdx, visited) {
    for (const champId of cellAnswerIds[cellIdx]) {
      if (visited.has(champId)) continue;
      visited.add(champId);
      const occupant = matchedCellForChamp.get(champId);
      if (occupant === undefined || tryAssign(occupant, visited)) {
        matchedCellForChamp.set(champId, cellIdx);
        return true;
      }
    }
    return false;
  }

  let matchedCount = 0;
  for (let i = 0; i < n; i++) {
    if (tryAssign(i, new Set())) matchedCount++;
  }
  return matchedCount === n;
}

export function generateGrid(champions, categories, opts = {}) {
  const minAnswers = opts.minAnswers ?? 2;
  const maxAnswers = opts.maxAnswers ?? 15;
  const maxTries = opts.maxTries ?? 5000;

  const pool = viableCategories(categories, champions, minAnswers);

  for (let t = 0; t < maxTries; t++) {
    const shuffled = shuffle(pool);
    const rows = shuffled.slice(0, 3);
    if (rows.length < 3) continue;

    const remaining = shuffled.filter((c) => !rows.includes(c));
    const cols = [];
    for (const cat of remaining) {
      if (cols.length === 3) break;
      const worksWithAllRows = rows.every((r) =>
        isValidCell(r, cat, champions, minAnswers, maxAnswers)
      );
      if (worksWithAllRows) cols.push(cat);
    }
    if (cols.length < 3) continue;

    const cells = rows.map((r) => cols.map((c) => intersectionAnswers(r, c, champions)));
    if (!hasPerfectMatching(cells)) continue; // structurally guaranteed unsolvable — reject and retry

    return { rows, cols, cells };
  }
  return null;
}

/* ---------- pairwise attribute matching (Chain game) ---------- */

// The four link types the chain game accepts, per the design brief: region,
// species, position, and year of release. Each entry knows how to pull its
// value(s) off a champion and how to compare two champions for a shared link.
export const CHAIN_LINK_TYPES = [
  {
    group: "region",
    labelPrefix: "Region",
    values: (c) => c.regions || [],
  },
  {
    group: "species",
    labelPrefix: "Species",
    values: (c) => c.species || [],
  },
  {
    group: "position",
    labelPrefix: "Position",
    values: (c) => c.positions || [],
  },
  {
    group: "year",
    labelPrefix: "Released",
    values: (c) => (c.releaseDate ? [c.releaseDate.slice(0, 4)] : []),
  },
];

// Returns every attribute champions `a` and `b` have in common, e.g.
// [{ group: "region", value: "Ionia", label: "Region: Ionia" }, ...]
export function sharedAttributes(a, b) {
  const shared = [];
  for (const type of CHAIN_LINK_TYPES) {
    const aValues = new Set(type.values(a));
    const bValues = type.values(b);
    for (const v of bValues) {
      if (aValues.has(v)) {
        const label = type.group === "year" ? `Released in ${v}` : `${type.labelPrefix}: ${v}`;
        shared.push({ group: type.group, value: v, label });
      }
    }
  }
  return shared;
}

// `excludeGroup`, when given, filters out shared attributes belonging to
// that group — used to enforce "you can't use the same category two links
// in a row" (e.g. species:Human -> species:Human is blocked, but
// species:Human -> region:Ionia is fine even if both are technically shared).
export function sharedAttributesExcluding(a, b, excludeGroup) {
  const shared = sharedAttributes(a, b);
  if (!excludeGroup) return shared;
  return shared.filter((attr) => attr.group !== excludeGroup);
}

export function isValidChainLink(prev, candidate, excludeGroup) {
  return sharedAttributesExcluding(prev, candidate, excludeGroup).length > 0;
}

/* ---------- puzzle builder (Connections game) ---------- */

// Classic NYT-Connections-style difficulty ramp: rarer (smaller-pool)
// categories are "harder" and get the purple/hardest slot.
export const CONNECTIONS_DIFFICULTY_ORDER = ["purple", "blue", "green", "yellow"];

// Picks `numGroups` categories and, for each, a set of `groupSize` champions
// that match ONLY that category among the chosen ones (not any of the other
// three) — so every one of the numGroups*groupSize champions used in the
// puzzle has exactly one correct group, with no built-in ambiguity beyond
// the intended "these categories look similar" trickiness of picking nearby
// categories. Returns an array of { category, champions, difficulty },
// sorted hardest (purple) first, or null if no valid combination was found
// within maxTries.
export function buildConnectionsPuzzle(champions, categories, opts = {}) {
  const groupSize = opts.groupSize ?? 4;
  const numGroups = opts.numGroups ?? 4;
  const maxTries = opts.maxTries ?? 4000;

  const pool = categories.filter((cat) => getAnswers(cat, champions).length >= groupSize);
  if (pool.length < numGroups) return null;

  for (let t = 0; t < maxTries; t++) {
    const chosen = shuffle(pool).slice(0, numGroups);

    const exclusivePools = chosen.map(() => []);
    for (const champ of champions) {
      let matchIdx = -1;
      let matchCount = 0;
      for (let i = 0; i < chosen.length; i++) {
        if (chosen[i].matches(champ)) { matchIdx = i; matchCount++; }
      }
      if (matchCount === 1) exclusivePools[matchIdx].push(champ);
    }
    if (exclusivePools.some((p) => p.length < groupSize)) continue;

    const groups = chosen.map((cat, i) => ({
      category: cat,
      champions: shuffle(exclusivePools[i]).slice(0, groupSize),
    }));

    // Difficulty reflects how rare the category is overall (its full answer
    // pool across every champion), not just this draw's 4 picks, so it's a
    // stable property of the category rather than an artifact of shuffling.
    groups.sort((a, b) => getAnswers(a.category, champions).length - getAnswers(b.category, champions).length);
    groups.forEach((g, i) => { g.difficulty = CONNECTIONS_DIFFICULTY_ORDER[i] || "yellow"; });

    return groups;
  }
  return null;
}

// Serializes a puzzle to plain ids so it can be written to a multiplayer
// room and rebuilt identically by the other client.
export function connectionsPuzzleToSpec(puzzle) {
  return puzzle.map((g) => ({
    categoryId: g.category.id,
    champIds: g.champions.map((c) => c.id),
    difficulty: g.difficulty,
  }));
}

// Rebuilds a puzzle from a spec (as produced by connectionsPuzzleToSpec)
// using lookup maps the caller already has (categoryById, champById).
export function connectionsPuzzleFromSpec(spec, categoryById, champById) {
  return spec.map((g) => ({
    category: categoryById.get(g.categoryId),
    champions: g.champIds.map((id) => champById.get(id)),
    difficulty: g.difficulty,
  }));
}
