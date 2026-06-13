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
| **Video Chapters** | Owner can add clickable chapter timestamps |
| **View Analytics** | View count tracked per video |
| **Google OAuth** | One-click sign-in via better-auth |

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
  visibility text,              -- public | private | link-only
  transcript text,
  ai_summary text,
  tags text[],
  chapters jsonb,               -- [{title, timestamp}]
  share_token text UNIQUE,
  share_token_expiry timestamp,
  views integer DEFAULT 0,
  duration integer,
  user_id text FK → user(id)
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
