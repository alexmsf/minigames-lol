/* ---------- shared multiplayer (Firebase Firestore) ---------- */
/* A thin wrapper around Firestore that both games use for 1v1 mode. Each
   room is one document at rooms/{code}. Whoever creates a room is "host",
   whoever joins with the code is "guest". Both sides subscribe to the same
   document and re-render whenever it changes — that's the entire sync
   mechanism, no server code required. Free (Spark) tier is plenty for
   casual 1v1 play; see README.md for setup and current quota numbers. */

// Firebase is loaded lazily (dynamic import, only when a room is actually
// created/joined) rather than at the top of this file. A static top-level
// import of a CDN module means if that fetch ever fails — offline, CDN
// hiccup, ad blocker, no Firebase project configured yet — the WHOLE module
// graph fails to load, silently breaking solo play too, since grid.js and
// chain.js import from this file unconditionally. Lazy loading means solo
// mode never depends on Firebase being reachable at all.
import { FIREBASE_CONFIG } from "./firebase-config.js";

let dbPromise = null;

async function ensureDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const [{ initializeApp, getApps }, firestore] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"),
    ]);
    const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    return { db: firestore.getFirestore(app), firestore };
  })().catch((err) => {
    dbPromise = null; // allow retrying on the next call instead of staying broken forever
    throw new Error("Couldn't reach Firebase — check your connection and shared/firebase-config.js.");
  });
  return dbPromise;
}

function randomCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easier to read aloud
  let code = "";
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function roomRef(code) {
  const { db, firestore } = await ensureDb();
  return firestore.doc(db, "rooms", code.toUpperCase());
}

/**
 * Creates a new room for the given game and returns { code, role: "host" }.
 * `initialState` is whatever shape the game wants to sync (chain array,
 * grid state, whose turn, etc). Retries a few times on the (very unlikely)
 * chance of a room-code collision.
 */
export async function createRoom(gameId, initialState) {
  const { db, firestore } = await ensureDb();
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode();
    const ref = firestore.doc(db, "rooms", code);
    const existing = await firestore.getDoc(ref);
    if (existing.exists()) continue; // collision, try another code
    await firestore.setDoc(ref, {
      gameId,
      createdAt: firestore.serverTimestamp(),
      updatedAt: firestore.serverTimestamp(),
      status: "waiting", // waiting | in_progress | finished
      hostPresent: true,
      guestPresent: false,
      state: initialState,
    });
    return { code, role: "host" };
  }
  throw new Error("Could not allocate a room code — try again.");
}

/** Joins an existing room by code. Returns { code, role: "guest", data }. */
export async function joinRoom(code) {
  const { firestore } = await ensureDb();
  const ref = await roomRef(code);
  const snap = await firestore.getDoc(ref);
  if (!snap.exists()) throw new Error("No room found with that code.");
  const data = snap.data();
  if (data.guestPresent) throw new Error("That room already has two players.");
  await firestore.updateDoc(ref, { guestPresent: true, status: "in_progress", updatedAt: firestore.serverTimestamp() });
  return { code, role: "guest", data };
}

/**
 * Subscribes to a room's live document. `callback(data)` fires immediately
 * with the current state and again on every remote change. Returns an
 * unsubscribe function — call it when leaving the game/page. Since
 * subscribing requires the (async, lazily-loaded) Firestore SDK, this
 * returns a Promise<unsubscribeFn> rather than the unsubscribe fn directly.
 */
export async function subscribeToRoom(code, callback) {
  const { firestore } = await ensureDb();
  const ref = await roomRef(code);
  return firestore.onSnapshot(ref, (snap) => {
    if (snap.exists()) callback(snap.data());
  });
}

/** Shallow-merges `partialState` into the room's `state` field. */
export async function updateRoomState(code, partialState) {
  const { firestore } = await ensureDb();
  const ref = await roomRef(code);
  const snap = await firestore.getDoc(ref);
  const current = snap.exists() ? snap.data().state || {} : {};
  await firestore.updateDoc(ref, {
    state: { ...current, ...partialState },
    updatedAt: firestore.serverTimestamp(),
  });
}

/** Updates top-level room fields (status, turn, etc), not the nested state. */
export async function updateRoomFields(code, fields) {
  const { firestore } = await ensureDb();
  const ref = await roomRef(code);
  await firestore.updateDoc(ref, { ...fields, updatedAt: firestore.serverTimestamp() });
}

export async function deleteRoom(code) {
  const { firestore } = await ensureDb();
  const ref = await roomRef(code);
  await firestore.deleteDoc(ref);
}
