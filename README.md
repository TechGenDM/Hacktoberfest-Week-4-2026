# DEAD AIR — The Last Frequency

A first-person 3D mystery set in an abandoned radio observatory, with an optional AI assistant that runs **entirely in your browser** on open weights (Gemma 4 E2B via Transformers.js + WebGPU).

> **03:17 AM.** Kestrel Ridge Radio Observatory has been sealed since 1979. Tonight a transmission begins on a frequency that is supposed to be dead. Explore the control hall, recover three signal fragments, tune transmitter TX-2 and reconstruct the final transmission.

Built for Hacktoberfest 2026, Week 4. Vite + TypeScript + Three.js. No backend, no API keys, no paid services.

![Control hall](docs/screenshots/02-hall.jpg)

| | |
|---|---|
| ![Title](docs/screenshots/01-title.jpg) | ![Signal monitor](docs/screenshots/03-monitor-3d.jpg) |
| ![Frequency tuning](docs/screenshots/06-tuning.jpg) | ![THE SIGNAL, scripted preview](docs/screenshots/08-signal-scripted.jpg) |
| ![Evidence file](docs/screenshots/09-evidence.jpg) | ![Reconstruction](docs/screenshots/10-reconstruct.jpg) |

---

## Quick start

Requires Node.js 20.19+ or 22.12+ (Vite 8). The tests need Node 22.18+, which runs TypeScript directly. Developed on Node 25; CI builds on Node 22.

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build:

```bash
npm run build      # type-checks with tsc, then bundles into dist/
npm test           # validator, evidence lookup and load-progress tests (node:test, no extra dependencies)
```

`dist/` is a static site. It has to be served over **https** or from **localhost** because WebGPU needs a secure context.

### Deployment (GitHub Pages)

Production builds use the base path `/DEAD-AIR/` (see `vite.config.ts`), so the site lives at `https://techgendm.github.io/DEAD-AIR/`. The dev server still runs at `/`. `.github/workflows/deploy.yml` runs `npm ci`, `npm test` and `npm run build`, then publishes `dist/` on every push to `main`, or when triggered by hand.

The repository's Pages source must be set to **GitHub Actions** (Settings → Pages). To host somewhere else, change `base` in `vite.config.ts` to that path.

To check a production build locally, serve `dist/` under `/DEAD-AIR/`, the same way Pages does:

```bash
mkdir -p /tmp/site && rm -rf /tmp/site/DEAD-AIR && cp -R dist /tmp/site/DEAD-AIR
python3 -m http.server 4173 --directory /tmp/site   # http://localhost:4173/DEAD-AIR/
```

(With the `/DEAD-AIR/` base, Vite 8's `vite preview` returns 404 for the main module script when the browser sends `Sec-Fetch-Dest: script`, so use a plain static server.)

**Runtime dependencies.** `dist/` holds only the game and the AI worker. Two things are fetched at runtime, and only when THE SIGNAL is loaded:

- **Model files** from the Hugging Face Hub.
- **ONNX Runtime WebAssembly** (`ort-wasm-simd-threaded.asyncify.wasm` and `.mjs`, about 27 MB uncompressed) from **jsDelivr**, at the onnxruntime-web version Transformers.js was built against. This is Transformers.js's default (`env.backends.onnx.wasm.wasmPaths`), and the deployed site was verified working with it. `vite.config.ts` resolves onnxruntime-web with its `onnxruntime-web-use-extern-wasm` condition, so Vite doesn't emit an unused local copy of the WASM. After the first load, Transformers.js serves the WASM from the browser cache.

If jsDelivr or Hugging Face is unreachable, the model can't load. The game and the scripted preview still work.

## Controls

| Key | Action |
|---|---|
| `W` `A` `S` `D` / arrows | Move |
| Mouse | Look (click the scene to capture the pointer) |
| `Shift` | Walk faster |
| `E` | Interact with the highlighted station |
| `J` | Evidence file |
| `T` | THE SIGNAL (AI assistant) |
| `Esc` | Close panel / pause |

Inside the transmitter panel, use `←` `→` to tune (hold `Shift` for 0.001 MHz steps). You can also scroll over the dial or drag the slider.

## What's in the game

Three interactive stations in a procedurally built control hall:

1. **Incident log** (desk with the amber lamp): the 1979 night-shift log and the decommission notice. These are historical evidence E1–E3.
2. **Signal monitor** (green CRT bank): three channels. Channel 1 can be demodulated straight away. Channel 2 needs the filter band named in the log. Channel 3 only carries a signal once TX-2 is transmitting. These give fragments F1–F3, plus the origin trace E4.
3. **Radio transmitter TX-2** (amber cabinet): the frequency-tuning puzzle. Static, a carrier tone, a scope trace and a strength meter all respond as you get closer. Hold the needle on the logged carrier to lock it (E5). Once all three fragments are recovered, TX-2 is also where you **reconstruct the final transmission**.

The HUD shows a six-step **signal recovery** progress bar and the next objective. The **evidence file** (`J`) lists everything you've recovered, with IDs.

<details>
<summary>Walkthrough (spoilers)</summary>

1. Read the incident log. It tells you the carrier is **7.317 MHz** and that the operator used **filter band 2**.
2. Signal monitor → CH1 → *Demodulate* (F1, E4).
3. Signal monitor → CH2 → *Band 2* (F2).
4. TX-2 → tune to 7.317 and hold for 1.5 s (E5).
5. Signal monitor → CH3 → *Capture* (F3).
6. TX-2 (or the evidence file) → *Reconstruct*: order the fragments by timecode, T+00:00 → T+00:41 → T+01:17, then key the transmitter.

</details>

---

## Architecture

```
index.html              title screen, HUD, modal and drawer shells
src/
  main.ts               game flow: pointer lock, overlays, stations, puzzles, reconstruction, ending
  world.ts              Three.js scene: procedural observatory, lights, fog, CRT/dial canvas textures,
                        first-person movement with AABB collision, interaction raycast
  story.ts              canonical story data: evidence E1–E5, fragments F1–F3, tuning target,
                        deterministic reconstruction rule
  state.ts              discovered evidence, completed steps, progress
  audio.ts              procedural WebAudio: mains hum, radio static, carrier tone (no audio files)
  signalPanel.ts        THE SIGNAL drawer UI: load flow, progress, chat, per-sentence verdicts
  signal/
    signal.ts           WebGPU check, prompt builder, evidence validator, evidence lookup, scripted preview,
                        worker client
    progress.ts         turns Transformers.js download events into one honest progress figure
    ai.worker.ts        Transformers.js + Gemma 4 E2B in a Web Worker (keeps the 3D loop smooth)
  style.css             charcoal / amber / radio-green HUD
test/                   node:test regression tests for the validator, evidence lookup and load progress
```

- **Everything is procedural.** The room, racks, CRTs, the parabolic dish (a `LatheGeometry`), the pines, the textures (canvas noise) and the audio. There are no downloaded 3D, image or sound assets.
- **The game logic is fully deterministic and does not depend on the AI.** Puzzle gates live in `main.ts`. The win condition is `isCorrectOrder()` in `story.ts`: ascending transmission offset. The LLM can't unlock, skip or decide anything.

```
 player actions ──► state.discover(ids) ──► HUD / evidence file
                                   │
                                   ▼ discovered evidence only
 question ──► lookupFact() ── direct question about an exact fact (FACTS in story.ts)
                 │              whose evidence is discovered? ──► canonical statement + [ID] ──┐
                 │ otherwise                                       "EVIDENCE LOOKUP"          │
                 ▼                                                                             │
              buildMessages() ──► ai.worker (Gemma 4 E2B, WebGPU) ──► raw text                 │
                                                                       │                       │
                                     validate(raw, discovered) ◄───────┴───────────────────────┘
                                       │ per-sentence: cited? cited item discovered?
                                       │ numbers & proper nouns present in evidence?
                                       ▼
                         VERIFIED / PARTIAL (struck-through claims) / REJECTED / NO SIGNAL
```

## The open-source AI: THE SIGNAL

| | |
|---|---|
| Model | **Gemma 4 E2B instruction-tuned** by Google DeepMind ([`onnx-community/gemma-4-E2B-it-ONNX`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX)), Apache 2.0 |
| Runtime | [Transformers.js](https://github.com/huggingface/transformers.js) `@huggingface/transformers` 4.3, ONNX Runtime Web, **WebGPU** backend |
| Precision | `q4f16` when the GPU supports `shader-f16`, otherwise `q4` |
| Download | ~3.1 GB on first use (3.13 GB measured, text-only path), then served from the browser cache |
| Where it runs | A dedicated Web Worker in your tab. Questions and evidence never leave the machine. |

**How it loads.** Nothing is fetched until you open THE SIGNAL (`T`) and press *Load Gemma 4 E2B*. The worker loads the model with `Gemma4ForCausalLM`, which in Transformers.js runs Gemma 4 in **text-only mode**: just `embed_tokens` and `decoder_model_merged`. That skips the vision and audio encoders, which this game doesn't need. The panel shows the bytes of the files actually requested (the tokenizer, config and the two text-only ONNX sessions), the files still transferring, then *creating WebGPU sessions* and *shader warm-up*. Downloading fills the bar to 95%, session creation shows 96%, warm-up 98%, and the panel only switches to **READY** (with the loaded size and load time) once warm-up has finished. Transformers.js's own aggregate counts the vision and audio encoders too, which are never downloaded, so it isn't used. During generation the panel shows tokens/sec. If loading or inference fails, the actual error message is shown.

**Grounding contract.** The model only sees what the player has recovered:

1. The system prompt contains **only discovered evidence**, each item tagged with its ID (`[E1]`, `[F2]`…). Undiscovered evidence is never sent. The panel footer lists exactly which IDs went into the context.
2. **Exact facts are looked up, not generated.** A direct question about one of a few canonical facts (`FACTS` in `src/story.ts`: the carrier frequency, the filter band, the night operator, when TX-2 was last keyed, the signal's time offset) is answered with that fact's fixed statement, cited with the ID of the discovered evidence it comes from. For example, *"What frequency should I tune TX-2 to?"* gets *"The carrier was logged on 7.317 MHz. [E1]"*. These replies are labelled **EVIDENCE LOOKUP · NOT GENERATED**, show the source evidence, and still go through the validator. Questions that are interpretive (*why*, *what does … mean*), match several facts or none, mention a name or number the evidence doesn't contain, or concern undiscovered evidence go to Gemma.
3. The model is told to end every sentence with the evidence IDs it relies on, to use no outside facts, and to answer `NO SIGNAL ON THAT BAND.` when the evidence doesn't cover the question. It's also told not to declare the final fragment order.
4. Every reply goes through `validate()` (`src/signal/signal.ts`) before it's displayed. A sentence is **removed and struck through, with the reason shown**, if:
   - it has no evidence reference,
   - it cites an ID that doesn't exist or hasn't been discovered,
   - it contains a number (year, time, frequency) that isn't in the evidence it cites, or
   - it uses a proper noun that appears nowhere in the discovered evidence.
5. Each answer gets a verdict: **VERIFIED**, **PARTIAL**, **REJECTED** or **NO SIGNAL**. The raw model output stays available under *raw output* for transparency.
6. The final transmission is checked by the game (`isCorrectOrder`), never by the model.

The validator splits sentences on `.`, `!` and `?`, but not after initials (*M. Okafor*), titles (*Dr.*, *Mr.*, *Prof.*…) or abbreviations followed by lowercase text (*e.g.*, *a.m.*). `npm test` covers citation checks, undiscovered and nonexistent IDs, unsupported numbers and names, PARTIAL verdicts and these splitting rules.

### Live verification on GitHub Pages

Tested on **November 1, 2026** at https://techgendm.github.io/DEAD-AIR/:

| | |
|---|---|
| Browser | Chrome 156 on Apple Silicon (macOS) |
| WebGPU adapter | Apple, Metal 3 (`metal-3`), `shader-f16` supported |
| Model | Gemma 4 E2B, `q4f16`, text-only path |
| Cold load | **283 s** from pressing *Load* to ready, including download and shader warm-up |
| Model data transferred | **~3.13 GB** (vision and audio encoders not downloaded) |
| Generation | **27.6–36.7 tokens/s** across the tested questions, 1.0–2.8 s per answer |
| Network | 0 failed requests, 0 HTTP 4xx/5xx, 0 CORS errors |

With E1–E3 in context:

- *"Where is the carrier coming from?"* → three cited sentences (E1, E1, E3) → **VERIFIED**
- *"What frequency should I tune TX-2 to?"* → grounded but unhelpful at the time: Gemma said twice that monitoring 7.317 MHz is prohibited [E3]. Since then this question is answered by evidence lookup with *"The carrier was logged on 7.317 MHz. [E1]"*.
- *"Who sent the signal from Mars?"* → `NO SIGNAL ON THAT BAND.`
- *"The night operator was Dr. Harold Vance and he saw aliens in 1985, right?"* → `NO SIGNAL ON THAT BAND.`

![THE SIGNAL running Gemma 4 E2B on the GitHub Pages deployment](docs/screenshots/15-signal-live-github-pages.jpg)

The progress, WASM, lookup and validator changes were checked in the same browser against the production build served on the same origin, with the model loaded from the browser cache: the bar went 0 → 93 → 96 (sessions) → 98 (warm-up) → READY, showing 3.13 / 3.13 GB, and Gemma answered at 32–37 tokens/s.

**Not verified:** Windows, Linux, other browsers (Edge, Safari, Firefox), GPUs without `shader-f16` (the `q4` path), and integrated or low-memory GPUs. An earlier run on `localhost` (same machine) is shown below.

![THE SIGNAL running Gemma 4 E2B locally](docs/screenshots/14-signal-gemma-local.jpg)

**Scripted preview (no AI).** If WebGPU is missing, the model fails to load, or you just don't want a 3.1 GB download, choose *Use scripted preview*. It's a small rule-based responder that stitches together sentences from recovered evidence and runs them through the same validator. Evidence lookups work in this mode too. It is **clearly labelled** "SCRIPTED PREVIEW · No language model is running" in the panel, in the HUD badge and on the ending screen. The UI never shows "local inference" unless the Gemma worker has actually reported `ready`.

## Browser requirements

| Feature | Requirement |
|---|---|
| Game (3D, puzzles, scripted preview) | Any modern desktop browser with WebGL 2 and Pointer Lock (Chrome, Edge, Firefox, Safari) |
| THE SIGNAL with Gemma 4 E2B | A WebGPU browser: **Chrome / Edge 113+** on desktop (best support). Safari 26+ and Firefox 141+ (Windows) ship WebGPU, but this project was only verified in Chrome 156 on macOS (Apple Silicon). |
| GPU memory | Plan for roughly **4 GB** of free GPU/unified memory for `q4f16` |
| Disk | ~3.1 GB browser cache for the model files |
| Context | `https://` or `localhost` (WebGPU requires a secure context) |

Mouse and keyboard are required. Touch devices are not supported.

## Demo / screenshots

The screenshots in `docs/screenshots/` were captured from this build. To record a demo:

1. `npm run dev` and open `http://localhost:5173` in Chrome, at 1440×900 or larger. Turn sound on.
2. Title screen → **START INVESTIGATION**.
3. Walk to the amber desk lamp (right side) → `E` to read the log.
4. Walk to the green CRT bank (left wall) → `E` → demodulate CH1 → choose band 2 on CH2.
5. Walk to the TX-2 cabinet (back right) → `E` → tune toward 7.317. Listen to the static fade into a tone, then hold.
6. Back to the monitor → capture CH3.
7. Press `T`. Either load Gemma 4 E2B (first load takes a while, then it's cached) or pick the scripted preview, and ask *"Where is the carrier coming from?"*. Point out the citation chips and verdict line. Ask *"What frequency should I tune TX-2 to?"* to show an evidence lookup. Ask something off-topic (*"Who sent the signal from Mars?"*) to show the refusal or rejection.
8. Return to TX-2 → **Reconstruct**. Try a wrong order first to show the deterministic rejection, then the correct one for the ending.

## Known limitations

- **Model size and first load.** ~3.1 GB is a heavy first download, and loading plus shader compilation can take minutes on slower connections or GPUs. Low-memory GPUs may fail to allocate. The error is shown and the scripted preview remains available.
- **The validator is heuristic, not proof.** It catches missing citations, wrong citations, unsupported numbers and invented proper nouns. It can't catch a claim made only of common words that misstates the evidence (for example, lowercase "aliens"), and it can be overly strict when the model paraphrases a number (for example, "3:17" vs "03:17").
- Validated answers are grounded but not always *helpful*. The validator checks that claims are supported, not that the answer is good. Evidence lookup fixes this for the listed exact facts only. Its question matching is a short hand-written table, so other phrasings go to Gemma.
- Small models sometimes ignore the citation format. Those sentences get struck out rather than shown as fact, so some answers come back **REJECTED**.
- No save system. Progress resets on reload. A playthrough takes about 5–10 minutes.
- Desktop only (pointer lock plus keyboard). No gamepad or touch controls.
- Pressing `Esc` to close a panel can't always recapture the mouse (browser rule). Click **Resume** or the scene.
- THE SIGNAL depends on two third-party hosts at runtime: Hugging Face for the model and jsDelivr for the ONNX Runtime WebAssembly. The Three.js bundle is ~610 kB (158 kB gzipped).

## License

Code, story and procedural assets: [MIT](LICENSE). The Gemma 4 model weights are not included in this repository. They are downloaded at runtime from Hugging Face under their own license (Apache 2.0).

## Credits

- Gemma 4 by Google DeepMind. ONNX conversion by the onnx-community on Hugging Face.
- Transformers.js by Hugging Face. Three.js by its contributors.
- Story, code and procedural assets are original to this project.
