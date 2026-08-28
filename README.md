# StreamCuts

**A privacy-first, browser-based video editor with a professional, DaVinci Resolve–inspired workflow.**

StreamCuts is a fork of [OpenCut](https://github.com/opencut-app/opencut) that keeps the fast, no-upload editing experience while growing a pro-grade toolset — color grading, a Fairlight-style audio stack, richer editing and media management, and professional delivery formats — driven by a codebase-anchored [roadmap](docs/roadmap/README.md).

Your media never has to leave your machine: editing, preview, and export all run locally in the browser on a Rust/WebGPU compositor, with an optional local backend for the heavier ffmpeg jobs and on-device AI.

> ### ⚠️ Early work in progress
> StreamCuts is under **active, solo development and still very much in the works** — expect rough edges and **plenty of bugs**. It is not production-ready yet.
>
> **If you run into anything broken, please [open an issue](https://github.com/Echamma/StreamCuts/issues).** Any and all bug reports genuinely help me get this finished — see [Reporting bugs](#-reporting-bugs) below.

---

## ✨ Highlights

- **Local-first & private** — clips are edited and rendered on your device; nothing is uploaded to edit.
- **Frame-accurate** — an integer time model keeps cuts, trims, and keyframes exact.
- **GPU compositor** — a Rust/`wgpu` engine (17 blend modes, masks) drives both preview and export through one shared renderer (WebCodecs).
- **Crash-safe projects** — everything persists to IndexedDB with versioned schema migrations.
- **Pro workflow, opt-in** — a five-page workspace (Media · Edit · Color · Audio · Deliver) and several pro features sit behind an **Experiments** flag, so the classic single-workspace layout stays the default and unchanged.
- **On-device AI** — GPU Whisper transcription and Gemini-assisted "long-to-short" clip planning via the local backend.

---

## 🎬 Features

Organized by the five-page workspace. Items behind the **Experiments** flag are opt-in; the app is actively evolving toward the full roadmap, so some pro features are still landing.

### Media
- Clip **attributes** (tags, notes, rating), searchable, with **smart bins**
- **Scene detection** (right-click a clip → *Detect scenes* → automatic markers)
- **Media info** readout (resolution, duration, frame rate, audio, size)
- Waveform-based **audio sync** foundation

### Edit
- Multi-track timeline with **roll / slip / slide** trims
- **Clip markers**, **track locking**, and **linked A/V clips** (move/delete together)
- **Auto-reframe** (saliency) and word-by-word **caption animation**
- Transitions (crossfade, blur-through) and bezier keyframe animation

### Color
- **Color wheels** (lift/gamma/gain) on the GPU
- Video **scopes** — waveform + histogram (WebGPU with CPU fallback)
- `.cube` **LUT** import with a CPU trilinear sampler, and monotonic **tone curves**

### Audio (Fairlight-style)
- Channel **mixer** with **master metering**
- **Fades & crossfades**, parametric **EQ** (biquad)
- **EBU R128 loudness** — measure a clip (*Measure loudness*) and **normalize** it to a delivery target (e.g. −14 LUFS)

### Deliver
- **Render queue** (persisted), **custom presets**, and quick export
- Client-side **AV1** export
- Server-side pro transcodes via the backend: **ProRes**, **H.264 proxies**, **optimized all-intra** media, and **audio-only** stems

### AI (local backend)
- **Whisper** transcription and **Gemini**-assisted clip planning ("long-to-short")

---

## 🏗️ Tech stack

| Layer | Technology |
|---|---|
| Web app | Next.js 16 (App Router, Turbopack), React 19, TypeScript, Zustand, TailwindCSS |
| Rendering | Rust → WebAssembly (`opencut-wasm`), `wgpu` GPU compositor, WebCodecs |
| Media | `mediabunny`, `@ffmpeg/ffmpeg` (client-side) |
| Persistence | IndexedDB (crash-safe, migrated); Drizzle ORM + better-auth for optional accounts/cloud |
| Backend | NestJS 11 (Node/TypeScript) with `ffmpeg`/`ffprobe` for transcode & analysis |
| Testing | `bun test` (web), `node:test` (backend) |

---

## 📁 Repository structure

```
.
├── opencut-classic/            # Frontend + Rust core
│   ├── apps/web/               # Next.js web application (the editor)
│   ├── apps/desktop/           # Native desktop shell (GPUI, in progress)
│   └── rust/                   # GPU compositor, effects, masks, WASM bindings
├── backend/long-to-short/      # NestJS backend: AI clips, transcode, analysis
├── docs/roadmap/               # DaVinci-class feature roadmap & UX design
├── script/ · launcher/         # Windows launcher tooling
└── README.md
```

---

## 🚀 Getting started

### Prerequisites

- [Bun](https://bun.sh/docs/installation) (web app) and [Node.js](https://nodejs.org/) 20+ (backend)
- [ffmpeg](https://ffmpeg.org/) — required for the backend transcode/analysis routes (or use the bundled `ffmpeg-static`)
- [Docker](https://docs.docker.com/get-docker/) *(optional)* — for a local Postgres/Redis if you want accounts/cloud features

### 1. Web app (the editor)

```bash
cd opencut-classic
bun install

cd apps/web
cp .env.example .env.local     # fill in only what you need (see below)
bun run dev                    # http://localhost:3000
```

**Don't skip the `.env.local` copy** — the app validates its environment at startup and will fail to boot if the required keys are missing. The placeholder values in `.env.example` are enough to run the editor (the app treats them as "disabled" for those services); you only need to fill in *real* values for the optional AI (Gemini), accounts/database, and cloud features.

To reach the backend features (transcode, scene detection, loudness), point the app at it:

```bash
# in apps/web/.env.local
NEXT_PUBLIC_LONG_TO_SHORT_API_URL=http://localhost:4000
```

### 2. Backend (optional — AI, transcode, analysis)

```bash
cd backend/long-to-short
npm ci
npm run build
PORT=4000 node dist/main.js
```

ffmpeg/ffprobe are bundled via `ffmpeg-static`; to use your own system build (recommended if the bundled binary is blocked by antivirus):

```bash
FFMPEG_PATH=ffmpeg FFPROBE_PATH=ffprobe PORT=4000 node dist/main.js
```

---

## 🔌 Backend API

Base URL defaults to `http://localhost:4000`.

| Method & path | Purpose |
|---|---|
| `POST /api/transcode/proxy` | H.264 editing proxy (downscaled) |
| `POST /api/transcode/prores` | Apple ProRes master (profile-selectable) |
| `POST /api/transcode/optimized` | All-intra H.264 (instant seeking) |
| `POST /api/transcode/audio` | Audio-only export (mp3 / aac / wav / flac) |
| `GET  /api/transcode/outputs/:file` | Download a transcode output |
| `POST /api/scene-detect` | Detect scene-cut timestamps |
| `POST /api/loudness` | EBU R128 measurement (integrated / range / true peak) |
| `POST /api/loudness/normalize` | Two-pass normalize to a target, returns a WAV |
| `GET  /api/loudness/outputs/:file` | Download a normalized output |
| `POST /api/boss/*`, `POST /api/long-to-short/*` | AI clip generation & transcription |
| `GET  /api/health` | Health check |

---

## 🧪 Testing

```bash
# Web app (pure logic/units)
cd opencut-classic/apps/web && bun test

# Backend (args/parse units + live ffmpeg verification)
cd backend/long-to-short
npm run test:transcode      # unit tests
npm run verify:transcode    # end-to-end against real ffmpeg
npm run test:scene-detect
npm run verify:scene-detect
```

The backend `verify:*` scripts synthesize test media with ffmpeg and assert the output with ffprobe — objective, non-perceptual checks that the codecs, cuts, and loudness numbers come out right.

---

## 🗺️ Roadmap

The full DaVinci Resolve–class feature integration and UX overhaul is mapped in **[docs/roadmap/](docs/roadmap/README.md)** — a codebase-anchored, feature-by-feature plan (~120 rows across the seven Resolve pages), a phased delivery plan, the five-page workspace design, the design-token spec, and a risk register.

---

## 🖥️ Windows launcher

A double-clickable local launcher can start the backend and open the editor in your browser.

1. Prepare the production builds once:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\script\prepare-windows-launcher.ps1
   ```
2. Double-click `.\dist\windows\StreamCutsLauncher.exe`

The launcher is **start-only**: it does not install dependencies or build the app — it expects the production backend/frontend artifacts to already exist.

---

## 🐛 Reporting bugs

StreamCuts is still being built, and **bug reports are the single most helpful thing you can contribute** right now. If something breaks, misbehaves, or just feels wrong:

👉 **[Open an issue on GitHub](https://github.com/Echamma/StreamCuts/issues)**

A great report usually includes:

- **What you did** — the steps to reproduce it
- **What you expected** vs. **what actually happened**
- Your **browser & OS** (WebGPU/WebCodecs support varies)
- Any **console errors** (open DevTools → Console) and a screenshot or short clip if you can

No report is too small — every one moves this closer to done. Thank you 🙏

---

## 📄 License & credits

StreamCuts builds on **[OpenCut](https://github.com/opencut-app/opencut)**, which is [MIT licensed](opencut-classic/LICENSE) (© 2025–2026 OpenCut). DaVinci Resolve is a trademark of Blackmagic Design and is used here only as a design reference, not a compatibility or parity claim.
