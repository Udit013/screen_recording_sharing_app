# SnapCast — Screen Recording & Video Sharing Platform

> Record your screen, share instantly, powered by AI. Built with Next.js 15, Neon PostgreSQL, Bunny.net CDN, and Gemini 2.0 Flash.

[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel)](https://your-app.vercel.app)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://typescriptlang.org)

## Live Demo

**[→ your-app.vercel.app](https://your-app.vercel.app)**

---

## Features

| Feature | Description |
|---|---|
| **Screen Recording** | Browser-native MediaRecorder API — no plugins, no extensions |
| **Webcam PiP Overlay** | Canvas API composites webcam over screen capture in real-time |
| **Video Upload** | Direct-to-Bunny.net CDN — bypasses server for fast uploads |
| **AI Transcription** | Auto-fetches Bunny captions, stores transcript in Postgres |
| **AI Video Summary** | Gemini 2.0 Flash generates 2-3 sentence summary + tags |
| **Smart Search** | Full-text search across title, transcript, and AI summary |
| **Privacy Controls** | Public / Private / Link-only visibility modes |
| **Shareable Links** | Time-limited (7-day) share tokens with revocation |
| **Video Chapters** | Add clickable timestamp markers — seek directly to chapters |
| **View Analytics** | Per-video view count, tracked server-side |
| **Google OAuth** | Sign in with Google via better-auth |
| **Rate Limiting** | Arcjet shields all API routes and upload actions |
| **Responsive UI** | Mobile-first Tailwind CSS v4 design |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         BROWSER                                 │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ RecordScreen │  │  VideoPlayer  │  │  VideoInfo             │ │
│  │ (Canvas PiP) │  │ (Bunny iframe)│  │  Transcript/AI/Chapters│ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬────────────┘ │
│         │                 │                       │              │
└─────────┼─────────────────┼───────────────────────┼─────────────┘
          │                 │                       │
          ▼                 ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                      NEXT.JS 15 SERVER                          │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  middleware   │  │Server Actions│  │  API Routes            │ │
│  │  (Arcjet +   │  │  video.ts    │  │  /api/auth/[...all]    │ │
│  │   Auth check)│  │  (all CRUD)  │  │  (better-auth)         │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬────────────┘ │
│         │                 │                       │              │
└─────────┼─────────────────┼───────────────────────┼─────────────┘
          │                 │                       │
   ┌──────▼──────┐  ┌───────▼─────┐  ┌─────────────▼──────────┐
   │   Arcjet    │  │    Neon      │  │      Bunny.net          │
   │ (Rate limit │  │  PostgreSQL  │  │  Stream (video) +       │
   │  Bot detect)│  │  (Drizzle)   │  │  Storage (thumbnails)   │
   └─────────────┘  └──────┬───────┘  └────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │  Gemini 2.0 │
                    │  Flash API  │
                    │ (AI summary)│
                    └─────────────┘
```

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Framework** | Next.js 15 (App Router) | Server actions, RSC, streaming |
| **Language** | TypeScript 5 | End-to-end type safety |
| **Database** | Neon PostgreSQL (free) | Serverless Postgres, no vendor lock-in |
| **ORM** | Drizzle ORM | Type-safe, lightweight, edge-compatible |
| **Auth** | better-auth + Google OAuth | Open source, self-hosted auth |
| **Video CDN** | Bunny.net Stream | Global delivery, iframe embed player |
| **Thumbnails** | Bunny.net Storage | Pay-as-you-go CDN storage |
| **AI** | Gemini 2.0 Flash (Google) | Free tier, 1M tokens/day |
| **Security** | Arcjet | Rate limiting, bot detection, shield |
| **Styling** | Tailwind CSS v4 | Utility-first, fast build |
| **Deployment** | Vercel (free) | Zero-config Next.js hosting |

---

## Key Engineering Decisions

### 1. Direct-to-CDN Uploads
Video files are uploaded **directly from the browser to Bunny.net** — the Next.js server only provides a pre-authorized upload URL. This sidesteps the Vercel 4.5 MB request body limit and keeps server bandwidth cost at zero.

### 2. Lazy DB & Arcjet Initialization
Both the Neon database client and Arcjet instance are initialized via a `Proxy` pattern that defers the actual connection until the first query. This allows `next build` to succeed without environment variables, which is essential for CI/CD pipelines and zero-config deployments.

### 3. Canvas-Based Webcam PiP
Instead of an external service, we composite the screen capture and webcam streams onto an `HTMLCanvasElement` at 30fps using `requestAnimationFrame`, then record the canvas output via `MediaRecorder`. The result is a native WebM file with a circular webcam overlay — zero dependencies, zero latency.

### 4. Graceful AI Degradation
AI features (transcript, summary, tags) are completely optional. If `GEMINI_API_KEY` is absent or Bunny auto-captions are not enabled, the app behaves identically — AI fields are null and the UI shows a placeholder. No runtime errors.

### 5. Share Token Architecture
Share tokens are `crypto.randomUUID()` values stored with an expiry timestamp directly in the `videos` row. The `/share/[token]` route is excluded from the auth middleware matcher, allowing unauthenticated users to view shared videos. Tokens can be revoked by the owner at any time, which sets the DB field to null and instantly invalidates all existing links.

---

## Local Setup

### Prerequisites
- Node.js 20+
- A [Neon](https://neon.tech) account (free, no credit card)
- A [Bunny.net](https://bunny.net) account
- Google Cloud project with OAuth 2.0 credentials
- [Arcjet](https://arcjet.com) account (free)
- Google AI Studio API key (free, optional — enables AI features)

### Steps

```bash
# 1. Clone
git clone https://github.com/Udit013/screen_recording_sharing_app.git
cd screen_recording_sharing_app

# 2. Install
npm install

# 3. Configure environment
cp .env.example .env.local
# Fill in all values — see .env.example for step-by-step instructions

# 4. Push the database schema to Neon
npx drizzle-kit push

# 5. Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment Variables

See [`.env.example`](./.env.example) for the full list. Required:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | [neon.tech](https://neon.tech) → Project → Connection string |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | [console.cloud.google.com](https://console.cloud.google.com) |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BUNNY_LIBRARY_ID` / `BUNNY_STREAM_ACCESS_KEY` | Bunny → Stream → Library |
| `BUNNY_STORAGE_ACCESS_KEY` | Bunny → Storage → Zone |
| `BUNNY_STORAGE_ZONE_URL` | Bunny Storage endpoint URL |
| `BUNNY_CDN_URL` | Your Bunny pull-zone URL |
| `ARCJET_API_KEY` | [arcjet.com](https://arcjet.com) |
| `NEXT_PUBLIC_BASE_URL` | `http://localhost:3000` for dev |
| `NEXT_PUBLIC_BUNNY_LIBRARY_ID` | Same as `BUNNY_LIBRARY_ID` |

Optional (AI features):

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) — free tier |
| `BUNNY_TRANSCRIPT_BASE_URL` | Bunny CDN pull-zone that serves auto-captions |

### Deploy to Vercel

```bash
npm i -g vercel
vercel                    # initial deploy
vercel env add DATABASE_URL production
# add all other env vars...
vercel --prod             # redeploy with env vars
```

Set the Google OAuth redirect URI to: `https://your-app.vercel.app/api/auth/callback/google`

---

## Database Schema

```sql
videos (
  id                  UUID PRIMARY KEY,
  title               TEXT,
  description         TEXT,
  video_url           TEXT,          -- Bunny embed URL
  video_id            TEXT UNIQUE,   -- Bunny video GUID
  thumbnail_url       TEXT,
  visibility          TEXT,          -- 'public' | 'private' | 'link-only'
  user_id             TEXT → user,
  views               INTEGER DEFAULT 0,
  duration            INTEGER,       -- seconds
  transcript          TEXT,          -- plain text from VTT
  ai_summary          TEXT,          -- Gemini 2.0 Flash output
  tags                TEXT[],        -- AI-generated tags
  share_token         TEXT UNIQUE,   -- time-limited UUID
  share_token_expiry  TIMESTAMP,
  chapters            JSONB          -- [{title: string, timestamp: number}]
)
```

---

## Free Tier Summary

| Service | Free Limit | Billing Risk |
|---|---|---|
| Neon PostgreSQL | 0.5 GB storage, 190 compute-hours/month | None — pauses when idle |
| Vercel | 100 GB bandwidth/month | None |
| Arcjet | 10,000 requests/month | None |
| Google OAuth | Unlimited | None |
| Gemini 2.0 Flash | 15 RPM, 1M tokens/day | None |
| Bunny.net | Pay-per-use (no free tier) | ~$0.01/GB — minimal for portfolio |

---

*Built by [Udit Agarwal](https://github.com/Udit013)*
