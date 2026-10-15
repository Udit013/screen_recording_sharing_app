# SnapCast — Record messy, ship clean

> A screen recorder with a one-take editor for developer demos, PR walkthroughs and bug repros. Record without rehearsing, then fix the take like a doc: delete words from the transcript, tighten every pause, export an MP4 or share the edit as a link. Speech recognition, audio analysis and video encoding all run in the browser, so editing costs nothing to operate. Built with Next.js 15, Neon PostgreSQL, Cloudinary, Whisper (transformers.js), WebCodecs and Gemini 2.0 Flash.

[![CI](https://github.com/Udit013/screen_recording_sharing_app/actions/workflows/ci.yml/badge.svg)](https://github.com/Udit013/screen_recording_sharing_app/actions/workflows/ci.yml)
[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel)](https://snapcast-video-sharing.vercel.app)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://typescriptlang.org)

## Live Demo

**[→ snapcast-video-sharing.vercel.app](https://snapcast-video-sharing.vercel.app)**

---

## The one-take editor

**Who it's for:** engineers, devrel and founders who record short technical videos. **The problem:** a 3-minute walkthrough takes 4 attempts, because one flubbed sentence or a long "where was that tab" pause makes you start over, and real video editors are too heavy for a throwaway demo.

**What you do:** record once. Open **Edit** on the video:

1. **Tighten pauses.** Gentle, Balanced or Tight. Each button shows the exact seconds it would remove from *your* recording, measured, not estimated.
2. **Edit by editing text.** Transcribe on your device, select the flubbed sentence, press ⌫. Click any pause chip in the transcript to keep or remove just that pause.
3. **Ship it.** Edits are live on the video page and share link immediately (cuts are skipped during playback, so nothing re-encodes). Or **Export MP4**: a real file, rendered on your device's hardware encoder.

Select any range to **copy a clip link** that plays just that part, or **export the clip** as its own MP4. Owners see a one-line invitation to the editor on unedited videos, and an "edited cut" summary on edited ones; press `?` in the editor for every shortcut.

Every edit is non-destructive and undoable (⌘Z / ⇧⌘Z). The upload is never modified, and comments, notes and chapters stay anchored because cuts live in source time.

### How it works

| Stage | Runs in | How |
|---|---|---|
| Audio for analysis | Browser | Cloudinary's audio-only `.mp3` rendition of the video (~0.75 MB/min, measured), decoded to 16 kHz mono with `OfflineAudioContext`. The video itself is never downloaded for analysis |
| Pause detection | Browser | Adaptive RMS loudness in 20 ms frames. The threshold sits 30% of the way from the noise floor (10th percentile) to speech level (90th), so it adapts to each mic and room. Recordings with < 10 dB between speech and noise are left alone rather than guessed at |
| Transcription | Browser (Web Worker) | Whisper `tiny.en` (q8, 41 MB measured, cached after first use) via transformers.js on WASM, with word-level timestamps. Long recordings are split into ≤ 28 s windows **at detected pauses**, so no word is cut in half |
| Word alignment | Browser | Whisper's word times are corrected against the measured pauses (details below) |
| Live edit playback | Browser | The player skips cut ranges in real time on `requestAnimationFrame`, with a `timeupdate` fallback for background tabs. All controls (clock, seek bar, ±5 s, chapters) work on the edited timeline |
| MP4 export | Browser (Web Worker) | WebCodecs + [mediabunny](https://mediabunny.dev): demux → decode → keep only kept samples → re-time onto the edited timeline → encode (H.264/VP9/AV1 + AAC/Opus, negotiated per device) → MP4. Audio is trimmed sample-accurately at every cut |
| Persistence | Server | Owner-only Server Actions validate and store the word transcript and the cut list (`jsonb`). Nothing heavy runs on Vercel |

### Measured results

From test recordings with known pauses, checked against ffmpeg:

- **Pause detection** agrees with `ffmpeg silencedetect` (−40 dB): all 8 of 8 pauses found, every edge within ~60 ms. The differences fall on the safe side: detected pauses start slightly later and end slightly earlier, so speech is never clipped.
- **Whisper timing is wrong in two consistent ways.** It runs **0.2–0.5 s late** (a phrase reported at 23.78 s started at 23.38 s), and the word before a pause **absorbs the pause** ("flow." reported as 3.16–5.96 s while the audio went silent at 3.01 s). Uncorrected, cutting a sentence leaves its first syllable audible, and pause cuts strike through kept words. `refineWords` snaps word edges to the measured pauses. On real Whisper output every word now lands on the right side of every pause, and the fixture lives in `tests/align.test.ts`.
- **Export accuracy:** a 33 s recording edited to 19.33 s exports as 19.313 s video and 19.320 s audio (within 12 ms of the edit). Every tightened pause measures ~0.3 s: the configured 0.12 s of padding on each side plus the detector's safety margin.
- **Speed:** 3.0–3.4 s to render ~19 s of 720p (5–6× real time) in Chromium. Whisper transcribes at ~23× real time (Node, same model) after a one-time ~15 s model load.
- **Why not server-side rendering on Cloudinary?** It was the first approach tried. Cloudinary's splice transformation renders a single splice correctly (10.045 s for a 10 s target), but chained splices of one asset ignore every layer's end offset after the first: 3 segments rendered **26.4 s instead of 15 s**. WebCodecs is exact, free, and uses the viewer's hardware encoder.

### Processing requirements & limitations

- **Browser:** the editor needs WebAssembly and Web Audio (all modern browsers). **Export** needs WebCodecs video *and* audio encoding. It was verified in Chromium; Firefox and Safari ship WebCodecs in recent versions but weren't tested here. Codecs are negotiated per device (H.264 → VP9 → AV1, AAC → Opus), and if the device can't export, the dialog says so. Editing, preview and sharing don't need WebCodecs.
- **Memory:** analysis keeps 16 kHz mono PCM in memory (~3.8 MB/min, ~115 MB for 30 minutes), and export buffers the output MP4 in memory. Practical ceiling: recordings up to ~30–45 minutes.
- **First transcription** downloads the model (Hugging Face Hub) and WASM runtime (jsDelivr), both free CDNs, then serves them from the browser cache.
- **Filler words:** Whisper is trained on cleaned transcripts and usually omits "um"/"uh", so fillers can't be reliably auto-removed. Pause tightening is the dependable tool, and fillers can still be cut by hand on the timeline.
- **Preview precision:** live playback skips cuts within one animation frame (~16 ms) in a visible tab and within ~250 ms in a background tab. The **exported MP4 is frame- and sample-accurate**.
- **Switching pause level** regenerates all automatic pause cuts, discarding per-pause overrides (manual cuts are kept).
- **The original file stays reachable** at its Cloudinary URL. Edits change what SnapCast plays, not the stored asset. Export a file when the removed material must not exist.
- WebGPU inference isn't used: word timestamps on the WebGPU backend weren't verified, and WASM is fast enough for `tiny.en`.

---

## Features

| Feature | Description |
|---|---|
| **One-take editor** | Pause tightening, transcript-based cutting, undo/redo, autosave, live edited playback, on-device MP4 export ([details](#the-one-take-editor)) |
| **Clips** | Select any range in the editor → **Copy clip link** (`?t=12&end=40`, plays just that range with a "Watch full video" chip; seeking past the end switches to the full video) or **Export clip** as an MP4 of only the kept material in it |
| **Navigation** | Library / My videos / Collections in the navbar with an active state (icon-only on phones), and a context-aware **Back** that returns to the previous SnapCast page or, on a deep link, to a sensible parent |
| **On-device transcription** | Whisper with word timestamps for recorded *and* uploaded videos; feeds search, the transcript tab and AI chapters |
| **Screen Recording** | Browser-native MediaRecorder API — no plugins, no extensions |
| **Webcam PiP Overlay** | Canvas API composites circular webcam over screen in real-time |
| **Video Upload** | Direct signed upload to Cloudinary CDN |
| **AI Summary & Tags** | Gemini 2.0 Flash generates summaries and tags from video context |
| **Smart Search** | Full-text search across titles, transcripts, and AI summaries |
| **Privacy Controls** | Public / Private / Link-only visibility per video |
| **Shareable Links** | Time-limited share tokens (7-day expiry) with revocation |
| **AI Chapters** | Gemini auto-generates chapters from the transcript; owner can edit/delete |
| **Auto Transcript** | Web Speech API captures timestamped narration during recording |
| **Timestamped Notes** | Private, per-user notes pinned to moments; click to jump the player |
| **Collections / Playlists** | Group videos into named collections (many-to-many) |
| **Channel Analytics** | Unique viewers, watch time, completion rate, top videos |
| **Processing Status** | Live pill while AI summary & chapters are generated |
| **Google OAuth** | One-click sign-in via better-auth |
| **Custom Player** | Handcrafted controls: buffered seekbar, chapter ticks, speed menu, PiP, fullscreen, keyboard shortcuts, `?t=` deep links |
| **Timestamp Comments** | Threaded discussion pinned to moments; click a timestamp to jump the player |
| **Interactive Transcript** | Click-to-seek segments, live search with highlighting, one-click copy |
| **Recording Studio** | Pause/resume, 3-2-1 countdown, live timer, mic toggle, webcam position/shape/size options |
| **Crash Recovery** | In-progress recordings persist to IndexedDB; restore after a refresh or browser crash |

---

## Architectural Decisions (v2 upgrade)

The platform was upgraded with portfolio-grade features under strict free-tier
constraints (Vercel Hobby, Neon free, Gemini free). Each candidate feature was
evaluated for feasibility; the decisions:

| Feature | Decision | Rationale |
|---|---|---|
| AI Chapters | **Implemented** | Gemini reads the timed transcript → validated JSON chapters; falls back to manual chapters on any failure |
| Auto Transcript | **Implemented (Web Speech API)** | Browser-native, free, timestamped. Server-side transcription (Gemini Files API) would exceed Vercel Hobby's function timeout for large videos. Degrades gracefully on non-Chromium browsers |
| Timestamped Notes | **Implemented** | Pure CRUD, owner-scoped, click-to-seek |
| Playlists | **Implemented** | Many-to-many (`playlists` ↔ `playlist_videos`) with ownership guards |
| Channel Analytics | **Implemented** | `video_views` event table → unique viewers, watch time, completion rate, top videos. Anonymous viewers tracked via a localStorage id |
| Semantic search (pgvector) | **Deferred** | pgvector *is* available on Neon, but per-video embedding generation + a vector column via the HTTP driver adds write-path API cost and bug surface for marginal gain over existing keyword search (title + transcript + summary). Kept keyword search; documented as a clean future swap |
| Video editing | **Implemented, client-side** | Server-side rendering was tried first and measured broken (Cloudinary chained splices ignore end offsets). Whisper, DSP and WebCodecs export run on the user's device, so editing adds **no** server cost and no paid API. The server only authorizes and stores a small cut list |
| Background job queue + cron | **Deferred** | Vercel Hobby cron runs at most **once per day** — useless for processing UX. Processing stays client-triggered with a persisted `processingStatus` field and a live status pill, avoiding Redis/BullMQ/Kafka entirely. An atomic `UPDATE … RETURNING` claim ensures exactly one run per video even when many viewers open it at once, and a run left behind by a crashed function is reclaimable after 2 minutes |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 App Router (RSC + Server Actions) |
| Language | TypeScript 5 |
| Database | Neon PostgreSQL (serverless, free tier) |
| ORM | Drizzle ORM |
| Auth | better-auth + Google OAuth |
| Video Storage | Cloudinary (free tier — 25 GB) |
| AI | Gemini 2.0 Flash via `@google/generative-ai` |
| Styling | Tailwind CSS v4 |
| Deployment | Vercel (free hobby tier) |

---

## Architecture

```
Browser
  ├── Screen capture → MediaRecorder API (WebM/VP9)
  ├── Webcam PiP    → Canvas API (requestAnimationFrame composite)
  ├── Upload        → Signed POST direct to Cloudinary CDN
  └── Editor        → audio rendition → pause detection (DSP)
                      Whisper in a Web Worker → word transcript
                      cut list (EDL) → live skip-playback
                      WebCodecs + mediabunny in a Web Worker → MP4
           │
           ▼
Next.js 15 Server Actions
  ├── Auth          → better-auth + Google OAuth
  ├── DB queries    → Drizzle ORM → Neon PostgreSQL
  ├── AI pipeline   → Gemini 2.0 Flash (summary + tags)
  ├── Edit storage  → owner-only, validated words + cut list (jsonb)
  └── Share tokens  → crypto.randomUUID() + 7-day expiry
           │
           ▼
Cloudinary CDN  ←→  Neon PostgreSQL  ←→  Vercel Edge
```

---

## Engineering Quality

| Practice | Implementation |
|---|---|
| **CI pipeline** | GitHub Actions on every push/PR: type check → unit tests → production build |
| **Unit tests** | 108 Vitest tests: the edit model (EDL math, undo/redo, clip ranges), in-app back navigation, pause detection on synthetic signals, Whisper alignment against real model output, edit-input sanitization, input-validation guards, access-control predicates, and core utilities |
| **Strict builds** | Type and lint errors fail the build (no `ignoreBuildErrors`) |
| **Input validation** | Every server action validates/clamps client input at the network boundary (`lib/validate.ts`) |
| **Authorization** | Ownership checks on all mutations; signed-URL issuance blocked for other users' assets; the editor route and its actions return the same "not found" for missing and not-yours videos |
| **Security headers** | HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy |
| **Image proxy allowlist** | `next/image` restricted to Cloudinary + Google avatars (no open proxy) |
| **Resilience UX** | Global error boundary, branded 404, streaming skeletons with reduced-motion support |
| **Link previews** | Per-video OpenGraph/Twitter cards on share pages (thumbnail + AI summary) |

---

## Database Schema

```sql
videos (
  id uuid PK, video_id text UNIQUE,
  title text, description text,
  video_url text, thumbnail_url text,
  visibility text,                 -- public | private | link-only
  transcript text,
  transcript_segments jsonb,       -- [{time, text}] (timed)
  ai_summary text,
  tags text[],
  chapters jsonb,                  -- [{title, timestamp}]
  words jsonb,                     -- [{text, start, end}] word-level transcript (editor only; never sent to viewers)
  edl jsonb,                       -- {version, cuts: [{start, end, reason}], pauseLevel} in source time
  processing_status text,          -- idle | processing | ready | failed
  processing_started_at timestamp, -- when the current AI run claimed the row
  share_token text UNIQUE,
  share_token_expiry timestamp,
  views integer DEFAULT 0,
  duration integer,
  user_id text FK → user(id)
)

notes (
  id uuid PK, user_id FK, video_id FK,
  timestamp integer, content text, created_at, updated_at
)

playlists (
  id uuid PK, user_id FK, name text, description text
)

playlist_videos (                  -- many-to-many
  id uuid PK, playlist_id FK, video_id FK,
  position integer, UNIQUE(playlist_id, video_id)
)

video_views (                      -- analytics events
  id uuid PK, video_id FK,
  viewer_id FK NULL, anon_id text, -- unique-viewer counting
  watched_seconds integer, completed boolean
)
```

---

## Local Setup

```bash
git clone https://github.com/Udit013/screen_recording_sharing_app.git
cd screen_recording_sharing_app
npm install
cp .env.example .env.local   # fill in values
npx drizzle-kit push         # create DB tables
npm run dev
```

### Required Environment Variables

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | [neon.tech](https://neon.tech) — free |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID/SECRET` | Google Cloud Console |
| `CLOUDINARY_*` | [cloudinary.com](https://cloudinary.com) — free |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) — free |

See [`.env.example`](.env.example) for the full list. The editor needs **no** extra environment variables, API keys or services.

If your database predates the editor, `npx drizzle-kit push` adds the two nullable `jsonb` columns (`words`, `edl`). The change is additive and existing rows are untouched.

---

## Free Tier Summary

| Service | Free Allowance |
|---|---|
| Neon PostgreSQL | 0.5 GB storage, 190 compute hours/month |
| Cloudinary | 25 GB storage + bandwidth/month |
| Gemini 2.0 Flash | 15 RPM, 1M tokens/day |
| Vercel | Unlimited hobby deployments |
| Google OAuth | Free |
| Whisper model + WASM runtime | Free public CDNs (Hugging Face Hub, jsDelivr); cached by each browser |
| Transcription, analysis, export | Run on the user's device: $0 per minute processed |

**Total monthly cost: $0**
