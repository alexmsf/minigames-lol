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

export function isValidChainLink(prev, candidate) {
  return sharedAttributes(prev, candidate).length > 0;
}
