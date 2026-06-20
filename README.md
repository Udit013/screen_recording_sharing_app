# SnapCast — Screen Recording & Video Sharing Platform

> Record your screen, share instantly, powered by AI. Built with Next.js 15, Neon PostgreSQL, Cloudinary, and Gemini 2.0 Flash.

[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel)](https://snapcast-video-sharing.vercel.app)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://typescriptlang.org)

## Live Demo

**[→ snapcast-video-sharing.vercel.app](https://snapcast-video-sharing.vercel.app)**

---

## Features

| Feature | Description |
|---|---|
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
| **Privacy Controls** | Public / Private / Link-only visibility per video |
| **Shareable Links** | Time-limited share tokens (7-day expiry) with revocation |
| **Processing Status** | Live pill while AI summary & chapters are generated |
| **Google OAuth** | One-click sign-in via better-auth |

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
| Background job queue + cron | **Deferred** | Vercel Hobby cron runs at most **once per day** — useless for processing UX. Processing stays client-triggered with a persisted `processingStatus` field and a live status pill, avoiding Redis/BullMQ/Kafka entirely |

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
  └── Upload        → Signed POST direct to Cloudinary CDN
           │
           ▼
Next.js 15 Server Actions
  ├── Auth          → better-auth + Google OAuth
  ├── DB queries    → Drizzle ORM → Neon PostgreSQL
  ├── AI pipeline   → Gemini 2.0 Flash (summary + tags)
  └── Share tokens  → crypto.randomUUID() + 7-day expiry
           │
           ▼
Cloudinary CDN  ←→  Neon PostgreSQL  ←→  Vercel Edge
```

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
  processing_status text,          -- idle | processing | ready | failed
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

See [`.env.example`](.env.example) for the full list.

---

## Free Tier Summary

| Service | Free Allowance |
|---|---|
| Neon PostgreSQL | 0.5 GB storage, 190 compute hours/month |
| Cloudinary | 25 GB storage + bandwidth/month |
| Gemini 2.0 Flash | 15 RPM, 1M tokens/day |
| Vercel | Unlimited hobby deployments |
| Google OAuth | Free |

**Total monthly cost: $0**
