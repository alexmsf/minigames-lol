# Running this locally

Opening `index.html` directly by double-clicking it (a `file://` URL) will **not**
work, and isn't specific to anything in this codebase — every file in this project
that loads a game (`grid/index.html`, `chain/index.html`) uses:

```html
<script type="module" src="grid.js"></script>
```

Browsers block ES module `import`s from `file://` pages entirely, for security
reasons, regardless of what the modules actually contain. That's the exact error
you saw:

```
Access to script at 'file:///C:/.../grid.js' from origin 'null' has been
blocked by CORS policy...
```

The fix is to serve the folder over `http://localhost` instead of opening the
file directly. Any of the following works — pick whichever you already have
installed.

## Option 1 — Python (usually already on Windows)

Open a terminal (PowerShell or Command Prompt) in the `minigames-lol` folder
(the one containing this README and `index.html`), then run:

```
py -m http.server 8000
```

(If `py` isn't recognized, try `python -m http.server 8000`.)

Then open **http://localhost:8000/** in your browser.

## Option 2 — Node.js

If you have Node installed:

```
npx serve .
```

It'll print a `http://localhost:...` URL to open.

## Option 3 — VS Code "Live Server" extension

If you edit this in VS Code, install the **Live Server** extension, then
right-click `index.html` → "Open with Live Server". This is the easiest option
if you're already using VS Code, since it also auto-reloads on save.

---

Once you're loading it via `http://localhost:...` instead of `file://`, the
CORS error goes away and both games (including 1v1 via Firebase) work
normally.
