# Runeterra Games

Two champion-guessing games sharing one codebase:

- **Grid** (`/grid`) — 3×3 puzzle, name a champion fitting each row+column.
- **Chain** (`/chain`) — keep a chain going by matching region, species, position, or release year with the last champion.

Both work fully solo with no setup. 1v1 mode needs a free Firebase project (instructions below).

## Project structure

```
/shared/
  champions-data.js   champion dataset (all games read this)
  attributes.js        category logic (Grid) + shared-attribute logic (Chain)
  autocomplete.js       the "type a champion name" dropdown, used by both games
  stats.js              localStorage stats helper
  multiplayer.js         Firebase Firestore room helper (create/join/sync)
  firebase-config.js      YOUR Firebase project config goes here
  theme.css               shared visual design (colors, fonts, buttons, panels)
/grid/                  Grid game (index.html, grid.css, grid.js)
/chain/                 Chain game (index.html, chain.css, chain.js)
index.html              hub page linking to both games
```

Adding a third game later: drop a new folder next to `/grid` and `/chain`, import whatever you need from `/shared`, and add a card to the hub `index.html`.

## Running it locally

Browsers block ES module imports (`import ... from`) over `file://`, so you need a tiny local server rather than double-clicking `index.html`. From the project root:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Setting up Firebase for 1v1 mode (free tier)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a new project (the free **Spark plan** is enough — no credit card required).
2. In the project, go to **Build → Firestore Database → Create database**. Start in **test mode** for now (you'll tighten the rules in step 5).
3. Go to **Project settings → General → Your apps**, click the `</>` (web) icon, register the app (no need for Firebase Hosting), and copy the `firebaseConfig` object it gives you.
4. Paste those values into `shared/firebase-config.js`, replacing the `REPLACE_ME` placeholders. This file is safe to publish — it identifies your project, it isn't a secret.
5. Before sharing the game publicly, tighten your Firestore rules (Firestore → Rules) so rooms can only be read/written by people who know the room code, and old rooms don't accumulate forever. A reasonable starting point:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /rooms/{code} {
         allow read, write: if true; // anyone with the code can join — fine for a casual game
       }
     }
   }
   ```

   For anything more sensitive you'd add auth and per-field validation, but for a game where the "secret" is just a 5-character room code, this is a normal tradeoff.
6. Check [Firebase's current pricing page](https://firebase.google.com/pricing) for the latest free-tier quotas — they get revised occasionally, but casual 1v1 play for friends is nowhere near the limits.

That's it — no backend server, no Cloud Functions. Both players' browsers talk directly to Firestore and stay in sync via a live listener on the room document.

## Deploying to GitHub Pages

1. Push this whole folder to a GitHub repo.
2. In the repo, go to **Settings → Pages**, set **Source** to your main branch (root folder), and save.
3. GitHub gives you a URL like `https://yourname.github.io/reponame/`. That's your live game — share `.../grid/index.html` or `.../chain/index.html` directly, or link people to the hub at the root.

GitHub Pages only serves static files, which is all this project is — Firebase handles the real-time part entirely from the browser, so there's nothing else to deploy or host.

## Notes on the multiplayer design

- **Grid 1v1** is a *race*: the host generates one puzzle, both players solve it independently and simultaneously, and whoever solves more cells (or the same number faster) wins. This avoids the complexity of both players fighting over the same cell in real time.
- **Chain 1v1** is *turn-based*: one shared chain, players alternate adding a link, and giving up on your turn concedes the round.
- Room documents live at `rooms/{code}` in Firestore and clean themselves up conceptually never — for a hobby project this is fine, but if you want to keep the database tidy you could add a Cloud Function or a manual cleanup pass later to delete rooms older than a day.
