# CodeToVideo Studio

Turn **HTML, CSS and JavaScript** code into a **high‑quality MP4 video**, right in your browser.
Pick an aspect ratio, resolution, frame rate and quality, hit **Export**, and download an MP4.

It works with plain HTML/CSS, `<canvas>` animations, and popular libraries loaded from a CDN
(**p5.js**, **three.js**, **GSAP**, etc.) — paste your code and render.

---

## Features

- **Live code editor** — HTML / CSS / JavaScript tabs (syntax highlighting, autosave).
- **Live preview** — rendered in a sandboxed iframe at the true export resolution.
- **Aspect ratio** — 16:9, 9:16, 1:1, 4:5, 4:3, 21:9, or a custom W:H.
- **Resolution** — 480p → 4K (2160p).
- **Frame rate** — 24 / 30 / 60 fps.
- **Duration & bitrate** — control length and quality.
- **True MP4 (H.264)** via the **WebCodecs** API + `mp4-muxer`, encoded frame‑by‑frame.
- **Deterministic, frame‑accurate capture** — a virtual clock drives `requestAnimationFrame`,
  `setTimeout`, `performance.now()` and `Date`, while CSS animations are scrubbed through the
  Web Animations API. Output is smooth regardless of how fast your machine is.
- **MediaRecorder fallback** for browsers without WebCodecs (produces WebM, or MP4 on Safari).
- **Built‑in examples** — CSS animation, canvas bars, p5.js particles, three.js cube.

---

## How to run

No build step and no server are required — it is plain static files.

**Option A — just open it**
Open `index.html` in a modern browser (Chrome or Edge recommended).

**Option B — serve it locally** (recommended, avoids some browser file:// limits)

```bash
# from the project folder
python3 -m http.server 8000
# then open http://localhost:8000
```

> Internet access is needed the first time so the browser can load the editor and encoder
> libraries from their CDNs (Ace, mp4-muxer).

---

## How to use

1. Write or paste your code in the **HTML / CSS / JavaScript** tabs (or load an **Example**).
2. Watch it in the **Preview** (Ctrl/Cmd + Enter re-runs it).
3. In **Export settings**, choose aspect ratio, resolution, fps, duration and bitrate.
4. Click **● Export MP4** and wait for the progress bar — the file downloads automatically.

### Capture modes

| Mode | Best for | How it works |
|------|----------|--------------|
| **Auto** | most cases | Uses a `<canvas>` if present, otherwise snapshots the DOM. |
| **Canvas stream** | p5.js / three.js / 2D canvas | Captures the `<canvas>` directly — fastest & sharpest. |
| **DOM snapshot** | general HTML/CSS, text, layout | Native SVG `<foreignObject>` snapshot each frame (no external library). |

> DOM mode renders the page using the browser's own SVG engine with inlined styles. It never
> hangs, but very advanced CSS features can render approximately — for canvas-based animation
> use **Canvas / Auto** mode for pixel-perfect results.

---

## Browser support

- **Best:** Chrome / Edge / other Chromium browsers — full **WebCodecs → MP4** path.
- **Fallback:** Firefox / Safari — uses MediaRecorder. Safari can produce MP4; Firefox produces WebM.

You can see which path is active in the badge at the top right.

---

## Tips for great results

- For the smoothest animation, drive motion with `requestAnimationFrame` (JS) or CSS animations —
  both are captured frame-accurately when **Deterministic timing** is on.
- Higher bitrate = sharper but larger files. 8–16 Mbps is great for 1080p; bump it up for 4K.
- Loading a library? Add its `<script src="https://…">` tag in the **HTML** tab; your JavaScript
  in the **JS** tab runs after it loads.

---

## Project structure

```
index.html        Main UI
css/style.css     Styling
js/editor.js      Code editor (Ace) + examples
js/preview.js     Iframe preview, sizing, deterministic clock harness
js/settings.js    Aspect ratio / resolution / fps / duration / bitrate
js/recorder.js    WebCodecs + mp4-muxer encoder and MediaRecorder fallback
js/app.js         Glue: live preview, export flow, progress, download
```

## Limitations

- Encoding happens on the main thread; very long clips at 4K can be slow and memory‑heavy.
- DOM-mode fidelity is limited to what the browser's SVG `<foreignObject>` rendering supports.
- The tool runs entirely client-side, so your code never leaves your browser.
