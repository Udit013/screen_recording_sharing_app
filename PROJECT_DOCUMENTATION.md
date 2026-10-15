# SnapCast — Complete Technical Documentation

*A screen recorder with a one-take editor (transcript-based cutting, pause tightening, on-device MP4 export), AI transcription, and video sharing, built with Next.js 15.*

This document is the single source of truth for understanding this codebase — from "what problem does this solve" all the way down to "what does line X of file Y do, and why." It's written for four audiences at once: **you**, preparing for a technical interview; **a recruiter**, trying to understand what you built; **a new developer**, onboarding onto this code; and **anyone**, with zero programming background, trying to understand how the app works.

Every claim in this document is grounded in the actual code in this repository as of the last update. Nothing here is aspirational or generic.

---

## Table of Contents

1. [The Story: What This Project Is](#1-the-story-what-this-project-is)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Folder Structure](#3-folder-structure)
4. [Database Deep Dive](#4-database-deep-dive)
5. [Authentication Deep Dive](#5-authentication-deep-dive)
6. [The Recording Engine](#6-the-recording-engine)
7. [The Upload Pipeline](#7-the-upload-pipeline)
8. [The AI Pipeline (Gemini)](#8-the-ai-pipeline-gemini)
9. [The Custom Video Player](#9-the-custom-video-player)
10. [Collaboration Features (Comments & Notes)](#10-collaboration-features-comments--notes)
11. [Collections (Playlists)](#11-collections-playlists)
12. [Analytics](#12-analytics)
13. [Sharing & Privacy](#13-sharing--privacy)
14. [Search](#14-search)
15. [Every Page, File by File](#15-every-page-file-by-file)
16. [Every Component, File by File](#16-every-component-file-by-file)
17. [Every Custom Hook](#17-every-custom-hook)
18. [Every Server Action (API Layer)](#18-every-server-action-api-layer)
19. [State Management Strategy](#19-state-management-strategy)
20. [Every Library and Why It's There](#20-every-library-and-why-its-there)
21. [Every Configuration File](#21-every-configuration-file)
22. [Security Model](#22-security-model)
23. [Testing & CI](#23-testing--ci)
24. [Concept Deep Dives (Beginner → Advanced)](#24-concept-deep-dives-beginner--advanced)
25. [Complete User-Action Traces](#25-complete-user-action-traces)
26. [Interview Question Bank](#26-interview-question-bank)
27. [Full Walkthrough: A Day in the Life of a Video](#27-full-walkthrough-a-day-in-the-life-of-a-video)
28. [The One-Take Editor](#28-the-one-take-editor)

---

## 1. The Story: What This Project Is

### 1.1 What problem does this solve?

Explaining a bug, a workflow, or an idea in a Slack message is slow and lossy. Screenshots lose motion. Text loses tone. The fastest way to explain something on a computer is to **show it moving, with your voice narrating it**, and let the other person watch whenever they want.

That's what a "Loom-style" tool is: you press record, your screen (and optionally your face, in a little bubble) gets captured, you talk while you work, and a minute later you have a shareable link. The recipient doesn't need an account, doesn't need to download anything — they click and watch.

SnapCast is a from-scratch implementation of that idea, plus the features a *daily-use* tool actually needs once the novelty wears off: **searchable transcripts** (so a 10-minute video isn't a black box), **AI summaries and chapters** (so nobody has to watch the whole thing to know what's in it), **timestamped comments and notes** (so feedback attaches to the exact moment it's about), and **privacy controls** (so not every video is public by default).

Its sharpest feature targets the most common pain of the people who record the most: **re-recording**. The one-take editor ([§28](#28-the-one-take-editor)) lets you record without rehearsing, then tighten every pause and delete flubbed sentences by deleting their words from the transcript. Transcription, audio analysis and MP4 export all run in the browser, so editing costs nothing to operate.

### 1.2 Who is it built for?

Anyone who currently sends a text explanation and thinks "a video would be faster" — engineers explaining a bug to a teammate, a manager giving feedback on a design, a teacher recording a walkthrough. The product doesn't assume a team or a company; a single user with a Google account can record, upload, and share within seconds.

### 1.3 What happens when a user opens the application?

At the highest level, before any code runs:

```
User types the URL into a browser
        │
        ▼
Next.js server (running on Vercel) receives the HTTP request
        │
        ▼
middleware.ts intercepts the request FIRST, before any page renders
        │
        ├── No session cookie? → redirect to /sign-in
        └── Valid session?    → let the request continue
        │
        ▼
The matched page's Server Component runs on the server
        │
        ├── Queries the database (Neon Postgres, via Drizzle ORM)
        └── Renders HTML with the data already embedded
        │
        ▼
HTML (already containing the video grid, not a loading spinner) is sent to the browser
        │
        ▼
The browser paints the HTML immediately, then "hydrates" —
React attaches event listeners so buttons/links become interactive
        │
        ▼
User sees a fully-rendered page and can click, search, or record
```

This is the crux of what makes Next.js's **App Router** different from a classic React single-page app: the very first HTML the browser receives already has the videos in it. There's no "Loading..." flash while an API call resolves client-side — the server did that work before responding.

### 1.4 What happens behind the scenes when someone records a video?

This is the part unique to this product, so it's worth walking before we go deeper into the architecture:

1. The user clicks **Record a video**. A modal (`RecordScreen.tsx`) opens with options: microphone on/off, webcam overlay on/off, and (if webcam is on) where the little bubble sits, what shape it is, and how big.
2. They click **Record**. A 3-2-1 countdown plays, then the browser's **native screen-picker UI** appears (this is not custom-built — it's the browser's own permission dialog, triggered by `getDisplayMedia()`).
3. The user picks a screen/window/tab to share. Recording begins immediately.
4. If webcam is on, the browser draws the screen and the webcam feed onto an invisible `<canvas>` element 30 times a second, composites them into one picture (screen as background, circular or rounded webcam bubble on top), and it's *that* composited canvas — not the raw screen — that gets recorded.
5. If the microphone is on, the browser's built-in **Web Speech API** listens in parallel and transcribes speech to text live, tagging each sentence with a timestamp.
6. The user clicks **Stop**. The recording (a `Blob` — a chunk of binary video data sitting in the browser's memory) is immediately available for preview.
7. The user clicks **Continue to Upload**, fills in a title/description, and submits.
8. The browser uploads the video **directly to Cloudinary** (a video-hosting service) — it does not pass through this app's own server at all, because video files are large and proxying them would be slow and expensive.
9. Once Cloudinary confirms the upload, this app's server saves a small database record (title, Cloudinary URL, owner, privacy setting).
10. The video page calls an AI-processing action, which asks Google's Gemini model to read the transcript (if there is one) and generate a summary, tags, and chapter markers.
11. The page is now live and shareable.

Every one of these steps is implemented in a real file, and the rest of this document walks through each one in depth.

---

## 2. High-Level Architecture

### 2.1 The 30,000-foot view

```text
┌─────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ MediaRecorder │  │ Web Speech   │  │  React Client Components  │  │
│  │ + Canvas API  │  │ API (STT)    │  │  (player, comments, etc.) │  │
│  └──────┬───────┘  └──────┬───────┘  └─────────────┬─────────────┘  │
└─────────┼──────────────────┼──────────────────────┼─────────────────┘
          │ video bytes       │ transcript            │ Server Action calls
          ▼                   │ (saved via action)     │ (RPC-style, over HTTPS)
  ┌───────────────┐            │                       │
  │  Cloudinary   │            │                       ▼
  │  (video CDN)  │            │        ┌─────────────────────────────┐
  └───────┬───────┘            │        │   Next.js 15 App Router     │
          │ signed upload      │        │   (Vercel serverless)       │
          │ (browser → CDN     │        │                             │
          │  directly)         │        │  middleware.ts (auth gate)  │
          │                    │        │  Server Components (pages)  │
          │                    └───────►│  Server Actions ("use       │
          │                             │    server" functions)       │
          │                             └──────────────┬──────────────┘
          │                                             │
          │  URL saved back                             │ SQL over HTTP
          ▼                                             ▼
┌───────────────────────┐                    ┌─────────────────────────┐
│   Google Gemini API    │◄───────────────────│   Neon PostgreSQL        │
│  (summary/tags/        │   transcript text  │   (serverless Postgres,  │
│   chapters generation) │──────────────────► │    via Drizzle ORM)      │
└───────────────────────┘   AI results        └─────────────────────────┘
                                                        ▲
                                              ┌─────────┴─────────┐
                                              │   better-auth      │
                                              │ (Google OAuth,     │
                                              │  sessions, cookies)│
                                              └────────────────────┘
```

### 2.2 The pieces, in plain English

| Layer | What it is | Why this choice |
|---|---|---|
| **Client** | React 19 components running in the browser | Interactivity — video playback controls, live recording state, forms |
| **Framework** | Next.js 15 (App Router) | Server Components let pages fetch data *before* sending HTML, eliminating client-side loading spinners on first load |
| **Server logic** | Next.js Server Actions (`"use server"` functions) | No separate REST/GraphQL API layer needed — a client component can call a server function directly, and Next.js handles the network call |
| **Database** | Neon (serverless Postgres) | Free tier, scales to zero when idle, standard SQL/Postgres semantics |
| **ORM** | Drizzle ORM | Type-safe SQL query builder — the compiler catches a typo'd column name before it ever reaches the database |
| **Auth** | better-auth + Google OAuth | Session/cookie/OAuth handling is security-critical and easy to get wrong; this delegates it to a maintained library instead of writing it from scratch |
| **Video storage/CDN** | Cloudinary | Free tier, handles video transcoding, thumbnail generation, and global delivery — this app would otherwise need its own file storage and CDN |
| **AI** | Google Gemini 2.0 Flash | Free tier, fast, cheap, good enough for summarization-class tasks (this is not a chat assistant — it's called once per video, not conversationally) |
| **Speech-to-text** | Browser-native Web Speech API | $0 cost, zero backend infrastructure, works entirely client-side during recording |
| **Deployment** | Vercel | Native Next.js hosting, automatic HTTPS, serverless functions for Server Actions |

### 2.3 Deployment architecture

There is no traditional "backend server" running 24/7. Every server-side piece of this app is a **serverless function**: Vercel spins up a small isolated process to handle one request (e.g., one Server Action call), runs it, returns the result, and the process can disappear. This is why the database connection (`drizzle/db.ts`) is created **lazily** — see [§21.2](#213-drizzledbts) — a serverless function shouldn't try to open a database connection the instant its file is imported, only when a request actually needs it.

---

## 3. Folder Structure

```text
screen_recording_sharing_app/
├── app/                      # Next.js App Router — pages, layouts, routes
│   ├── (auth)/sign-in/       # Route group: the sign-in page (no shared UI chrome)
│   ├── (root)/               # Route group: every page that shows the Navbar
│   │   ├── layout.tsx         #   wraps children with <Navbar/>
│   │   ├── page.tsx           #   "/" — public video library
│   │   ├── upload/            #   "/upload" — upload form
│   │   ├── video/[videoId]/   #   "/video/xyz" — video detail page
│   │   ├── profile/[id]/      #   "/profile/xyz" — a user's channel
│   │   ├── playlists/         #   "/playlists" — collections list + detail
│   │   └── loading.tsx        #   shared loading skeleton
│   ├── api/auth/[...all]/    # better-auth's HTTP handler (OAuth callbacks etc.)
│   ├── share/[token]/        # "/share/xyz" — public, token-gated video view
│   ├── layout.tsx            # Root HTML document, fonts, global <head> metadata
│   ├── globals.css           # All styling (Tailwind v4 + custom component classes)
│   ├── error.tsx             # Global error boundary
│   └── not-found.tsx         # Custom 404 page
│
├── components/                # All React components (both server and client)
├── lib/                       # Everything that isn't a component
│   ├── actions/                #   Server Actions — the entire "backend API"
│   ├── hooks/                  #   Custom React hooks
│   ├── auth.ts, auth-client.ts #   better-auth server/client setup
│   ├── cloudinary.ts           #   Signed-upload helper
│   ├── gemini.ts                #   AI summary/chapter generation
│   ├── speech.ts                #   Web Speech API wrapper
│   ├── recordingStore.ts        #   IndexedDB crash-recovery persistence
│   ├── anon.ts                  #   Anonymous-viewer id (localStorage)
│   ├── validate.ts              #   Input validation/sanitization helpers
│   └── utils.ts                  #   General-purpose helpers (formatting, media APIs)
│
├── drizzle/                   # Database layer
│   ├── schema.ts                #   Every table definition (the "source of truth" schema)
│   └── db.ts                    #   Lazily-initialized DB client
│
├── constants/index.ts         # App-wide constant values (limits, config objects)
├── index.d.ts                 # Global ambient TypeScript types (no imports needed)
├── middleware.ts              # Runs before every page request — the auth gate
├── tests/                     # Vitest unit tests
├── fonts/                     # Local font files + font loader config
└── (config files at root)     # next.config.ts, drizzle.config.ts, tsconfig.json, etc.
```

### Why this organization?

- **`app/` mirrors the URL structure.** In the Next.js App Router, folders *are* routes. `app/(root)/video/[videoId]/page.tsx` literally means "the page at `/video/:videoId`." The parentheses in `(auth)` and `(root)` are "route groups" — they organize files without adding a URL segment, used here purely to give `(root)` pages a shared `<Navbar>` via its own `layout.tsx` while `(auth)/sign-in` has none.
- **`lib/actions/` is the entire backend API**, one file per feature domain (video, comments, notes, playlists, analytics). This avoids a single 1000-line file and mirrors how a REST API might be split into controllers — except there's no separate REST layer at all (see [§18](#18-every-server-action-api-layer) and [§24.6](#246-rest-apis-vs-server-actions)).
- **`components/` is flat**, not nested by feature. With ~19 components this is manageable; splitting into `components/video/`, `components/playlist/` etc. would be premature structure for this size of app.
- **`drizzle/schema.ts` is the single file that defines every table.** Keeping all tables in one file (rather than one file per table) means every foreign-key relationship is visible in one scroll — important in a schema where almost every table references `videos`.
- **`index.d.ts` holds every prop-interface and shared type**, declared globally (via `declare global { ... }`) so that no component needs an `import type` line for its own props. This is a deliberate, somewhat unusual choice — see [§21.5](#215-indexdts) for the trade-off.

---

## 4. Database Deep Dive

### 4.1 Why Postgres, and why Drizzle?

**Simple explanation:** A database is a filing cabinet that remembers things even after you close the app. Postgres is one specific, very reliable brand of filing cabinet that's good at keeping *related* facts consistent — e.g., making sure a comment never points to a video that doesn't exist.

**Technical explanation:** This app's data is inherently relational — a video *has* comments, notes, view events, and can belong to *many* playlists (and a playlist can hold *many* videos). That many-to-many shape, plus the need for foreign-key integrity (deleting a video should also delete its comments), points at a relational database over a NoSQL document store. **Neon** is chosen specifically because it's serverless Postgres with a genuinely free tier and an HTTP-based driver (`@neondatabase/serverless`) that works from Vercel's serverless functions without needing a persistent TCP connection pool.

**Drizzle ORM** is the layer between TypeScript code and raw SQL. Instead of writing `SELECT * FROM videos WHERE video_id = $1` as a string, you write:

```ts
db.select().from(videos).where(eq(videos.videoId, videoId))
```

The payoff: `videos.videoId` is a real TypeScript property. If you typo it as `videos.videoID`, the compiler catches it *before* you ever run the code — a raw SQL string can't offer that.

### 4.2 The complete schema

All eight tables live in **`drizzle/schema.ts`**. Here's each one, why it exists, and how it relates to the others.

```text
user ──┬──< session          (one user, many login sessions)
       ├──< account          (one user, many linked OAuth accounts)
       ├──< videos           (one user, many videos they own)
       ├──< notes            (one user, many personal notes)
       ├──< playlists        (one user, many collections)
       └──< comments         (one user, many comments authored)

videos ──┬──< notes             (one video, many notes on it)
         ├──< comments          (one video, many comments)
         ├──< video_views       (one video, many watch-session logs)
         └──< playlist_videos   (one video, can be in many playlists)

playlists ──< playlist_videos   (one playlist, many video memberships)
```

#### `user`, `session`, `account`, `verification`

These four tables are **not hand-designed** — they're the exact schema shape that **better-auth** (the auth library) requires. `user` stores the profile (name, email, avatar); `session` stores active login sessions (with an expiry and the token that lives in the browser's cookie); `account` stores the link to the Google OAuth account (access/refresh tokens); `verification` is used internally by better-auth for things like email verification flows (not currently exercised, since Google is the only sign-in method, but the table is part of the library's required schema).

#### `videos` — the central table

```ts
export const videos = pgTable("videos", {
  id: uuid("id").primaryKey().defaultRandom().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  videoUrl: text("video_url").notNull(),
  videoId: text("video_id").notNull().unique(),   // Cloudinary's id, used in URLs
  thumbnailUrl: text("thumbnail_url").notNull(),
  visibility: text("visibility").$type<"public"|"private"|"link-only">()...,
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  views: integer("views").notNull().default(0),
  duration: integer("duration"),
  transcript: text("transcript"),
  transcriptSegments: jsonb("transcript_segments").$type<TranscriptEntry[]>()...,
  aiSummary: text("ai_summary"),
  tags: text("tags").array().default([]),
  shareToken: text("share_token").unique(),
  shareTokenExpiry: timestamp("share_token_expiry"),
  chapters: jsonb("chapters").$type<Chapter[]>().default([]),
  processingStatus: text("processing_status").$type<"idle"|"processing"|"ready"|"failed">()...,
  processingStartedAt: timestamp("processing_started_at"),   // when the current AI run claimed the row
  words: jsonb("words").$type<Word[]>(),                     // word-level transcript (editor only, §28.6)
  edl: jsonb("edl").$type<StoredEdl>(),                      // the edit: source-time cut list (§28.3)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

Notice two different **id-like columns**: `id` is an internal UUID Postgres generates automatically (`defaultRandom()`), used purely as the row's primary key. `videoId` is a *different*, app-generated UUID (`crypto.randomUUID()` — see `getVideoUploadUrl` in [§18.1](#181-libactionsvideots)) that doubles as the Cloudinary asset name **and** the URL segment (`/video/<videoId>`). They're kept distinct on purpose: the primary key should never need to double as a public-facing identifier that appears in URLs and third-party services.

**Why JSONB for `transcriptSegments` and `chapters` instead of separate tables?** Both are small, ordered lists that are *always* read and written together with their parent video — you never query "give me all chapters across all videos" independently. Normalizing them into their own tables would mean an extra `JOIN` on every single video-detail page load, for a feature that never needs relational querying. This is a deliberate trade-off (see [§24.11](#2411-database-normalization-vs-denormalization)), not an oversight — contrast with `comments`, `notes`, and `video_views`, which genuinely *are* separate tables because they have their own independent lifecycle (a comment has an author who isn't the video's owner; you delete one comment without touching others).

**`processingStatus`** exists because AI enrichment (Gemini call) happens *after* the video record is first created, not during. A value of `"idle"` means AI hasn't run yet; `"processing"` while the Gemini call is in flight; `"ready"` once summary/tags/chapters are saved; `"failed"` if the Gemini call threw. The UI polls this implicitly by re-fetching the video after `processVideoAI` resolves — see [§18.1](#181-libactionsvideots).

`processingStartedAt` records when the current run *claimed* the row. It exists because the claim is atomic (see [§8.2](#82-processvideoai--orchestrating-the-ai-step)): the first viewer of a new video wins the claim, and every concurrent viewer sees `"processing"` and backs off instead of starting a duplicate Gemini run. If a serverless invocation dies mid-run, the row would otherwise stay `"processing"` forever, so a claim older than 2 minutes (well above Vercel's 60-second function limit) may be reclaimed. It's a dedicated column rather than `updatedAt` because a modification time must not move when nothing was modified.

#### `notes` — private, per-viewer

```ts
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  videoId: text("video_id").notNull().references(() => videos.videoId, { onDelete: "cascade" }),
  timestamp: integer("timestamp").notNull().default(0),
  content: text("content").notNull(),
  createdAt: timestamp(...).notNull().defaultNow(),
  updatedAt: timestamp(...).notNull().defaultNow(),
});
```

Notes are **private to the author** — `getNotes` (in `lib/actions/notes.ts`) filters by `eq(notes.userId, session.user.id)`, so no other viewer, not even the video's owner, ever sees another person's notes. This is the key distinction from `comments`, which are public.

#### `playlists` and `playlist_videos` — a many-to-many relationship

```ts
export const playlists = pgTable("playlists", {
  id: uuid(...).primaryKey().defaultRandom(),
  userId: text(...).notNull().references(() => user.id, ...),
  name: text(...).notNull(),
  description: text(...),
  ...
});

export const playlistVideos = pgTable("playlist_videos", {
  id: uuid(...).primaryKey().defaultRandom(),
  playlistId: uuid(...).notNull().references(() => playlists.id, { onDelete: "cascade" }),
  videoId: text(...).notNull().references(() => videos.videoId, { onDelete: "cascade" }),
  position: integer(...).notNull().default(0),
  addedAt: timestamp(...).notNull().defaultNow(),
});
```

A playlist can contain many videos, and a single video can belong to many playlists (e.g., "Interview Prep" and "Favorites" simultaneously). Neither table can express that alone — you need a **junction table** in between. `playlist_videos` is exactly that: each row is one (playlist, video) pairing. `position` lets videos be manually ordered within a playlist.

#### `comments` — public, threaded discussion

```ts
export const comments = pgTable("comments", {
  id: uuid(...).primaryKey().defaultRandom(),
  videoId: text(...).notNull().references(() => videos.videoId, { onDelete: "cascade" }),
  userId: text(...).notNull().references(() => user.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),          // NOT a foreign key constraint in the schema
  timestamp: integer("timestamp"),       // nullable — a comment can be general or pinned
  content: text(...).notNull(),
  createdAt: timestamp(...).notNull().defaultNow(),
  updatedAt: timestamp(...).notNull().defaultNow(),
});
```

`parentId` implements **single-level threading**: a top-level comment has `parentId: null`; a reply has `parentId` set to the comment it's replying to. The server action `addComment` (in `lib/actions/comments.ts`) explicitly checks `if (parent.parentId) throw new Error("Replies cannot be nested further")` — so a reply-to-a-reply is rejected, keeping the UI to two visual levels (comment, then its replies) rather than infinite nesting.

`timestamp` is nullable because a comment can either be pinned to a moment in the video (like "at 1:32, this part was confusing") or be a general comment with no specific timestamp.

#### `video_views` — the analytics event log

```ts
export const videoViews = pgTable("video_views", {
  id: uuid(...).primaryKey().defaultRandom(),
  videoId: text(...).notNull().references(() => videos.videoId, { onDelete: "cascade" }),
  viewerId: text("viewer_id").references(() => user.id, { onDelete: "set null" }),
  anonId: text("anon_id"),
  watchedSeconds: integer(...).notNull().default(0),
  completed: boolean(...).notNull().default(false),
  createdAt: timestamp(...).notNull().defaultNow(),
});
```

This is a genuinely separate mechanism from `videos.views` (the simple incrementing counter). See [§12](#12-analytics) for the full explanation of why both exist side by side.

### 4.3 How records are created, read, updated, deleted

Every one of these operations happens through **Drizzle's query builder**, inside a Server Action, never directly from the browser. A few representative examples (all real code, trimmed):

**Create** (`lib/actions/video.ts`, `saveVideoDetails`):
```ts
await db.insert(videos).values({ title, description, videoId, videoUrl, ... });
```

**Read with a `JOIN`** (`lib/actions/video.ts`, `buildVideoWithUserQuery`):
```ts
db.select({ video: videos, user: { id: user.id, name: user.name, image: user.image } })
  .from(videos)
  .leftJoin(user, eq(videos.userId, user.id));
```
This fetches a video **and** its owner's public profile fields in a single query — avoiding the classic "N+1 query" mistake of fetching videos, then separately fetching each owner one by one.

**Two read shapes, deliberately.** `buildVideoWithUserQuery` selects the *whole* row and is used only by single-video pages (`getVideoById`, `getVideoByShareToken`), which render the transcript, chapters, and summary. List views (`getAllVideos`, `getAllVideosByUser`) use `buildVideoCardQuery`, which selects only the eight fields a `VideoCard` renders:
```ts
db.select({
  video: { id, videoId, title, thumbnailUrl, visibility, views, duration, createdAt },  // from `videos`
  user: { id: user.id, name: user.name, image: user.image },
}).from(videos).leftJoin(user, eq(videos.userId, user.id));
```
Selecting the full row in a list pulled every video's transcript, timed segments, and AI summary for cards that display none of them. Measured on the current data, that was 3,095 bytes fetched versus 1,123 rendered (2.76×). The absolute difference is small today, but the excess scales with recording length (the app's own limits allow roughly 4 MB of transcript per video) while a card stays a few hundred bytes, and the profile listing isn't paginated. Search still works: a `WHERE` clause can filter on `transcript`/`aiSummary` without those columns being selected.

**Update** (`lib/actions/video.ts`, `updateVideoVisibility`):
```ts
await db.update(videos)
  .set({ visibility, updatedAt: new Date() })
  .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));
```
Notice the `where` clause checks **both** the video id *and* the requesting user's id — this is the authorization check baked directly into the query. If a different user's id doesn't match, zero rows are updated. This pattern repeats throughout the codebase — see [§22](#22-security-model).

**Delete** (`lib/actions/video.ts`, `deleteVideo`):
```ts
await db.delete(videos).where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));
```
Because every child table (`notes`, `comments`, `video_views`, `playlist_videos`) declared its foreign key with `{ onDelete: "cascade" }`, deleting a video row causes Postgres itself to automatically delete every note, comment, view event, and playlist-membership row that referenced it — no application code has to remember to clean those up manually.

---

## 5. Authentication Deep Dive

### 5.1 The library: better-auth

**Simple explanation:** Authentication is how the app knows "this browser belongs to Udit, not to a stranger." Instead of building a password system from scratch (which is genuinely hard to do securely), this app uses **better-auth**, a library that handles the entire login flow, and lets users sign in with their existing **Google account** instead of creating a new password.

**Technical explanation:** better-auth is configured once, in `lib/auth.ts`:

```ts
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: schema }),
  socialProviders: {
    google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
  },
  plugins: [nextCookies()],
  baseURL: process.env.NEXT_PUBLIC_BASE_URL,
});
```

- `drizzleAdapter(db, ...)` tells better-auth to store sessions/accounts/users in *this app's own* Postgres database (the `user`, `session`, `account`, `verification` tables from [§4.2](#42-the-complete-schema)) rather than a separate auth-provider database.
- `socialProviders.google` is the *only* sign-in method — there's no email/password form anywhere in this app.
- `nextCookies()` is a plugin that makes better-auth automatically set/read the session cookie in a way compatible with Next.js's server/client boundary — without it, a Server Action couldn't reliably set a cookie that the next page load would see.

### 5.2 The two sides: server and client

- **`lib/auth.ts`** — the *server-side* instance. Used inside Server Actions and Server Components to check `auth.api.getSession({ headers })`.
- **`lib/auth-client.ts`** — the *client-side* instance:
  ```ts
  export const authClient = createAuthClient({ baseURL: process.env.NEXT_PUBLIC_BASE_URL });
  ```
  Used inside `"use client"` components via the `authClient.useSession()` React hook (a live, reactive read of "who's logged in right now"), and to trigger sign-in/sign-out: `authClient.signIn.social({ provider: "google" })` (in `sign-in/page.tsx`) and `authClient.signOut(...)` (in `Navbar.tsx`).

### 5.3 The login flow, traced end to end

```
User clicks "Sign in with Google" (app/(auth)/sign-in/page.tsx)
        │
        ▼
authClient.signIn.social({ provider: "google" })
        │
        ▼
Browser is redirected to Google's OAuth consent screen
        │
        ▼
User approves → Google redirects back to:
  /api/auth/callback/google  (handled by app/api/auth/[...all]/route.ts)
        │
        ▼
better-auth's handler (toNextJsHandler(auth.handler)) validates the OAuth
code with Google, creates/updates a `user` row and an `account` row,
creates a `session` row, and sets an HttpOnly session cookie
        │
        ▼
Browser is redirected to "/" — the cookie now travels with every
subsequent request automatically
```

### 5.4 Protected routes: the middleware

**`middleware.ts`** runs on the server **before** any page component executes, for every request that matches its `config.matcher`:

```ts
export async function middleware(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.redirect(new URL("/sign-in", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sign-in|assets|share).*)"],
};
```

The `matcher` is a regular expression meaning "match every path *except* those starting with `api`, `_next/static`, `_next/image`, `favicon.ico`, `sign-in`, `assets`, or `share`." In plain terms: **every page requires login except the sign-in page itself, static assets, and the public `/share/[token]` pages** (which have their own, separate authorization mechanism — the token itself, see [§13](#13-sharing--privacy)).

This is a **blanket, all-or-nothing gate**: it doesn't know or care *which* page is being requested, only whether a session exists. Fine-grained authorization (e.g., "can this user delete *this specific* video") happens later, inside the Server Actions themselves (see [§22](#22-security-model)).

### 5.5 Role checking / authorization

There are no formal "roles" (admin/user/etc.) in this app — authorization is entirely **ownership-based**. Every mutating Server Action re-derives the current user's id from their session and compares it against the `userId` column on the row being modified. There is no client-supplied "am I the owner" flag ever trusted — see the repeated `and(eq(videos.videoId, videoId), eq(videos.userId, userId))` pattern throughout [§18](#18-every-server-action-api-layer).

---

## 6. The Recording Engine

This is the most technically dense part of the app — it uses four separate browser APIs in concert: `getDisplayMedia`, `getUserMedia`, `MediaRecorder`, and the Canvas 2D API — plus a Web Worker and IndexedDB for resilience.

### 6.1 Capturing the screen

```ts
// lib/utils.ts — getMediaStreams()
const displayStream = await navigator.mediaDevices.getDisplayMedia({
  video: { ...DEFAULT_VIDEO_CONFIG, displaySurface: "monitor" },
  audio: true,
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
} as DisplayMediaStreamOptions);
```

`getDisplayMedia` is a browser API that pops up the browser's **own** native picker (not a custom UI this app built) letting the user choose to share their entire screen, one window, or one browser tab. The extra options here are **hints**, not guarantees: `displaySurface: "monitor"` tells Chromium to list "Entire Screen" first in the picker; `selfBrowserSurface: "exclude"` hides this app's own tab from the list (so you can't accidentally record the recorder); `surfaceSwitching: "include"` lets the user switch which tab is being shared mid-recording, if they picked a single tab.

If `withMic` is true, a second, independent stream is requested: `navigator.mediaDevices.getUserMedia({ audio: true })`. If `withCamera` is true, a third: `getUserMedia({ video: {...} })`. Each of these triggers its own separate browser permission prompt.

### 6.2 Compositing screen + webcam onto a Canvas

**Simple explanation:** Imagine you have two video feeds playing side by side — your screen and your webcam. To combine them into *one* video with the webcam as a little bubble in the corner, the browser paints both onto an invisible drawing canvas 30 times per second, like a movie stitched together frame by frame, and it's *that painting* that gets recorded — not the original two feeds.

**Technical explanation** (`lib/hooks/useScreenRecording.ts`, inside `startRecording`):

```ts
const canvas = document.createElement("canvas");
canvas.width = 1920; canvas.height = 1080;
const ctx = canvas.getContext("2d")!;
// ... draw() function called repeatedly:
ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);   // background
ctx.save();
ctx.beginPath();
ctx.arc(pipX + r, pipY + r, r, 0, Math.PI * 2);   // clip to a circle (or roundRect)
ctx.clip();
drawCover(ctx, camVideo, pipX, pipY, pipW, pipH);   // draw webcam inside the clip
ctx.restore();
```

`drawCover` (a helper in the same file) implements **"cover" fit** — the same concept as CSS's `object-fit: cover` — so a rectangular webcam feed fills a square/circular bubble without stretching, by cropping the center of the source video to match the target's aspect ratio:

```ts
function drawCover(ctx, video, dx, dy, dw, dh) {
  const scale = Math.max(dw / video.videoWidth, dh / video.videoHeight);
  const sw = dw / scale, sh = dh / scale;
  const sx = (video.videoWidth - sw) / 2, sy = (video.videoHeight - sh) / 2;
  ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
}
```

The composited canvas is then turned back into a live video stream with `canvas.captureStream(30)` — a genuinely record-able `MediaStream`, which is what actually gets handed to `MediaRecorder`.

### 6.3 A real bug this app hit, and how it was fixed

**The bug:** The very first version of this draw loop used `requestAnimationFrame` (rAF) — the standard, idiomatic way to run per-frame animation code in a browser. It worked perfectly... until the user switched to a different browser tab mid-recording. Browsers **completely suspend `requestAnimationFrame` for hidden tabs** (a deliberate battery-saving behavior) — so the moment the tab lost focus, the draw loop stopped calling itself, and the recorded video froze on its last frame until the user switched back.

**The fix:** replace the per-frame trigger with a **Web Worker** running its own `setInterval`, which is *not* subject to the same tab-visibility throttling:

```ts
function createTickerWorker(onTick: () => void): Worker | null {
  const src = `let id=null;onmessage=(e)=>{
    if(e.data==="start"&&id===null){id=setInterval(()=>postMessage(0),33);}
    else if(e.data==="stop"&&id!==null){clearInterval(id);id=null;}
  };`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
  worker.onmessage = onTick;
  worker.postMessage("start");
  return worker;
}
```

This inline worker (its entire source is a string, turned into a loadable script via `Blob` + `URL.createObjectURL` — no separate `.js` file needed) does nothing but tick a `setInterval` every ~33ms (≈30fps) and `postMessage` back to the main thread, which then runs the actual `draw()` function. Because the worker's timer lives in its own thread, the browser doesn't throttle it just because the *page* is hidden. A `requestAnimationFrame` fallback remains in place for the rare case where `Worker` isn't available at all.

This is a genuinely good "hardest bug I fixed" interview story — it demonstrates understanding of an obscure but real browser API behavior, not just "I looked at the console and found a typo."

### 6.4 Pause and resume

`MediaRecorder` natively supports `.pause()` and `.resume()`. The tricky part is **keeping the displayed timer and the transcript's timestamps accurate across a pause** — if the user records for 10 seconds, pauses for 5 minutes to think, then resumes, the video's actual duration is still ~10+ seconds, not 5 minutes.

```ts
const getElapsed = useCallback((): number => {
  const pausedNow = pausedAtRef.current ? Date.now() - pausedAtRef.current : 0;
  return Math.max(0, (Date.now() - startTimeRef.current - pausedTotalRef.current - pausedNow) / 1000);
}, []);
```

`pausedTotalRef` accumulates every completed pause's duration; `pausedAtRef` tracks an *in-progress* pause (set on `pauseRecording`, cleared on `resumeRecording`, with its duration folded into `pausedTotalRef`). `getElapsed()` is the single source of truth used both for the on-screen timer *and* for tagging transcript segments with the correct in-recording timestamp — so a sentence spoken 8 seconds into *actual* recording time is tagged `0:08`, even if 5 minutes of real wall-clock time passed around a pause.

### 6.5 Crash recovery via IndexedDB

**Simple explanation:** If the browser crashes or the user accidentally refreshes the page mid-recording, all the video data that was building up in memory would normally be lost forever. To prevent that, every second of recorded video is also saved to a small on-disk database inside the browser (`IndexedDB`) as it's captured — so even after a crash, the app can offer to rebuild the recording from what was saved.

**Technical explanation** (`lib/recordingStore.ts`): `MediaRecorder` fires an `ondataavailable` event roughly once per second (`recorder.start(1000)`), each time handing over one chunk of encoded video (a `Blob`). Every chunk is pushed into a normal in-memory array (`chunksRef.current`) **and** persisted:

```ts
recorder.ondataavailable = (e) => {
  if (e.data.size) {
    chunksRef.current.push(e.data);
    void appendRecordingChunk(e.data);   // fire-and-forget IndexedDB write
  }
};
```

`appendRecordingChunk` opens (or creates) an IndexedDB database named `snapcast-recorder` with one object store, `chunks`, and adds the blob with an auto-incrementing key — so chunks come back out in the same order they went in. This is wrapped in a generic `withStore` helper that opens a transaction, runs one operation, and resolves/rejects a Promise around IndexedDB's callback-based API (IndexedDB predates Promises in the browser, so this kind of wrapper is standard practice).

On the next visit, `RecordScreen.tsx` checks `hasRecoverableRecording()` when the studio modal opens; if chunks exist, a banner offers **Restore** (calls `restoreRecording()`, which pulls every chunk back out and reassembles them into a playable video, exactly like a normal recording result) or **Discard** (clears the store).

---

## 7. The Upload Pipeline

### 7.1 Why upload directly to Cloudinary, not through this app's server?

**Simple explanation:** Video files are big — tens or hundreds of megabytes. If the browser sent the video to *this app's* server first, and the server then forwarded it to Cloudinary, the video would travel over the network twice, and this app's server would need to hold the entire file in memory while relaying it. Instead, the browser sends the video **directly** to Cloudinary — this app's server is only ever involved in a tiny, fast step beforehand.

**Technical explanation:** This is a **signed direct upload**. Cloudinary lets you generate a cryptographic signature server-side (where your secret API key lives, safely hidden from the browser) that authorizes *one specific upload* without ever giving the browser your actual secret key.

```ts
// lib/cloudinary.ts
export function getSignedUploadParams(folder: string, publicId: string, resourceType: "video"|"image") {
  const timestamp = Math.round(Date.now() / 1000);
  const fullPublicId = `${folder}/${publicId}`;
  const signature = cloudinary.utils.api_sign_request(
    { timestamp, public_id: fullPublicId },
    process.env.CLOUDINARY_API_SECRET!
  );
  return { uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, publicId: fullPublicId, signature, timestamp, apiKey, cloudName, resourceType };
}
```

The signature is a cryptographic hash computed over exactly `{ timestamp, public_id }` and the secret key. **This is not an "upload preset"** — it's scoped to one exact asset name (`public_id`). The browser receives the signature, timestamp, public ID, and the (non-secret) API key, and can use them to make **exactly one** authorized upload to that one exact asset slot — it cannot reuse the signature to upload anything else, and it never learns the actual secret.

### 7.2 The authorization checks around signed URLs

Two extra checks close real security gaps:

1. **`getThumbnailUploadUrl`** (`lib/actions/video.ts`) checks, before issuing a signature, whether a video already exists with that id — and if so, whether the *current* user owns it:
   ```ts
   const [existing] = await db.select({ userId: videos.userId }).from(videos).where(eq(videos.videoId, videoId));
   if (existing && existing.userId !== userId) throw new Error("Not authorized");
   ```
   Without this, one user could request a signed thumbnail-upload URL for *another user's* video id and overwrite their thumbnail.

2. **`saveVideoDetails`** re-validates, on the way *back in*, that the URLs the client is claiming actually belong to this app's own Cloudinary account:
   ```ts
   const cloudPrefix = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`;
   if (!videoDetails.videoUrl.startsWith(cloudPrefix) || !videoDetails.thumbnailUrl.startsWith(cloudPrefix)) {
     throw new Error("Media URLs must come from the configured CDN");
   }
   ```
   This is defense-in-depth: even though the *upload* step was signed and scoped, the *save* step trusts nothing the client says without re-checking it, because a malicious client could in principle call `saveVideoDetails` directly with an arbitrary URL, bypassing the upload step entirely.

### 7.3 The upload flow, end to end (`app/(root)/upload/page.tsx`)

```
User selects a video file (and optionally a thumbnail image)
        │
        ▼
onSubmit() fires
        │
        ├─► getVideoUploadUrl()  — Server Action; returns a signed upload URL + videoId
        │
        ▼
uploadToCloudinary(videoFile, params, onProgress)
        │   — raw XMLHttpRequest (not fetch!), because XHR exposes
        │     xhr.upload.onprogress for a live percentage bar; fetch does not
        ▼
Cloudinary returns { secure_url, public_id, duration }
        │
        ├─ if no thumbnail chosen: build a URL Cloudinary auto-generates
        │  (".../so_1/<public_id>.jpg" — a frame at 1 second in)
        └─ if thumbnail chosen: getThumbnailUploadUrl() then upload it too
        │
        ▼
saveVideoDetails({ videoId, videoUrl, thumbnailUrl, title, description, tags, visibility, duration })
        │   — validates everything (see §7.2), inserts one row into `videos`
        ▼
saveVideoTranscript(videoId, transcriptSegments)   — only if a recording carried a transcript
        │
        ▼
router.push(`/video/${videoId}`)
```

**Why `XMLHttpRequest` instead of the more modern `fetch`?** `fetch`'s request body has no progress-tracking hook in standard browsers — you can't know "38% uploaded" with `fetch` alone. `XMLHttpRequest.upload.onprogress` gives exact byte counts, which is what powers the live percentage bar (`uploadPercent` state) and the `Uploading… 47%` button label.

**Where does a *recorded* video's transcript come from at this point?** `RecordScreen.tsx`'s `goToUpload()` stashes the recording's blob URL, size, duration, **and transcript segments** into `sessionStorage` before navigating to `/upload`. The upload page's `useEffect` reads that back out, refetches the blob from its object URL, and turns it back into a real `File` object (via `DataTransfer`) so it flows through the exact same upload path as a manually-chosen file — the only difference is `transcriptRef.current` gets populated, and after `saveVideoDetails` succeeds, `saveVideoTranscript` is called to attach it.

---

## 8. The AI Pipeline (Gemini)

### 8.1 What Gemini is asked to do, and when

There are exactly two AI calls in this entire app, both defined in `lib/gemini.ts`, and both are called from exactly one place: `processVideoAI` in `lib/actions/video.ts`.

1. **`analyzeVideoContent(context)`** — produces a summary + tags.
2. **`generateChapters(timedTranscript, maxSeconds)`** — produces chapter markers.

Both are guarded by the same pattern: if `process.env.GEMINI_API_KEY` is unset, `getClient()` returns `null` and the function short-circuits to `null` immediately. **This means the entire AI feature is optional** — the app works correctly with zero AI configured; videos simply never get a summary/tags/chapters, and the UI shows an honest "No AI summary yet" empty state instead of erroring.

### 8.2 `processVideoAI` — orchestrating the AI step

```ts
export const processVideoAI = withError(async (videoId: string) => {
  const userId = await getSessionUserId();   // signed in — this spends API quota
  await assertVideoReadable(videoId, userId); // ...and only on videos you can see

  // Atomic claim: exactly one concurrent caller gets a row back.
  const [existing] = await db.update(videos)
    .set({ processingStatus: "processing", processingStartedAt: now })
    .where(and(eq(videos.videoId, videoId), or(
      inArray(videos.processingStatus, ["idle", "failed"]),
      and(eq(videos.processingStatus, "processing"),          // reclaim a dead run
          or(isNull(videos.processingStartedAt), lt(videos.processingStartedAt, staleBefore))),
    )))
    .returning();
  if (!existing) return { alreadyProcessed: true };  // ready, or another run in flight

  try {
    const context = existing.transcript?.trim()
      ? existing.transcript
      : `Title: ${existing.title}\nDescription: ${existing.description}\nTags: ${(existing.tags ?? []).join(", ")}`;

    const hasManualChapters = (existing.chapters?.length ?? 0) > 0;
    const wantsChapters = !hasManualChapters && (existing.transcriptSegments ?? []).length > 0;

    // Independent calls — run concurrently, not back to back.
    const [aiResult, aiChapters] = await Promise.all([
      analyzeVideoContent(context),
      wantsChapters ? generateChapters(timedTranscript, existing.duration ?? 0) : Promise.resolve(null),
    ]);

    await db.update(videos).set({
      aiSummary: aiResult?.summary ?? existing.aiSummary ?? null,
      tags: aiResult?.tags?.length ? aiResult.tags : (existing.tags ?? []),
      chapters: aiChapters ?? existing.chapters ?? [],
      processingStatus: "ready",
    }).where(...);
    return { processed: true };
  } catch {
    await db.update(videos).set({ processingStatus: "failed" }).where(...);
    return { processed: false };
  }
});
```

Three important design decisions live in this one function:

1. **Summary/tags have a fallback context.** If a video has a transcript (i.e., it was recorded with narration), the AI reads *that*. If not (i.e., it was uploaded, or recorded silently), the AI instead reads a constructed string of `Title / Description / Tags`. **This means every video gets a summary, whether recorded or uploaded** — only the *source material* differs.
2. **Chapters have no such fallback — they require a real transcript.** There's no meaningful way to generate topic-boundary chapters from a title and description alone; chapters need actual spoken content with timestamps to segment. So `aiChapters` stays `null` unless `transcriptSegments.length > 0`.
3. **Manual chapters always win.** If the video owner already added even one chapter by hand (via `VideoChapters.tsx`), `hasManualChapters` is true and the AI chapter step is skipped entirely — the app never silently overwrites a human's work.

### 8.3 `analyzeVideoContent` — the summary/tags prompt

```ts
export async function analyzeVideoContent(context: string): Promise<AiVideoAnalysis | null> {
  const genAI = getClient();
  if (!genAI || !context.trim()) return null;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Analyze this video content and respond with ONLY valid JSON...`;
    const result = await model.generateContent(prompt);
    const cleaned = result.response.text().trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as AiVideoAnalysis;
    return { summary: ..., tags: ... };
  } catch { return null; }
}
```

**Why strip markdown code fences before parsing?** LLMs frequently wrap JSON output in \`\`\`json ... \`\`\` blocks even when explicitly told not to — this is a known, common quirk, so the `.replace()` calls defensively strip that formatting before attempting `JSON.parse`. **Why wrap the whole thing in try/catch and return `null` on any failure?** Because an LLM's output is fundamentally untrusted, free-form text — it might not be valid JSON at all, or might be missing an expected field. The caller (`processVideoAI`) is written to treat `null` as "AI didn't produce anything usable this time," not as a fatal error — the video still saves successfully, just without an AI summary.

### 8.4 `generateChapters` — the more carefully-validated one

This function is more defensive because chapter *timestamps* directly control UI behavior (seeking) — a malformed timestamp could break the player, whereas a malformed summary just displays oddly. The validation pipeline after parsing the AI's JSON array:

```ts
const chapters: Chapter[] = parsed
  .filter(c => c && typeof c === "object")
  .map(c => ({
    title: String(c.title ?? "").trim(),
    timestamp: Math.max(0, Math.min(cap, Math.floor(Number(c.timestamp)))),
  }))
  .filter(c => c.title.length > 0 && Number.isFinite(c.timestamp))
  .sort((a, b) => a.timestamp - b.timestamp)
  .filter((c, i, arr) => i === 0 || c.timestamp > arr[i - 1].timestamp);   // strictly increasing

if (chapters[0].timestamp !== 0) chapters[0].timestamp = 0;   // force a chapter at the start
return chapters.slice(0, 8);   // cap at 8 chapters
```

Every one of these steps guards against a specific way the AI could misbehave: non-object entries are dropped; timestamps are clamped into `[0, videoDuration]` (an AI hallucinating a timestamp past the end of the video would otherwise silently break seeking); empty titles are dropped; chapters are sorted and de-duplicated by timestamp (an AI could return them out of order, or with two chapters at the same second); and the very first chapter is forced to start at `0` regardless of what the AI said, so the player always has a chapter covering the video's opening seconds.

---

## 9. The Custom Video Player

`components/VideoPlayer.tsx` is a **from-scratch replacement** for the browser's native `<video controls>` UI — the native controls are functional but visually inconsistent across browsers and can't show chapter markers on the seek bar. This component wraps a bare `<video>` element (with no native `controls` attribute) in fully custom UI.

### 9.1 Why build a custom player instead of using `<video controls>`?

| | Native `<video controls>` | This custom player |
|---|---|---|
| Looks | Different in every browser | Consistent everywhere |
| Chapter markers on the seek bar | Not possible | Built in (`.player-chapter-tick`) |
| Copy-a-link-at-this-timestamp | Not possible | Built in |
| Keyboard shortcuts | Browser-default only | Full custom map (see below) |
| Analytics hooks (view count, watch time) | Requires listening to native events anyway | Same underlying events, wired directly |

The trade-off is real: a hand-built player has to correctly reimplement play/pause, scrubbing, volume, fullscreen, and Picture-in-Picture, and each of those has edge cases. This is a deliberate choice made because the app's differentiating features (chapter navigation, shareable timestamps) require deep custom control over the seek bar that the native element doesn't expose.

### 9.2 State it tracks

```ts
const [playing, setPlaying] = useState(false);
const [currentTime, setCurrentTime] = useState(0);
const [duration, setDuration] = useState(0);
const [buffered, setBuffered] = useState(0);
const [volume, setVolume] = useState(1);
const [muted, setMuted] = useState(false);
const [speed, setSpeed] = useState(1);
const [showSpeedMenu, setShowSpeedMenu] = useState(false);
const [controlsVisible, setControlsVisible] = useState(true);
const [isFullscreen, setIsFullscreen] = useState(false);
const [hoverTime, setHoverTime] = useState<number | null>(null);   // scrub-bar tooltip
const [copiedTs, setCopiedTs] = useState(false);                    // "Copied!" feedback
const [hasIncrementedView, setHasIncrementedView] = useState(false);
const [pipSupported, setPipSupported] = useState(false);
```

All of this is **local component state** — there is no global store. Each `<VideoPlayer>` instance is fully self-contained (see [§19](#19-state-management-strategy) for why no Redux/Zustand is used anywhere in this app).

### 9.3 The imperative handle — talking to the player from outside

Sibling components (`VideoComments`, `VideoNotes`, `VideoChapters`, `VideoInfo`'s transcript tab) all need to tell the player "jump to this second" when a user clicks a timestamp chip. Because the player is a **child** component, its parent (`video/[videoId]/page.tsx`) can't normally reach *into* it. React's `forwardRef` + `useImperativeHandle` solves this:

```ts
export interface VideoPlayerHandle {
  seekTo: (seconds: number) => void;
  getCurrentTime: () => number;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({ ... }, ref) => {
  useImperativeHandle(ref, () => ({
    seekTo(seconds) { videoRef.current!.currentTime = seconds; videoRef.current!.play(); },
    getCurrentTime() { return videoRef.current?.currentTime ?? 0; },
  }));
  ...
});
```

The parent page holds `const playerRef = useRef<VideoPlayerHandle>(null)` and passes `onSeek={(s) => playerRef.current?.seekTo(s)}` down to every sibling component that needs to trigger a seek. This is the React-idiomatic escape hatch for "call an imperative method on a child," used sparingly and only because DOM playback control (`currentTime`, `.play()`) is inherently imperative, not declarative.

### 9.4 Keyboard shortcuts

```ts
switch (e.key) {
  case " ": case "k": togglePlay(); break;
  case "ArrowLeft": seekBy(-5); break;
  case "ArrowRight": seekBy(5); break;
  case "j": seekBy(-10); break;
  case "l": seekBy(10); break;
  case "ArrowUp": setVolumeClamped(volume + 0.1); break;
  case "ArrowDown": setVolumeClamped(volume - 0.1); break;
  case "m": toggleMute(); break;
  case "f": toggleFullscreen(); break;
  case "<": changeSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]); break;
  case ">": changeSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]); break;
  default: if (/^[0-9]$/.test(e.key)) videoRef.current!.currentTime = (Number(e.key) / 10) * duration;
}
```

This mirrors the shortcut conventions of YouTube (`j`/`k`/`l` scrubbing, number keys for percent-seek, `f` fullscreen, `m` mute) — a deliberate choice to meet users' existing muscle memory rather than invent a new scheme. Guarded by `if (tag === "INPUT" || tag === "TEXTAREA") return;` so typing in a nearby comment box doesn't accidentally trigger player shortcuts.

### 9.5 The seek bar (custom scrubbing)

```ts
const handleTrackPointerDown = (e: React.PointerEvent) => {
  draggingRef.current = true;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  v.currentTime = timeFromPointer(e.clientX);
  const onMove = (ev: PointerEvent) => { v.currentTime = timeFromPointer(ev.clientX); };
  const onUp = () => { draggingRef.current = false; window.removeEventListener("pointermove", onMove); ... };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
};
```

`setPointerCapture` ensures that even if the user's cursor moves *outside* the narrow seek-bar element while dragging, the browser keeps routing pointer events to it — without this, a fast drag could "escape" the element and stop updating. `timeFromPointer` converts an x-coordinate into a time value by computing the click position as a fraction of the bar's width, multiplied by the video's duration:

```ts
const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
return ratio * duration;
```

### 9.6 Deep-linking via `?t=95`

```ts
const handleLoadedMetadata = () => {
  const t = Number(new URLSearchParams(window.location.search).get("t") ?? NaN);
  if (Number.isFinite(t) && t > 0 && t < v.duration) v.currentTime = t;
};
```

When the video's metadata first loads (so `v.duration` is known), the player checks the URL's query string for a `t` parameter and jumps there if present. `copyTimestampLink` (triggered by the `@1:23` button) constructs exactly this kind of URL: `${origin}${pathname}?t=${currentSecond}`. This is what lets a comment, note, or manually-shared link say "look at 1:23" and have the recipient's video actually open at that moment.

### 9.7 Auto-hiding controls

```ts
const pokeControls = useCallback(() => {
  setControlsVisible(true);
  if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  hideTimerRef.current = setTimeout(() => {
    if (!videoRef.current?.paused && !draggingRef.current) setControlsVisible(false);
  }, CONTROLS_HIDE_MS);   // 2600ms
}, []);
```

Every mouse movement over the player resets a 2.6-second countdown; if it expires while the video is *playing* (not paused) and the user isn't mid-drag on the seek bar, the controls fade out (via a CSS class, `controls-hidden`) so they don't obscure the content — standard behavior mirrored from YouTube/Netflix-style players.

---

## 10. Collaboration Features (Comments & Notes)

These two features look superficially similar (both attach text to a timestamp) but serve **opposite visibility models**, which is the single most important thing to understand about them.

| | Comments | Notes |
|---|---|---|
| Visibility | **Public** — every viewer sees every comment | **Private** — only the author ever sees their own notes |
| Threading | Yes (one level of replies) | No |
| Who can delete | The comment's author, **or** the video's owner | Only the note's author |
| Purpose | Public discussion, feedback | Personal study notes, private annotations |

### 10.1 Comments — the threading model

`components/VideoComments.tsx` fetches the full flat list of comments for a video, then **groups them client-side**:

```ts
const { topLevel, repliesByParent } = useMemo(() => {
  const top: CommentWithUser[] = [];
  const map = new Map<string, CommentWithUser[]>();
  for (const c of comments) {
    if (c.parentId) { (map.get(c.parentId) ?? []).push(c); map.set(c.parentId, ...); }
    else top.push(c);
  }
  return { topLevel: top, repliesByParent: map };
}, [comments]);
```

The server sends one flat array (ordered by `createdAt`); the client reconstructs the two-level tree by bucketing replies under their `parentId`. This is a deliberate simplicity choice — the server doesn't need a recursive query, and the client's grouping logic is a single linear pass (`O(n)`), not a tree traversal.

**Authorization for deletion** (`lib/actions/comments.ts`, `deleteComment`):
```ts
if (target.authorId !== userId) {
  const [video] = await db.select({ ownerId: videos.userId }).from(videos).where(eq(videos.videoId, target.videoId));
  if (!video || video.ownerId !== userId) throw new Error("Not authorized");
}
await db.delete(comments).where(and(eq(comments.videoId, target.videoId), eq(comments.parentId, commentId)));
await db.delete(comments).where(eq(comments.id, commentId));
```
Two people can delete a comment: whoever wrote it, or whoever owns the video it's on (moderation power). Deleting a top-level comment also deletes its direct replies — done as two explicit queries rather than relying on a database cascade, because `parentId` isn't declared as an actual foreign key constraint in the schema (it's a plain `uuid` column, not `.references()`), so cascading delete has to be handled in application code here.

### 10.2 The "capture timestamp on focus" pattern

Both `VideoComments.tsx` and `VideoNotes.tsx` share a subtle but important UX fix:

```ts
const [capturedTs, setCapturedTs] = useState<number | null>(null);
// ...
<textarea onFocus={() => { if (capturedTs === null) setCapturedTs(Math.floor(getCurrentTime?.() ?? 0)); }} />
```

**The problem this solves:** if the "at 0:42" label in the composer just read `getCurrentTime()` live on every render, it would keep changing *while the user is still typing* (because the video keeps playing behind the composer) — so the label the user saw when they started typing wouldn't match the timestamp actually saved when they hit submit. Capturing the time **once**, on the textarea's first `focus` event, freezes it at "the moment the user decided to comment," which is the semantically correct value.

### 10.3 Notes — private, per-viewer

```ts
export async function getNotes(videoId: string): Promise<Note[]> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return [];
  return db.select().from(notes)
    .where(and(eq(notes.videoId, videoId), eq(notes.userId, session.user.id)))
    .orderBy(asc(notes.timestamp));
}
```

The `eq(notes.userId, session.user.id)` filter is what makes notes private — it's not a UI-only restriction, it's baked into the database query itself, so there's no code path that could accidentally leak one user's notes to another.

---

## 11. Collections (Playlists)

"Collections" in the UI map to `playlists` + `playlist_videos` in the schema — see [§4.2](#42-the-complete-schema) for the many-to-many shape.

### 11.1 The "Add to Collection" dropdown (`AddToPlaylist.tsx`)

This component is opened from the video detail header and lets the owner check/uncheck which of their playlists a video belongs to, **plus** create a brand-new playlist inline:

```ts
const toggle = (playlistId: string) => {
  const isMember = memberIds.has(playlistId);
  setMemberIds(prev => { /* optimistically flip the Set */ });
  startTransition(async () => {
    if (isMember) await removeVideoFromPlaylist(playlistId, videoId);
    else await addVideoToPlaylist(playlistId, videoId);
  });
};
```

This is an **optimistic update**: the checkbox visually flips *before* the server confirms the change, inside `setMemberIds`, and the actual server call happens inside `startTransition` (React's mechanism for marking an update as non-urgent, so the UI doesn't block). See [§24.4](#244-optimistic-ui) for the general concept.

Clicking outside the dropdown closes it, implemented via a native `mousedown` listener checking `ref.current.contains(e.target)` — a common vanilla-DOM pattern for "click outside to close" that doesn't require any additional library.

### 11.2 Ownership guard, reused across every mutation

```ts
async function assertOwner(playlistId: string, userId: string) {
  const [pl] = await db.select({ userId: playlists.userId }).from(playlists).where(eq(playlists.id, playlistId));
  if (!pl) throw new Error("Playlist not found");
  if (pl.userId !== userId) throw new Error("Not authorized");
}
```

Every playlist-mutating action (`renamePlaylist`, `deletePlaylist`, `addVideoToPlaylist`, `removeVideoFromPlaylist`) calls this helper first. Extracting it once avoids repeating the same two-line check five times with a risk of one call site forgetting it.

### 11.3 Position management and conflict-safe inserts

```ts
export async function addVideoToPlaylist(playlistId: string, videoId: string) {
  await assertOwner(playlistId, userId);
  const [{ count }] = await db.select({ count: sql`count(*)` }).from(playlistVideos).where(eq(playlistVideos.playlistId, playlistId));
  await db.insert(playlistVideos).values({ playlistId, videoId, position: Number(count) })
    .onConflictDoNothing();
}
```

`position` is simply "how many videos are already in this playlist" at insert time, appending new videos to the end. `.onConflictDoNothing()` makes the insert **idempotent** — if the same video is somehow added twice (e.g., a rapid double-click), the second insert silently does nothing instead of throwing a duplicate-key error (there's a unique constraint implied by the checkbox model, though not explicitly declared as a DB-level unique index in this schema — the application layer prevents duplicates via the `memberIds` Set check before ever calling this action).

---

## 12. Analytics

### 12.1 Two mechanisms, not one — and why

This is a place where precision matters for an interview: this app does **not** use pure event-sourcing for view counts. It uses two mechanisms side by side:

1. **`videos.views`** — a simple integer column, incremented by exactly `+1` every time a viewer watches past 3 seconds (`VideoPlayer.tsx`'s `handleTimeUpdate`):
   ```ts
   if (!hasIncrementedView && v.currentTime > 3) {
     setHasIncrementedView(true);
     incrementVideoViews(videoId).catch(console.error);
   }
   ```
   ```ts
   // lib/actions/video.ts
   // Visibility is folded into the UPDATE: a video the caller may not view
   // matches zero rows, with no extra round trip on this hot path.
   await db.update(videos).set({ views: sql`${videos.views} + 1` })
     .where(and(eq(videos.videoId, videoId), or(
       eq(videos.visibility, "public"),
       currentUserId ? eq(videos.userId, currentUserId) : undefined,
       and(isNotNull(videos.shareToken), gt(videos.shareTokenExpiry, new Date())),
     )));
   ```
   This is what's shown as the plain "views" count on every video card — fast, cheap, and all that's needed for a simple headline number. It deliberately does **not** touch `updatedAt`: a view isn't an edit, and bumping the modification time on every view made that column meaningless (it's also why AI processing needed its own `processingStartedAt` column rather than reusing `updatedAt` — see [§4.2](#42-the-complete-schema)).

2. **`video_views`** — a separate table logging **one row per viewing session**, fired once when the viewer leaves the page or the video ends:
   ```ts
   const flushWatch = useCallback(() => {
     if (watchSentRef.current) return;
     const watched = Math.floor(maxWatchedRef.current);
     if (watched < 2) return;
     watchSentRef.current = true;
     const completed = duration > 0 && watched >= duration * 0.9;
     recordWatch(videoId, watched, completed, getAnonId()).catch(() => {});
   }, [videoId]);

   useEffect(() => {
     window.addEventListener("pagehide", () => flushWatch());
     return () => { window.removeEventListener(...); flushWatch(); };   // also on unmount
   }, [flushWatch]);
   ```

**Why have both?** The simple counter answers "how many views does this video have" instantly and cheaply — a single integer increment. But it *cannot* answer "how many **unique** people watched," "how long did people watch on average," or "what fraction finished the video" — those questions require knowing about individual viewing sessions, which is exactly what the `video_views` table captures. Rather than trying to derive everything from one mechanism, the app uses the simplest tool for each job.

### 12.2 Watched-seconds tracking, and completion detection

```ts
const handleTimeUpdate = () => {
  if (v.currentTime > maxWatchedRef.current) maxWatchedRef.current = v.currentTime;
  ...
};
```

`maxWatchedRef` tracks the **furthest point reached**, not the current playhead — so if a viewer scrubs backward to re-watch a section, their "watched seconds" doesn't decrease. `completed` is a simple heuristic: watched at least 90% of the total duration (`watched >= total * 0.9`), not exactly 100%, because viewers rarely watch the literal last fraction of a second before navigating away.

### 12.3 Anonymous viewer identity

```ts
// lib/anon.ts
export function getAnonId(): string {
  const KEY = "snapcast_anon_id";
  let id = localStorage.getItem(KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
  return id;
}
```

A viewer who isn't logged in (e.g., someone who received a `/share/[token]` link) still gets a stable, random identifier stored in their browser's `localStorage`, so repeat visits from the *same browser* are recognized as the same viewer for "unique viewers" counting — without collecting any actual personal information. `recordWatch` stores this in `anonId` only when there's no logged-in `viewerId`:
```ts
anonId: viewerId ? null : String(anonId ?? "").slice(0, LIMITS.anonIdLength) || null,
```

### 12.4 The aggregation queries

`getVideoAnalytics` (per-video) and `getChannelAnalytics` (across all of a user's videos) both use SQL aggregate functions computed directly by Postgres, not pulled into JavaScript and summed by hand:

```ts
uniqueViewers: sql<number>`count(distinct coalesce(${videoViews.viewerId}, ${videoViews.anonId}))`,
completedCount: sql<number>`count(*) filter (where ${videoViews.completed})`,
```

`coalesce(viewerId, anonId)` treats a logged-in viewer's user id and an anonymous viewer's localStorage id as the same *kind* of identity for counting distinct viewers — whichever one is non-null is used. `count(*) filter (where completed)` is a Postgres-specific syntax for a conditional count in a single pass, instead of two separate queries (one for total, one for completed).

`getChannelAnalytics` includes an explicit ownership check before doing any real work:
```ts
if (!session || session.user.id !== userId) {
  return { totalVideos: 0, ... };  // empty stats, not an error
}
```
A stranger requesting someone else's channel analytics silently gets zeros rather than a thrown error or someone else's real numbers — this avoids leaking *whether* a user exists or has videos via an error-message side channel.

---

## 13. Sharing & Privacy

### 13.1 The three visibility tiers

```ts
type Visibility = "public" | "private" | "link-only";
```

- **`public`** — appears in the global `/` library for anyone (logged in or not).
- **`private`** — visible only to the owner. Enforced in `getVideoById`:
  ```ts
  or(eq(videos.visibility, "public"), currentUserId ? eq(videos.userId, currentUserId) : sql`false`)
  ```
  If the video isn't public, the query only matches when the current logged-in user's id equals the owner's id; if nobody's logged in, `sql\`false\`` guarantees the `or` fails outright.
- **`link-only`** — not listed anywhere publicly, but anyone with the exact share link can view it (see below). This still respects the same `getVideoById` visibility check for the *authenticated* `/video/[videoId]` route — link-only videos are only actually reachable without login via the separate `/share/[token]` mechanism.

### 13.2 Share tokens

```ts
export const generateShareToken = withError(async (videoId, expiresInDays = SHARE_TOKEN_EXPIRY_DAYS) => {
  const userId = await getSessionUserId();
  const token = crypto.randomUUID();
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + clampInt(expiresInDays, 1, 30));
  await db.update(videos).set({ shareToken: token, shareTokenExpiry: expiry }).where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));
  return { token, expiry, shareUrl: `${baseUrl}/share/${token}` };
});
```

**Why is `crypto.randomUUID()` the actual security mechanism here?** A sequential or short numeric video id would let someone guess `/share/1`, `/share/2`, etc., and enumerate other people's videos. A cryptographically random UUID (122 bits of randomness) is computationally infeasible to guess — the **link itself is the access control**, no password needed, but only someone who was actually given the link (or who guesses one of 2^122 possibilities) can view it.

**Fetching by token** (`getVideoByShareToken`):
```ts
and(eq(videos.shareToken, token), gt(videos.shareTokenExpiry, new Date()))
```
Both the token match **and** a not-yet-expired timestamp must hold — an expired token simply returns no rows, and the share page shows a "Link Expired" state.

**Revocation:**
```ts
export const revokeShareToken = withError(async (videoId) => {
  await db.update(videos).set({ shareToken: null, shareTokenExpiry: null }).where(...);
});
```
Revocation doesn't flip a boolean "active/inactive" flag — it **clears the token value itself** back to `null`. Since `getVideoByShareToken`'s query requires an exact token match, a `null` column can never match any (non-null) token string a visitor might have — so the old link stops working immediately, permanently, with no separate "is this link active" state to keep in sync.

### 13.3 The `/share/[token]` page is intentionally outside the auth wall

Recall from [§5.4](#54-protected-routes-the-middleware) that `middleware.ts`'s matcher explicitly excludes `share` — this is the one route in the entire app reachable **without ever logging in**, by design, because the whole point of a share link is letting an outside person (who may have no account at all) watch the video.

### 13.4 Rich link previews (`generateMetadata`)

```ts
// app/share/[token]/page.tsx
export async function generateMetadata({ params }): Promise<Metadata> {
  const { token } = await params;
  const result = await getVideoByShareToken(token);
  if (!result) return { title: "Shared video", robots: { index: false, follow: false } };
  return {
    title: result.video.title,
    description: result.video.aiSummary ?? result.video.description,
    robots: { index: false, follow: false },
    openGraph: { type: "video.other", images: [{ url: result.video.thumbnailUrl, ... }] },
    twitter: { card: "summary_large_image", images: [result.video.thumbnailUrl] },
  };
}
```

When a share link is pasted into Slack, iMessage, or Twitter, those platforms fetch this page's `<head>` metadata to build a rich preview card (title, description, thumbnail image) — this function is what supplies that. `robots: { index: false, follow: false }` explicitly tells search engines not to index these token-gated pages (they're meant to be shared privately, not discovered via Google).

---

## 14. Search

### 14.1 The search query

```ts
// lib/utils.ts
export const doesContentMatch = (searchQuery: string) =>
  or(
    ilike(sql`REPLACE(REPLACE(REPLACE(LOWER(${videos.title}), '-', ''), '.', ''), ' ', '')`,
         `%${searchQuery.replace(/[-. ]/g, "").toLowerCase()}%`),
    ilike(videos.transcript, `%${searchQuery}%`),
    ilike(videos.aiSummary, `%${searchQuery}%`)
  );
```

Search matches across **three fields**: title, transcript, and AI summary — an `OR` condition, so a query matching *any one* of them returns the video. `ilike` is Postgres's case-insensitive `LIKE`. The title comparison specifically strips hyphens, periods, and spaces from both sides before comparing (`REPLACE(REPLACE(REPLACE(...)))`), so a search for `"nextjs"` matches a title like `"Next.js Tutorial"` or `"next-js-demo"` — a small but meaningful usability improvement, since users rarely type punctuation exactly as it appears in a title.

**Consequence for uploaded videos:** since uploads have no transcript, their searchability is effectively limited to title + AI summary (which *is* generated for uploads, from metadata — see [§8.2](#82-processvideoai--orchestrating-the-ai-step)). Recorded videos with narration get the full benefit of transcript-content search.

### 14.2 Debounced search input (`SharedHeader.tsx`)

```ts
useEffect(() => {
  const debounceTimer = setTimeout(() => {
    if (searchQuery !== searchParams.get("query")) {
      router.push(updateURLParams(searchParams, { query: searchQuery || null }, pathname));
    }
  }, 500);
  return () => clearTimeout(debounceTimer);
}, [searchQuery, searchParams, pathname, router]);
```

**Simple explanation:** without debouncing, every single keystroke would trigger a full page navigation and a new database query — typing "next.js tutorial" would fire ~17 searches, one per character. Debouncing waits for a pause in typing (500ms of no new keystrokes) before actually running the search.

**Technical explanation:** this is a classic `useEffect`-with-cleanup pattern. Every re-render (i.e., every keystroke) schedules a new `setTimeout`, but the `return () => clearTimeout(debounceTimer)` cleanup function cancels the *previous* pending timer first. Only the last-scheduled timer that isn't cancelled within 500ms actually fires. The search itself is implemented as a URL navigation (`router.push`, changing the `?query=` search param), not a `fetch` call — which means the results page is a genuine server re-render (see [§14.3](#143-why-url-driven-search-not-client-state)).

### 14.3 Why URL-driven search, not client state?

The current search term and sort filter live in the **URL's query string** (`?query=demo&filter=Most%20Viewed&page=2`), not in React state that would be lost on refresh. This means a search results page is **bookmarkable and shareable** — pasting that exact URL to someone else shows them the exact same search results, and refreshing the page doesn't reset the search. The Server Component (`app/(root)/page.tsx`) reads `searchParams` directly and passes them into `getAllVideos(query, filter, page)`.

---

## 15. Every Page, File by File

### 15.1 `app/layout.tsx`
**Purpose:** The root HTML document for the *entire* app — every single page is rendered inside this. **Execution:** runs once per request, wrapping whatever page matched the URL. **Key content:** loads two fonts (Google's Karla via `next/font/google`, and a local custom font "Satoshi" via `next/font/local`, see `fonts/font.ts`), and defines the app-wide `<Metadata>` (title template, Open Graph/Twitter card defaults — see [§21.5](#215-indexdts) and [`app/layout.tsx`](#151-applayouttsx)). `metadataBase` is set from `NEXT_PUBLIC_BASE_URL`, which is required for any relative image URLs in metadata (like Open Graph images) to resolve to an absolute URL.

### 15.2 `app/(root)/layout.tsx`
**Purpose:** A *second*, nested layout applied only to routes inside the `(root)` group. **What it adds over the root layout:** a persistent `<Navbar>` at the top of every page. **Why a separate layout instead of just adding `<Navbar>` to every page individually:** Next.js layouts persist across navigations within their scope — clicking between `/`, `/upload`, and `/playlists` re-renders only the page content, not the Navbar, avoiding an unnecessary remount (and preserving any client-side state the Navbar might hold, like a dropdown being open).

### 15.3 `app/(root)/page.tsx` — the home page
**Purpose:** The public video library at `/`. **Type:** async Server Component (`export const dynamic = "force-dynamic"` forces it to run fresh on every request rather than being statically cached, since the video list changes constantly). **Execution flow:** reads `query`/`filter`/`page` from the URL → calls `getAllVideos()` (a Server Action, called directly from a Server Component — this works because Server Actions are just async functions when called server-side, no network round-trip needed) → renders a `<VideoCard>` grid or an `<EmptyState>` → renders `<Pagination>` if there's more than one page.

### 15.4 `app/(root)/loading.tsx`
**Purpose:** Next.js automatically shows this file's content while a sibling `page.tsx` in the same route segment is still loading data (this is React Server Components' **Suspense** mechanism, wired in automatically by the App Router's file convention — no manual `<Suspense>` boundary needed for a top-level page). **What it renders:** eight shimmering skeleton cards mimicking the shape of `<VideoCard>`, so the loading state doesn't feel like a blank flash.

### 15.5 `app/(auth)/sign-in/page.tsx`
**Purpose:** The one page reachable without a session. **Type:** Client Component (`"use client"`) because it needs `onClick` handlers to trigger `authClient.signIn.social(...)`. **Structure:** a two-panel layout — a left panel with the SnapCast pitch, a right panel with the actual "Sign in with Google" button.

### 15.6 `app/(root)/upload/page.tsx`
See the full walkthrough in [§7.3](#73-the-upload-flow-end-to-end-approotuploadpagetsx). **Key state:** `formData` (title/description/tags/visibility), `uploadPercent` (live progress), `transcriptRef` (a `useRef`, not `useState`, holding the transcript array — a `ref` is used here because this value doesn't need to trigger a re-render itself, it's only read once, at submit time).

### 15.7 `app/(root)/video/[videoId]/page.tsx` — the video detail page
**Purpose:** The single most feature-dense page — hosts the player, comments, and the tabbed info panel (transcript/summary/chapters/notes/metadata). **Type:** Client Component, unusually, for a page that's mostly about displaying server data — this is because it needs a `playerRef` (imperative handle, see [§9.3](#93-the-imperative-handle--talking-to-the-player-from-outside)) that many child components call into, and needs to trigger `processVideoAI` client-side once the player signals it's ready to play (`onReady={handleVideoReady}`).

```ts
const handleVideoReady = useCallback(async () => {
  if (!videoId || aiTriggered.current) return;   // only ever trigger once per page load
  aiTriggered.current = true;
  if (videoData?.video.processingStatus === "ready") return;   // skip if already processed
  setAiRunning(true);
  try {
    await processVideoAI(videoId);
    const updated = await getVideoById(videoId);   // refetch to pick up new summary/chapters
    if (updated) setVideoData(updated);
  } finally { setAiRunning(false); }
}, [videoId, videoData?.video.processingStatus]);
```

`aiTriggered` is a `useRef` (not state) specifically because it needs to prevent a *second* AI call even across re-renders caused by other state changes in the same component — a `useState` boolean would itself cause a re-render when flipped, creating a subtle timing question; a ref changes silently.

### 15.8 `app/(root)/profile/[id]/page.tsx`
**Purpose:** A user's public channel — their video grid, searchable/filterable the same way the home page is. **Owner-only addition:** `{isOwner && <ChannelAnalyticsPanel userId={id} />}` — the analytics panel is a Server Component itself, fetching its own data (`getChannelAnalytics`) independently of the page around it, and internally re-checks that the requester really is the owner (defense in depth, since the page-level check could in principle be bypassed by directly invoking the component in some other context).

### 15.9 `app/(root)/playlists/page.tsx` and `.../playlists/[id]/page.tsx`
Both are thin Server Components that render a single client component (`PlaylistsManager` and `PlaylistDetail` respectively) and do essentially no work themselves — all the data-fetching and interactivity for playlists happens client-side inside those components (see [§16](#16-every-component-file-by-file)). Both declare `force-dynamic` for the same reason as the home page.

### 15.10 `app/share/[token]/page.tsx`
Covered fully in [§13.3](#133-the-sharetoken-page-is-intentionally-outside-the-auth-wall) and [§13.4](#134-rich-link-previews-generatemetadata). Notably reuses the exact same `<VideoPlayer>` component as the authenticated video page — the custom player isn't duplicated for the public view.

### 15.11 `app/api/auth/[...all]/route.ts`
**Purpose:** A single catch-all API route (`[...all]` is a Next.js "catch-all dynamic segment," matching `/api/auth/anything/here`) that delegates *entirely* to better-auth's own request handler:
```ts
export const { GET, POST } = toNextJsHandler(auth.handler);
```
This one line is the entire file. Every OAuth callback, session check, and sign-out request funnels through here — better-auth owns the routing logic internally.

### 15.12 `app/error.tsx` and `app/not-found.tsx`
Next.js file-convention special pages: `error.tsx` is automatically rendered when any Server or Client Component in the tree throws an uncaught error (it must be a Client Component, since it needs the `reset()` callback to attempt recovery); `not-found.tsx` renders for any URL that doesn't match a route. Both are branded (SnapCast logo, matching visual style) rather than left as Next.js's generic default error screens.

---

## 16. Every Component, File by File

### 16.1 `Navbar.tsx`
**Purpose:** Persistent top bar (only rendered for logged-in users, inside `(root)/layout.tsx`). **State:** none of its own beyond what `authClient.useSession()` provides reactively. **Children:** `ImageWithFallback` (for the avatar). **Notable:** the sign-out button calls `authClient.signOut({ fetchOptions: { onSuccess: () => router.push("/sign-in") } })` — the redirect only happens *after* better-auth confirms the sign-out succeeded, not optimistically before.

### 16.2 `VideoPlayer.tsx`
Covered exhaustively in [§9](#9-the-custom-video-player). It also plays an owner's edit by skipping cuts, with every control on the edited timeline ([§28.9](#289-live-preview-and-viewer-playback)).

### 16.2a `components/editor/*`
`Editor.tsx` (orchestration, autosave, keyboard), `Timeline.tsx` (canvas waveform), `TranscriptPane.tsx` (memoized sentence rows) and `ExportDialog.tsx`. See [§28](#28-the-one-take-editor).

### 16.3 `VideoInfo.tsx`
**Purpose:** The tabbed panel beside the player (`transcript / ai summary / chapters / notes / metadata`). **Why one component instead of five separate ones directly in the page:** it owns the *shared* state that multiple tabs need — specifically `currentSeconds` (polled from the player, see below), used by both the transcript tab (to highlight the currently-spoken line) and the chapters tab (to highlight the currently-playing chapter). Splitting those into fully separate components would mean either lifting this polling state up to the page (bloating it) or duplicating the polling logic twice.

```ts
const timeSyncedTab = activeTab === "transcript" || activeTab === "chapters";
useEffect(() => {
  if (!timeSyncedTab || !getCurrentTime) return;
  const id = setInterval(() => setCurrentSeconds(Math.floor(getCurrentTime())), 500);
  return () => clearInterval(id);
}, [timeSyncedTab, getCurrentTime]);
```
The polling interval only runs **while a time-synced tab is actually active** — switching to the "metadata" tab stops the interval entirely, avoiding unnecessary work when the highlighted-segment feature isn't even visible.

**The `highlight()` helper** (search-term bolding in the transcript):
```ts
const highlight = (text: string, query: string) => {
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  return parts.map((part, i) => part.toLowerCase() === query.toLowerCase() ? <mark key={i}>{part}</mark> : part);
};
```
The regex special characters in the user's search query are escaped (`replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`) before being interpolated into a `new RegExp(...)` — without this, a search for a literal `"."` or `"("` would either match everything or throw a regex syntax error. The capturing group `(${escaped})` in `.split()` is what keeps the matched substring *in* the resulting array (normally `.split()` on a non-capturing pattern would discard the delimiter) — this is the trick that lets the matched portion be wrapped in `<mark>` while everything else passes through unchanged.

### 16.4 `VideoChapters.tsx`
**Purpose:** Displays and (for the owner) edits the chapter list. **Props:** `currentSeconds` (from the parent `VideoInfo`) is used purely for the "which chapter is active right now" highlight — a chapter is active if `currentSeconds` falls in `[thisChapter.timestamp, nextChapter.timestamp)`. **Manual add flow:** the owner types a title and a timestamp in free-form text (`"1:30"` or `"90"`), parsed by a local `parseTimestamp()` helper (note: this is a separate, near-duplicate implementation of the same parsing logic as `lib/utils.ts`'s `parseTimeToSeconds` — a small piece of duplicated logic worth being aware of, though functionally harmless since both parse the same formats identically).

### 16.5 `VideoNotes.tsx` and `VideoComments.tsx`
Both covered in depth in [§10](#10-collaboration-features-comments--notes).

### 16.6 `VideoDetailHeader.tsx`
**Purpose:** Title, owner info, and the action bar (copy link, add-to-collection, share modal, delete, visibility dropdown) atop the video detail page. **Owner-only UI:** the share modal, delete button, and visibility `<DropdownList>` only render `{isOwner && (...)}`. **The share modal** is a simple conditionally-rendered overlay (`{showShareModal && (...)}`), not a portal or a dedicated modal library — clicking the semi-transparent backdrop (`onClick={() => setShowShareModal(false)}`) closes it, while `e.stopPropagation()` on the inner card prevents clicks *inside* the modal from bubbling up and closing it.

### 16.7 `VideoCard.tsx`
**Purpose:** The reusable thumbnail-card used in every video grid (home page, profile page, playlist detail). **Notable:** the "copy link" button inside the card calls `e.stopPropagation(); e.preventDefault();` before copying — because the entire card is wrapped in a `<Link>` (clicking anywhere navigates to the video), the copy button needs to prevent that navigation from also firing when it's clicked.

### 16.8 `RecordScreen.tsx`
Covered extensively in [§6](#6-the-recording-engine). Additional structural note: this component renders the "Record a video" button *and* the full-screen modal/dialog that opens when clicked — both live in one file because the modal's state (`isOpen`) is entirely local to this component; no parent needs to know or control whether the studio is open.

### 16.9 `AddToPlaylist.tsx`, `PlaylistsManager.tsx`, `PlaylistDetail.tsx`
Covered in [§11](#11-collections-playlists).

### 16.10 `ChannelAnalyticsPanel.tsx`
**Notable:** this is an `async` Server Component (`const ChannelAnalyticsPanel = async ({ userId }) => { const stats = await getChannelAnalytics(userId); ... }`), not a client component — it fetches its own data server-side and needs no client-side interactivity (no buttons, no state), so there's no reason to ship any JavaScript for it to the browser at all. The horizontal bar chart for "Top Videos by Views" is hand-built with plain `<div>`s and inline `width` percentages — not a charting library — since it's a single simple visualization.

### 16.11 Small presentational components

| Component | Purpose |
|---|---|
| `FormField.tsx` | Renders an `<input>`, `<textarea>`, or `<select>` from one prop shape — avoids repeating label/wrapper markup for every form field in the app |
| `FileInput.tsx` | A styled file-picker with drag-to-click behavior and a live preview (video or image) once a file is chosen |
| `ImageWithFallback.tsx` | Wraps `next/image`; on an `onError` (broken/missing avatar URL), swaps to a local fallback image instead of showing a broken-image icon |
| `DropdownList.tsx` | A generic reusable dropdown (used for both the sort-filter and the visibility selector) — takes a `triggerElement` as a prop so the *button that opens it* can look different in each usage |
| `Pagination.tsx` | Renders page-number buttons, delegating the actual "which numbers to show" logic to `generatePagination()` in `lib/utils.ts` |
| `SharedHeader.tsx` | The header used at the top of the home page and profile page — title, search box, sort filter, and the record/upload buttons |
| `EmptyState.tsx` | A generic "nothing here yet" placeholder (icon + title + description), reused across empty video grids, empty transcripts, empty AI summaries, etc. |

---

## 17. Every Custom Hook

### 17.1 `useScreenRecording` (`lib/hooks/useScreenRecording.ts`)
The largest and most complex hook in the app. Covered exhaustively in [§6](#6-the-recording-engine). **Why a hook, not a class or a set of loose functions?** React hooks are the idiomatic way to bundle **stateful logic** (recording state, refs to the `MediaRecorder`/`AudioContext`/timers) with the **effects** that need to clean up on unmount (`useEffect(() => { return () => cleanup(); }, [])`) — a hook lets `RecordScreen.tsx` consume a clean `{ isRecording, startRecording, ... }` interface without knowing any of the underlying Canvas/Worker/IndexedDB plumbing.

**Its full public surface:**
```ts
{ isRecording, isPaused, elapsedSeconds, recordedBlob, recordedVideoUrl, recordingDuration, transcriptSegments,
  startRecording, pauseRecording, resumeRecording, stopRecording, resetRecording, restoreRecording }
```

### 17.2 `useFileInput` (`lib/hooks/useFileInput.ts`)
**Problem it solves:** both the video-file input and the thumbnail-image input on the upload page need the identical behavior (track the selected `File`, generate a preview URL, enforce a max size, extract video duration if applicable, and clean up the object URL when replaced/reset). Rather than writing that logic twice, it's extracted into one hook, parameterized by `maxSize`:
```ts
export const useFileInput = (maxSize: number) => {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  ...
  return { file, previewUrl, duration, inputRef, handleFileChange, resetFile };
};
```
**Why revoke object URLs?** `URL.createObjectURL(file)` allocates a reference that the browser must be told to release — `URL.revokeObjectURL(previewUrl)` is called both before replacing a file and inside `resetFile()`, preventing a memory leak where the browser keeps holding onto blob data that's no longer displayed.

---

## 18. Every Server Action (API Layer)

**Simple explanation:** A "Server Action" is a function that *looks* like it's running in the browser (you call it directly from a button's `onClick`), but the code inside it actually runs on the server, with direct database access. Next.js handles the network request behind the scenes automatically.

**Technical explanation:** every file in `lib/actions/` starts with the `"use server"` directive. This tells the Next.js/React compiler: every exported function in this file should be compiled into a server-only network endpoint (an HTTP POST under the hood, though the URL is never manually constructed — Next.js generates and calls it for you), and calling it from client code (e.g., `await addComment(...)` inside a button handler) is automatically turned into that network call, serializing arguments and the return value across the boundary.

### 18.1 `lib/actions/video.ts`

The largest action file — the core video CRUD plus AI processing, sharing, and chapters.

| Function | What it does | Auth check |
|---|---|---|
| `getVideoUploadUrl()` | Generates a signed Cloudinary upload URL + new `videoId` | Requires session |
| `getThumbnailUploadUrl(videoId)` | Same, for the thumbnail image; blocks issuing to a non-owner | Requires session + ownership (if video exists) |
| `saveVideoDetails(details)` | Validates and inserts the new video row | Requires session; validates all inputs (see [§22](#22-security-model)) |
| `getAllVideos(query, sort, page, pageSize)` | Public video library, paginated, with search | Public read, filtered by visibility |
| `getVideoById(videoId)` | Single video, respecting visibility rules | Public/owner-conditional read |
| `getVideoByShareToken(token)` | Single video via a valid, unexpired share token | Public read (token *is* the auth) |
| `getAllVideosByUser(userId, query, sort)` | A user's channel page videos | Public/owner-conditional read |
| `incrementVideoViews(videoId)` | `+1` on the views counter | No session required (anonymous share-link viewers count), but the video must be public, owned by the caller, or have a live share link |
| `processVideoAI(videoId)` | Runs the Gemini summary/chapters pipeline | Requires session |
| `saveVideoTranscript(videoId, segments)` | Persists a recording's captured transcript | Requires session + ownership |
| `updateVideoVisibility(videoId, visibility)` | Change public/private/link-only | Requires session + ownership |
| `deleteVideo(videoId)` | Deletes Cloudinary assets + DB row | Requires session + ownership |
| `generateShareToken(videoId, days)` | Creates a new random share link | Requires session + ownership |
| `revokeShareToken(videoId)` | Nulls out the share token | Requires session + ownership |
| `saveChapters(videoId, chapters)` | Owner-authored manual chapters | Requires session + ownership |

`lib/actions/edit.ts` holds the editor's actions ([§28](#28-the-one-take-editor)): `getEditorData` (owner-only read), `saveWordTranscript` and `saveEdit`, all of which require session + ownership and sanitize their input.

**The shared `withError` wrapper:**
```ts
function withError<T, A extends unknown[]>(fn: (...args: A) => Promise<T>) {
  return async (...args: A): Promise<T> => fn(...args);
}
```
Despite the name, this is currently a **pass-through** — it doesn't catch or transform errors today (an uncaught error inside `fn` still propagates as-is). It exists as a **seam**: every exported action in this file is wrapped in it, so a future change (e.g., centralized error logging, or converting thrown errors into a typed `{ success: false, error }` shape) can be made in exactly one place rather than edited into every individual function.

### 18.2 `lib/actions/comments.ts`, `notes.ts`, `playlists.ts`, `analytics.ts`

Each covered in depth in their respective feature sections ([§10](#10-collaboration-features-comments--notes), [§11](#11-collections-playlists), [§12](#12-analytics)). The consistent shape across all of them: a local `getSessionUserId()` helper (repeated per-file, not shared — a small duplication, since each file is otherwise self-contained) that throws `"Unauthenticated"` if there's no session, called at the top of every mutating function.

---

## 19. State Management Strategy

**There is no global state management library anywhere in this app** — no Redux, no Zustand, no Context API used for shared app state, no React Query/TanStack Query. This is a deliberate fit for the app's actual data-flow shape, not an oversight:

- **Server state lives on the server**, fetched fresh by Server Components on each navigation (the video list, a specific video's details, playlists, comments). Because Next.js Server Components can `await` a database call directly during render, there's no "fetch on mount, show a spinner" client-side data-fetching pattern needed for the *initial* load of any page — the HTML that arrives already has the data.
- **Client-side reads/writes after the initial load** (posting a comment, adding a chapter, toggling a playlist membership) go through direct Server Action calls from `"use client"` components, using plain `useState` to hold the result locally and update it optimistically or after the call resolves — e.g., `VideoComments.tsx`'s `setComments((prev) => [...prev, created])` after `addComment` succeeds.
- **Cross-component communication** (the video page's player being controlled by its sibling comments/notes/chapters panels) is handled via a `ref` passed down as a prop (`onSeek`, `getCurrentTime`), not a shared store — see [§9.3](#93-the-imperative-handle--talking-to-the-player-from-outside).
- **URL state** (search query, sort filter, current page) lives in the URL's query string, read via `useSearchParams()`, not in React state — see [§14.3](#143-why-url-driven-search-not-client-state).
- **Auth state** is provided reactively by better-auth's own `authClient.useSession()` hook — this *is* effectively a small built-in client cache/store, supplied by the auth library itself rather than hand-rolled.

**Why this is the right choice here, not a limitation:** a global client-side store earns its complexity when many *unrelated* components across the app need to read and react to the same piece of state, or when client-side data needs aggressive caching/invalidation across many independent fetches. This app's data is either (a) fetched once per Server Component render and handed down as props, or (b) genuinely local to one feature's component tree. Introducing Redux or React Query here would add machinery without solving a problem that actually exists in this codebase.

---

## 20. Every Library and Why It's There

| Library | Problem it solves | Files that use it | Simpler alternative considered | Trade-off |
|---|---|---|---|---|
| **next** (15.5.27) | The framework: routing, Server Components, Server Actions, bundling | Everywhere | A plain Vite + React SPA + a separate Express backend | Next.js couples frontend/backend into one deployable but ties the app to Vercel-style hosting conventions |
| **react / react-dom** (19.1) | UI rendering | Everywhere | — (required by Next.js) | — |
| **typescript** | Compile-time type checking | Every `.ts`/`.tsx` file | Plain JavaScript | Slower to write initially; catches entire classes of bugs (wrong prop shape, typo'd column name) before runtime |
| **drizzle-orm** (0.45) + **drizzle-kit** (0.31) | Type-safe SQL query building + schema migrations | `drizzle/*`, every `lib/actions/*.ts` | Raw SQL strings, or Prisma | Prisma has a friendlier migration UX but a heavier runtime and a separate schema-definition language; Drizzle's schema *is* TypeScript, and its query builder produces close-to-raw SQL |
| **@neondatabase/serverless** | An HTTP-based Postgres driver that works in serverless functions | `drizzle/db.ts`, `drizzle.config.ts` | `pg` (standard Postgres driver, needs a persistent TCP connection pool) | The standard `pg` driver doesn't cooperate well with serverless functions that spin up/down per-request; Neon's HTTP driver avoids connection-pool exhaustion |
| **better-auth** (1.7) | Session/OAuth/cookie handling | `lib/auth.ts`, `lib/auth-client.ts`, `middleware.ts` | Hand-rolled sessions + `next-auth`/Auth.js | Rolling your own auth is a well-known security risk (cookie handling, CSRF, token expiry are all easy to get subtly wrong); better-auth is a newer, actively-maintained alternative to Auth.js with first-class Drizzle adapter support |
| **cloudinary** (Node SDK) | Signed upload URL generation, asset deletion | `lib/cloudinary.ts` | Self-hosted file storage (e.g., raw S3) | Self-hosting video means building your own transcoding, thumbnailing, and CDN — Cloudinary's free tier includes all of that |
| **@google/generative-ai** | Calling the Gemini API | `lib/gemini.ts` | OpenAI's API | Gemini 2.0 Flash has a genuinely free tier suitable for this app's low-volume, non-chat usage pattern |
| **clsx** + **tailwind-merge** | Conditionally joining CSS class name strings, and de-duplicating conflicting Tailwind classes | `lib/utils.ts`'s `cn()` helper, used throughout components | Manual template-string concatenation | Without `tailwind-merge`, passing both a default `"p-2"` and an override `"p-4"` class would leave *both* in the DOM, and CSS's cascade order (not intent) would decide which wins; `tailwind-merge` resolves the conflict correctly by class *meaning* |
| **dotenv** | Loading `.env.local` into `process.env` for CLI tools | `drizzle.config.ts` (drizzle-kit runs outside Next.js's own env-loading) | — | Next.js itself loads `.env.local` automatically at runtime; `drizzle-kit` is a separate CLI tool that needs its own explicit loading |
| **vitest** | Unit test runner | `tests/*.test.ts`, `vitest.config.ts` | Jest | Vitest shares Vite's fast dev-server transform pipeline and has near drop-in Jest-compatible APIs (`describe`/`it`/`expect`), with faster cold-start times |
| **eslint** + **eslint-config-next** + **eslint-config-prettier** | Linting — catching likely bugs and enforcing style | `next.config.ts` build step | — | `eslint-config-prettier` specifically *disables* ESLint's own formatting rules so they don't conflict with Prettier's opinions |
| **prettier** | Code formatting | Whole repo (via editor integration, not wired into the build) | — | — |
| **tailwindcss** (v4) + **@tailwindcss/postcss** | Utility-first CSS | `app/globals.css` | Hand-written CSS, or a component library (MUI, Chakra) | Tailwind v4's newer engine defines design tokens directly in CSS (`@theme { ... }`) rather than a separate JS config file — see [§21.4](#214-appglobalscss) |

---

## 21. Every Configuration File

### 21.1 `package.json`
Defines five scripts: `dev` (turbopack-powered dev server — Turbopack is Next.js's newer, faster Rust-based bundler, opt-in via `--turbopack`), `build`, `start`, `lint`, `test`, and `typecheck`. The dependency/devDependency split follows the standard convention: anything imported by application code at runtime is a `dependency`; anything only used for building, testing, or linting is a `devDependency`.

### 21.2 `tsconfig.json`
Key settings and their effect:
- `"strict": true` — enables the full set of TypeScript's strictness checks (no implicit `any`, strict null checks, etc.) — this is what makes a function like `requiredString(value: unknown, ...)` in `lib/validate.ts` *necessary*, since `strict` mode won't let you treat an `unknown` value as a `string` without an explicit check.
- `"moduleResolution": "bundler"` — tells TypeScript to resolve imports the way a modern bundler (Next.js's Webpack/Turbopack) would, rather than mimicking Node.js's older CommonJS resolution rules.
- `"paths": { "@/*": ["./*"] }` — defines the `@/` import alias used everywhere (`import { db } from "@/drizzle/db"`) instead of fragile relative paths like `../../../drizzle/db`.
- `"jsx": "preserve"` — leaves JSX syntax untouched for Next.js's own compiler to transform, rather than TypeScript itself compiling it.

### 21.3 `next.config.ts`
```ts
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), display-capture=(self), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];
const nextConfig: NextConfig = {
  images: { remotePatterns: [ /* only Cloudinary + Google avatars */ ] },
  async headers() { return [{ source: "/(.*)", headers: securityHeaders }]; },
  experimental: { serverActions: { bodySizeLimit: "50mb" } },
};
```
Each header's purpose: `X-Frame-Options: DENY` prevents the site from being embedded in an `<iframe>` on another site (a clickjacking defense). `X-Content-Type-Options: nosniff` stops the browser from guessing a file's content type differently than the server declared (a defense against certain XSS vectors). `Permissions-Policy` explicitly scopes camera/microphone/screen-capture access to same-origin use only — meaningful here because the app *does* request those permissions (for recording), so an explicit, narrow policy is more meaningful than a blanket allow.

`images.remotePatterns` is a Next.js requirement: the built-in `<Image>` optimizer refuses to fetch and resize images from arbitrary external hosts unless they're explicitly allowlisted — this app allows exactly `res.cloudinary.com` (video thumbnails) and `lh3.googleusercontent.com` (Google profile photos), and nothing else, closing off the possibility of the deployment being abused as a free image-proxy for unrelated hosts.

`serverActions.bodySizeLimit: "50mb"` — Server Actions have a default request-body size cap; this is raised because some payloads passed through actions (though not the video files themselves, which bypass the server entirely via direct-to-Cloudinary upload) could otherwise be rejected.

### 21.4 `app/globals.css`
A single ~1260-line stylesheet using **Tailwind CSS v4**. Two things worth understanding about its structure:
- `@theme { --color-pink-100: #ff4393; ... }` — Tailwind v4's newer approach to design tokens: colors, shadows, and radii are declared directly as CSS custom properties inside a special `@theme` block, and Tailwind generates utility classes (`bg-pink-100`, `shadow-10`) from them automatically — no separate `tailwind.config.js` needed.
- `@layer components { .video-player { @apply ...; nested-selector { @apply ...; } } }` — component-level classes (one per major UI piece: `.navbar`, `.video-card`, `.chapters-container`, etc.) are defined using Tailwind's `@apply` directive *inside* nested CSS, giving each component a single semantic class name in the JSX (e.g., `className="video-card"`) while the actual utility classes live centralized in the stylesheet — a middle ground between "utility classes inline in every JSX file" and "fully hand-written CSS."

### 21.5 `index.d.ts`
Every shared TypeScript interface (component props, database-result shapes, recording/analytics types) lives in one file, wrapped in `declare global { ... }`. **Why this unusual pattern, instead of `export interface` + explicit imports everywhere?** The file itself starts with `import type { ImageProps } from "next/image";` — the moment a file has a top-level `import`, TypeScript treats it as a *module*, and anything declared inside would normally be scoped to that module, requiring every consumer to `import type { VideoCardProps } from "@/index"` individually. Wrapping the declarations in `declare global { }` makes them **ambient** — ("ambient" meaning: available everywhere, without an import) — ii.e., ambiently available to every `.ts`/`.tsx` file in the project without any import statement at all. The trade-off: it's a global namespace, so every interface name must be unique across the *entire* app (there's no per-file scoping), which is a real cost as the app grows, but for ~20 components' worth of prop types it keeps every component file free of prop-type import boilerplate.

### 21.6 `drizzle.config.ts`
Points `drizzle-kit` (the CLI tool used to generate/push schema migrations) at `drizzle/schema.ts` as the source of truth and at `DATABASE_URL` for the target database. Loads `.env.local` explicitly via `dotenv`'s `config()` because `drizzle-kit` runs as a standalone CLI process outside of Next.js's own request lifecycle, so it doesn't get Next.js's automatic environment-variable loading for free.

### 21.7 `vitest.config.ts`
Configures the test runner to look for tests only in `tests/**/*.test.ts`, in a Node.js environment (not a simulated browser DOM, since the tests here — see [§23](#23-testing--ci) — exercise pure functions, not React components), and mirrors the same `@/` path alias from `tsconfig.json` so test files can import app code the same way application code does.

### 21.8 `.env.example`
Documents every environment variable the app needs, grouped by service, with inline comments on where to obtain each one and links to each provider's free-tier signup. No actual secrets are committed — `.gitignore` explicitly excludes `.env`, `.env.local`, and `.env*.local`.

### 21.9 `.github/workflows/ci.yml`
```yaml
on: { push: { branches: [main] }, pull_request: { branches: [main] } }
jobs:
  verify:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4  # node 22, npm cache
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
        env: { NEXT_PUBLIC_BASE_URL: https://snapcast-video-sharing.vercel.app }
```
Runs on every push and pull request against `main`: install → typecheck → unit tests → production build, in that order, each step gating the next (a typecheck failure means tests never even run, saving CI minutes). The build step needs no real secrets because every external service client in this app initializes **lazily** (see [§22.4](#224-lazy-initialization-as-a-security--reliability-pattern)) — only the public base URL is read at build time, for `metadataBase`.

---

## 22. Security Model

This section consolidates security decisions that are scattered contextually throughout the rest of the document, for anyone specifically auditing "how is this app protected."

### 22.1 The layered authorization model

1. **`middleware.ts`** — blanket gate: no session, no access to any page except sign-in/share/static assets.
2. **Server Action-level checks** — every mutating action re-derives the session server-side (`getSessionUserId()`) and compares the resulting user id against the row's `userId`/`ownerId` column in the same database query (`and(eq(table.id, id), eq(table.userId, userId))`) — never trusting a client-supplied "I am the owner" flag.
3. **Query-level visibility filtering** — read operations (`getVideoById`, `getAllVideos`) bake the public/private/owner check directly into the `WHERE` clause, so a private video never even leaves the database for an unauthorized reader — there's no "fetch then check in JavaScript" step that could be forgotten.
4. **`lib/authz.ts` — cross-feature video access checks.** Ownership scoping (layer 2) protects the *video* row itself, but features that hang off a video — comments, notes, playlist membership, watch events, AI processing — write to their *own* tables, so an ownership-scoped `WHERE` on those tables proves nothing about whether the caller may see the underlying video. This module centralizes that question:

   | Helper | Rule | Used by |
   |---|---|---|
   | `canViewVideo(access, userId)` | public, or caller owns it — mirrors `getVideoById` | `getComments` |
   | `assertVideoReadable(videoId, userId)` | throws unless readable; same error for "missing" and "forbidden" so ids can't be probed | `addComment`, `createNote`, `addVideoToPlaylist`, `processVideoAI` |
   | `assertVideoCountable(videoId, userId)` | readable **or** reachable via a live share link — deliberately looser, because anonymous share-link viewers generate legitimate analytics | `recordWatch` |

   The looser third rule exists because visibility and *countability* genuinely differ: a `link-only` video is not browsable by a stranger, but a stranger holding a valid share link is a real viewer whose watch time should be recorded.

### 22.2 Input validation at every network boundary

`lib/validate.ts` provides `requiredString`, `optionalString`, `clampInt`, and `assertVisibility` — all deliberately paranoid, because **Server Actions are, despite the ergonomic syntax, real public HTTP endpoints**. A client-side TypeScript type (`VideoDetails`, `Chapter`, etc.) only constrains what *this app's own frontend* sends — nothing stops a malicious actor from POSTing arbitrary JSON directly to the underlying endpoint URL. Every action that accepts user-controlled fields re-validates them from scratch:
```ts
export function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} cannot be empty`);
  if (trimmed.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}
```
Shared numeric ceilings live in one `LIMITS` object (`maxTimestampSeconds`, `maxWatchSeconds`, `maxTranscriptSegments`, etc.), so e.g. a client couldn't submit a comment with a timestamp of `999999999` seconds, or a transcript with 50,000 segments, both of which are clamped/truncated server-side regardless of what's sent.

### 22.3 Trust boundaries around external services

- **Cloudinary URLs are re-validated on save** (must start with this app's own `cloud_name` prefix) — see [§7.2](#72-the-authorization-checks-around-signed-urls).
- **AI output is never trusted structurally** — every Gemini response is JSON-parsed inside a `try/catch`, with the caught path treated as "no result" rather than propagating a parse error, and chapter timestamps are explicitly clamped/sorted/de-duplicated after parsing (see [§8.4](#84-generatechapters--the-more-carefully-validated-one)).
- **Signed upload URLs are scoped to one exact `public_id`**, not a general-purpose credential — see [§7.1](#71-why-upload-directly-to-cloudinary-not-through-this-apps-server).

### 22.4 Lazy initialization as a security & reliability pattern

```ts
// drizzle/db.ts
let _db: DB | null = null;
function getDatabase(): DB {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL environment variable is not set");
    _db = drizzle(neon(url), { schema });
  }
  return _db;
}
export const db: DB = new Proxy({} as DB, { get(_, prop) { return Reflect.get(getDatabase(), prop); } });
```
The database client (and, identically, the Cloudinary and Gemini clients) is **not** constructed the instant this module is imported — it's built on first actual use, behind a `Proxy` that intercepts every property access and lazily calls `getDatabase()`. **Why this matters:** Next.js's build process imports every module in the app to statically analyze it, *even for pages that will run dynamically at request time*. If `drizzle(neon(process.env.DATABASE_URL))` ran at module-import time, the production **build** itself would fail in any environment without real database credentials configured (like CI) — see [§21.9](#219-githubworkflowsciyml), where the build step deliberately has no `DATABASE_URL` set at all, and still succeeds because nothing tries to actually connect until a real request comes in.

### 22.5 Dependency vulnerabilities

Third-party code is part of the attack surface. `npm audit` is the check; what matters is whether an advisory is *reachable* in this app, not the raw count.

| Upgrade | Why it applied here |
|---|---|
| `next` 15.5.19 → 15.5.27 | Critical unauthenticated RCE in the Image Optimization API with AVIF files. Every thumbnail and avatar in this app goes through `next/image`. Also Server Action DoS/SSRF fixes, and this app's whole backend is Server Actions. |
| `better-auth` 1.2.7 → 1.7.7 | Fixes for the OAuth callback accepting a mismatched `state`, and account takeover via OAuth auto-linking — both on the Google sign-in path this app uses. Most other advisories were in plugins this app doesn't load (2FA, OIDC provider, magic links). |
| `drizzle-orm` 0.42 → 0.45.3 | Forced by the above: better-auth 1.7's Drizzle adapter declares a peer dependency on `drizzle-orm ^0.45.2`. Installed without `--force`/`--legacy-peer-deps`, which would have run the adapter against an ORM version it doesn't support. |

Before relying on the auth upgrade, the fields better-auth 1.7 requires (`getAuthTables` for this config) were diffed against the live database: all present, so no migration was needed. Production audit after: **0 critical**. The remaining highs are a `postcss` copy pinned inside Next 15 (fixed only in Next 16) — it processes this repository's own stylesheet at build time, so it isn't reachable from user input — and `brace-expansion` in tooling.

### 22.6 Known remaining risks

| Risk | Status |
|---|---|
| **View-count inflation** | `incrementVideoViews` checks *who* may count a view, not *how often*. A legitimate viewer can refresh repeatedly. A real fix needs per-user rate limiting or a dedup window, which needs a shared store the free-tier setup doesn't have. |
| **Error messages in production** | Next.js documents that it replaces Server Action error messages with a generic message in production builds, so validation errors like "Title must be at most 200 characters" likely surface on the upload form as a generic error. Not reproduced here. The fix is returning `{ error }` results instead of throwing — the `withError` seam exists for exactly that. |
| **`timestamp without time zone` columns** | Drizzle writes and reads these as UTC, so the app is consistent. But the raw `neon()` driver serializes JS `Date`s in the host's local timezone with an offset, which Postgres silently drops for this column type — any future raw-SQL code comparing timestamps would be off by the host's UTC offset. Migrating to `timestamptz` removes the trap. |
| **Edited-out material is still in the source file** | Edits are non-destructive: SnapCast skips cuts, but the original Cloudinary URL still holds the full recording ([§28.11](#2811-security-and-validation)). Exporting and re-uploading produces a file without it. |
| **No Content-Security-Policy** | Other security headers are set (§21.3); a CSP needs nonce plumbing for Next's inline scripts, so it isn't a one-line addition. |

---

## 23. Testing & CI

### 23.1 What's actually tested

Nine suites, 108 tests, all **pure functions**. The five editor suites (`edl`, `silence`, `align`, `sanitize`, `editing`; 64 tests) cover the cut-list math, undo/redo, pause detection on deterministic synthetic signals, Whisper word alignment against **real model output**, and edit-payload sanitization (see [§28](#28-the-one-take-editor)). The original three: `tests/validate.test.ts` (`requiredString`, `optionalString`, `clampInt`, `assertVisibility`), `tests/authz.test.ts` (`canViewVideo`, `hasLiveShareLink` — the access predicates from [§22.1](#221-the-layered-authorization-model)), and `tests/utils.test.ts` (`formatDuration`, `generatePagination`, `parseTranscript`, `updateURLParams`, `daysAgo`, `parseTimeToSeconds`). These are deliberately chosen because they're **deterministic and side-effect-free** — given the same input, they always produce the same output, with no database, network, or browser API involved, making them fast and trivial to assert against.

A representative test, showing the *kind* of edge case these guard against:
```ts
it("handles junk input by returning the minimum", () => {
  expect(clampInt("abc", 0, 10)).toBe(0);
  expect(clampInt(NaN, 2, 10)).toBe(2);
  expect(clampInt(Infinity, 0, 10)).toBe(0);
  expect(clampInt(undefined, 1, 10)).toBe(1);
});
```
This test exists precisely *because* `clampInt` is the first line of defense against malicious/malformed Server Action input (see [§22.2](#222-input-validation-at-every-network-boundary)) — if it silently returned `NaN` or threw on garbage input instead of falling back to `min`, every caller relying on it for safety would be compromised.

### 23.2 What's deliberately *not* tested

There are no tests for React components, Server Actions (which require a live database connection), or the recording/player browser APIs — these would require either a real browser environment (e.g., Playwright) or extensive mocking of `MediaRecorder`/`IndexedDB`/`fetch`, which wasn't judged to be worth the CI-time cost relative to the actual regression risk for a project at this stage. This is a conscious trade-off, not an oversight — see [§26](#26-interview-question-bank) for how to discuss it if asked.

Some database-level behavior was verified with **one-off** integration tests that were run and then deleted, rather than kept in the suite: the AI-processing claim (25 concurrent callers per case, through Drizzle, against a scratch table), the ORM upgrade's query shapes, and better-auth 1.7's session lookup. They weren't kept because the only database is production and CI has no database at all. The natural next step is a free Neon branch as a dedicated test database, which would let those tests run in CI.

### 23.3 The CI pipeline

Covered in [§21.9](#219-githubworkflowsciyml). The ordering — typecheck, then test, then build — is deliberate: each step is progressively more expensive in CI minutes, so cheap, fast checks fail first, giving quicker feedback and not wasting a full production build on code that doesn't even typecheck.

---

## 24. Concept Deep Dives (Beginner → Advanced)

### 24.1 React State

**Simple explanation:** Imagine a whiteboard that automatically redraws itself the instant you write something new on it. "State" is a value the app remembers, and the moment it changes, whatever's showing that value on screen updates too — without you manually erasing and rewriting it.

**Technical explanation:** `useState` returns a value and a setter function. Calling the setter schedules React to re-run the component function with the new value, then **reconciles** the result against what's currently on screen — comparing the new "virtual DOM" tree against the old one and applying only the minimal set of real DOM changes needed, rather than tearing down and rebuilding the whole page.

**Where in this app:** `VideoPlayer.tsx`'s `currentTime` state is the clearest example — the browser's native `<video>` element fires a `timeupdate` event roughly 4 times per second; each time, `setCurrentTime(v.currentTime)` runs, and React re-renders just the small pieces of UI that depend on it (the timestamp label, the seek-bar thumb position) — not the entire player.

### 24.2 Server Components vs. Client Components

**Simple explanation:** A "Server Component" is a piece of the page that's built once, on the server, using real data — like a chef plating a dish in the kitchen before it reaches your table. A "Client Component" is a piece that keeps working *after* it reaches you — like a dish with a built-in flame you can adjust yourself.

**Technical explanation:** By default, every component in the Next.js App Router is a Server Component — it runs *only* on the server, can directly `await` a database call, and sends the resulting HTML to the browser; **no JavaScript for that component is shipped to the client at all**. Adding `"use client"` at the top of a file opts it (and everything it imports) into being a Client Component — bundled as JavaScript, sent to the browser, and re-executed there so it can hold state and respond to events.

**Where in this app:** `app/(root)/page.tsx` (no `"use client"`) fetches videos directly with `await getAllVideos(...)` — this code genuinely never runs in the visitor's browser. `components/VideoPlayer.tsx` (`"use client"` at the top) *must* run in the browser, because it manipulates a real `<video>` DOM element, tracks live playback state, and responds to clicks — none of that is possible on a server, which has no concept of "the user's mouse" or "the video currently playing."

### 24.3 Hydration

**Simple explanation:** The server sends a fully-drawn picture of the page (HTML). Hydration is the moment React "wakes up" that static picture in the browser and attaches real, working buttons and interactivity to it — like handing someone a photograph and then, a second later, making it move and respond to touch.

**Technical explanation:** After the browser paints the server-sent HTML, React runs client-side, walks the same component tree, and attaches event listeners to the *existing* DOM nodes (rather than re-creating them from scratch) — provided the client-rendered output matches what the server produced. A mismatch between server and client output ("hydration mismatch") is a common class of bug in server-rendered React apps.

**Where in this app:** every page load involves hydration for at least the interactive pieces — e.g., `VideoCard`'s copy-link button isn't clickable the literal instant HTML paints; it becomes clickable once React attaches its `onClick` handler during hydration, typically imperceptibly fast on a modern connection.

### 24.4 Optimistic UI

**Simple explanation:** Instead of showing a spinner and waiting for confirmation before updating what you see, the app assumes the action will succeed and updates the screen *immediately* — like a cashier handing you your receipt before the card payment technically finishes processing, because it almost always goes through.

**Technical explanation:** the UI state is updated synchronously, in response to a user action, *before* the corresponding Server Action's Promise has resolved — the actual network call happens in the background (often inside React's `startTransition`, marking it as a non-urgent update).

**Where in this app:** `AddToPlaylist.tsx`'s `toggle()` flips the checkbox's visual state in `setMemberIds` immediately, then fires the actual `addVideoToPlaylist`/`removeVideoFromPlaylist` Server Action inside `startTransition` — if that call fails, the current code does **not** roll back the optimistic UI change (a known simplification, not a masked bug — worth mentioning if asked "what would you improve").

### 24.5 Promises & Async/Await

**Simple explanation:** A `Promise` is a placeholder for a value that isn't ready yet but will be — like a claim ticket at a dry cleaner. `async`/`await` is a way of writing code that *waits* for that ticket to be redeemable before moving to the next line, without freezing the entire program while it waits.

**Technical explanation:** every Server Action in this app is an `async function`; calling one returns a Promise that resolves once the database round-trip (or Gemini API call) completes. `await` pauses execution of the *calling* function until that Promise settles, while the JavaScript event loop remains free to do other work (like keep the UI responsive) in the meantime.

**Where in this app:** `processVideoAI`'s `await analyzeVideoContent(context)` — this line does not block the entire server process; it suspends just this one function invocation while the network call to Google's API is in flight.

### 24.6 REST APIs vs. Server Actions

**Simple explanation:** A traditional API is like a restaurant with a fixed menu of items you can order by name (`GET /videos/123`); you and the kitchen both have to agree on the menu in advance. A Server Action is more like calling a friend who happens to work in the kitchen directly — you just describe what you want in the same "language" (function calls) you already use everywhere else in the code.

**Technical explanation:** This app has **no REST or GraphQL API layer at all** (aside from better-auth's own internal `/api/auth/*` route, which the app itself never calls directly). Every "backend" interaction is a Server Action — an ordinary async function, marked `"use server"`, that the Next.js/React compiler transforms into a network-callable endpoint automatically, with argument/return-value serialization handled transparently. This removes an entire layer of boilerplate (defining routes, parsing request bodies, matching HTTP methods) that a traditional REST API would require — at the cost of being a Next.js-specific pattern, not a general-purpose API other, non-Next.js clients (a mobile app, a third-party integration) could call.

### 24.7 JWT and Sessions

**Simple explanation:** After you log in, the server needs a way to recognize you on your *next* request without asking for your password again. It's like getting a wristband at a festival — you show it once, and it's checked at every gate afterward without re-verifying your ticket each time.

**Technical explanation:** This app uses **session-based** auth (a `session` table row + an HttpOnly cookie holding the session token), *not* self-contained JWTs for its own session mechanism — better-auth stores sessions server-side in Postgres, so a session can be invalidated (e.g., forced logout) by simply deleting its row, something a stateless JWT can't do without an additional revocation list. (JWTs *are* involved internally in the OAuth handshake with Google, in the `account` table's `accessToken`/`refreshToken`/`idToken` columns — but that's Google's token for talking to Google's APIs, not this app's own session mechanism.)

### 24.8 Caching & Revalidation

**Simple explanation:** Once a page has been built once, showing it again from a saved copy is much faster than rebuilding it from scratch every time — as long as nothing important has changed since it was saved.

**Technical explanation:** most pages in this app declare `export const dynamic = "force-dynamic"`, explicitly opting **out** of Next.js's default static/cached rendering, because their content (the video library, a user's channel) changes on essentially every write. Where mutations happen, `revalidatePath("/video/xyz")` (used throughout `lib/actions/*.ts`) explicitly tells Next.js "the cached version of this specific path is now stale, rebuild it on next request" — a more surgical alternative to disabling caching everywhere.

### 24.9 Streaming & Suspense

**Simple explanation:** Instead of making a visitor wait for the *entire* page's data before showing anything, the server can send the parts that are ready immediately, and "fill in" the slower parts a moment later — like a restaurant bringing out appetizers while the main course is still cooking, rather than making you wait for everything at once.

**Technical explanation:** `app/(root)/loading.tsx` is Next.js's file-convention hook into React's `<Suspense>` mechanism — while the sibling `page.tsx`'s data-fetching is in flight, Next.js streams the `loading.tsx` skeleton to the browser first, then streams the real content in to replace it once ready, all within a single HTTP response (HTTP streaming), rather than the browser waiting on one monolithic response.

### 24.10 Web Workers

**Simple explanation:** JavaScript in a browser tab normally runs on one single "thread" — if something takes a long time, everything else (including the page's own responsiveness) waits for it. A Web Worker is a separate, independent thread the main page can hand small jobs off to, so long-running work doesn't freeze the tab, and — critically here — that separate thread keeps running even if the tab itself is in the background.

**Technical explanation, and where this app uses it:** covered fully in [§6.3](#63-a-real-bug-this-app-hit-and-how-it-was-fixed) — the canvas-compositing draw loop is driven by a `setInterval` running *inside* a Worker (not the main thread), specifically because browsers throttle/suspend main-thread timers and `requestAnimationFrame` for hidden tabs, but do not apply that same throttling to a Worker's independent execution context.

The editor ([§28](#28-the-one-take-editor)) uses two more Workers, for a different reason: CPU-heavy work. Whisper inference and WebCodecs export would each freeze the page for seconds on the main thread. Both are module workers created with `new Worker(new URL("./x.worker.ts", import.meta.url), { type: "module" })`, which Next bundles into separate chunks, so the editor page itself stays ~12 kB.

### 24.11 Database Normalization vs. Denormalization

**Simple explanation:** "Normalizing" data means splitting it into separate, connected tables (like a video's chapters living in their own table, linked by an ID) to avoid repeating information. "Denormalizing" means keeping related data bundled together in one place, even if it's technically a list, because it's always used together anyway.

**Technical explanation, and where this app makes the trade-off deliberately:** covered in [§4.2](#42-the-complete-schema) — `chapters` and `transcriptSegments` are stored as `jsonb` columns directly on the `videos` row (denormalized), while `comments`, `notes`, and `video_views` are genuinely separate tables (normalized), each with its own foreign key back to `videos`. The dividing line applied here: **normalize when the child data has its own independent lifecycle or needs its own queries** (a comment has its own author, gets deleted independently, might one day need "show me all comments by user X across every video"); **denormalize when the data is small, always read/written as a unit with its parent, and never queried on its own.**

### 24.12 RAG (Retrieval-Augmented Generation) — and why this app does *not* use it

Worth defining even though it's *absent* here, since it's a common follow-up question: RAG is a pattern where an AI model's prompt is augmented with relevant documents retrieved from a search index (often a vector database) *before* generation, so the model can answer using information it wasn't originally trained on. **This app has no vector database, no embeddings, and no retrieval step** — every Gemini call in `lib/gemini.ts` is a single, direct prompt using only that one video's own transcript/metadata as context. This is a deliberate scope boundary: summarizing *one* video's own content doesn't need retrieval from a broader corpus; RAG would only become relevant if this app added a feature like "search across the meaning of all my videos," which it currently does not have (search is keyword/`ILIKE`-based — see [§14](#14-search)).

---

## 25. Complete User-Action Traces

### 25.1 Recording and uploading a video

```
Click "Record a video"
  ↓
RecordScreen.tsx: setIsOpen(true) → studio modal renders
  ↓
Check withMic / withCamera / PiP position+shape+size
  ↓
Click "Record" → beginCountdown() → 3, 2, 1, "Go" (useEffect + setTimeout chain)
  ↓
countdown reaches 0 → startRecording({ withMic, withCamera, pipPosition, pipShape, pipSize })
  ↓
useScreenRecording hook:
  - getMediaStreams() → browser's native screen-picker UI appears
  - user selects a screen/window/tab → displayStream returned
  - (if camera) getUserMedia() for webcam
  - (if camera) composite screen+webcam onto <canvas>, driven by Worker ticker
  - new MediaRecorder(finalStream) → recorder.start(1000)
  - (if mic) createTranscriber() → Web Speech API starts listening
  ↓
Every second: recorder.ondataavailable fires
  → chunk pushed to chunksRef AND persisted to IndexedDB (crash recovery)
  ↓
User clicks "Stop" → stopRecording() → recorder.stop()
  ↓
recorder.onstop → handleRecordingStop()
  → blob assembled from all chunks → recordedVideoUrl set (object URL)
  → transcriptSegments pulled from the transcriber
  ↓
User previews the recording, clicks "Continue to Upload"
  ↓
goToUpload(): blob is re-read via FileReader, re-packaged as a fresh Blob,
  stored (as a blob URL + metadata + transcript) in sessionStorage
  ↓
router.push("/upload")
  ↓
UploadPage's useEffect reads sessionStorage → fetches the blob URL back →
  reconstructs a File object → populates the video-file input
  ↓
User fills in title, description, tags, visibility → clicks "Upload Video"
  ↓
onSubmit():
  1. getVideoUploadUrl() [Server Action] → { videoId, signed Cloudinary params }
  2. uploadToCloudinary(videoFile, params, onProgress) [XHR, direct to Cloudinary]
     → live % progress bar updates
  3. (thumbnail: either user-provided, uploaded the same way, or Cloudinary's
     auto-generated frame URL is used)
  4. saveVideoDetails({...}) [Server Action] → validates everything, INSERTs the row
  5. saveVideoTranscript(videoId, segments) [Server Action] → if a transcript exists
  ↓
router.push(`/video/${videoId}`)
  ↓
Video detail page loads → VideoPlayer's onCanPlay fires → handleVideoReady()
  → processVideoAI(videoId) [Server Action]
    → Gemini generates summary/tags (+ chapters, if transcript exists)
    → DB updated, processingStatus: "ready"
  → page refetches the video → summary/chapters now visible
```

### 25.2 Watching and commenting on a video

```
User opens /video/abc123 (or clicks a video card)
  ↓
middleware.ts checks session → present → request proceeds
  ↓
VideoDetailPage (Client Component) mounts
  → useEffect: getVideoById(videoId) [Server Action]
    → query checks visibility (public, or owner match) → returns video+user, or null
  → if null: router.replace("/") (video doesn't exist or isn't visible to this user)
  ↓
VideoPlayer renders with videoUrl + chapters
  → onCanPlay fires (video metadata + first frame ready) → handleVideoReady()
    → processVideoAI() (skipped if already processingStatus:"ready")
  ↓
User clicks play → togglePlay() → v.play()
  → onTimeUpdate fires ~4x/sec:
    - setCurrentTime(v.currentTime) → seek-bar UI updates
    - maxWatchedRef updated
    - at t>3s (once): incrementVideoViews(videoId) [Server Action] → views+1
  ↓
User scrolls to VideoComments, types in the composer
  → onFocus (first time): capturedTs = current playback second
  → types text, checks "at 0:42" is correct
  → clicks "Comment" → handlePost()
    → addComment(videoId, text, capturedTs, null) [Server Action]
      → validates content length, clamps timestamp
      → INSERTs the row, fetches author name/image
      → returns the new CommentWithUser
    → setComments([...prev, created]) → new comment renders immediately
  ↓
Another visitor clicks the "0:42" chip on that comment
  → onSeek(42) → playerRef.current.seekTo(42) → v.currentTime = 42; v.play()
  ↓
User navigates away (or closes the tab)
  → "pagehide" event fires → flushWatch()
    → recordWatch(videoId, maxWatchedSeconds, completed, anonId) [Server Action]
      → INSERTs one row into video_views
```

### 25.3 Generating and using a share link

```
Video owner clicks the "Share" icon on their own video's detail header
  ↓
VideoDetailHeader: setShowShareModal(true) → modal renders
  ↓
No existing share token → shows "Generate share link" button
  ↓
Click it → handleGenerateShareLink()
  → generateShareToken(videoId) [Server Action]
    → checks session + ownership
    → token = crypto.randomUUID()
    → expiry = now + 7 days (default)
    → UPDATE videos SET share_token=token, share_token_expiry=expiry
    → returns { token, expiry, shareUrl }
  → setShareToken(token) → modal now shows the URL + "Copy" button
  ↓
Owner copies the link, sends it to someone outside the app (e.g., over email)
  ↓
Recipient (NOT logged in, possibly no account at all) opens the link
  ↓
middleware.ts: matcher explicitly excludes "share" → NO auth redirect happens
  ↓
SharePage (Server Component):
  → generateMetadata(): getVideoByShareToken(token) → builds Open Graph preview
    (this runs even before the page body, for link-preview crawlers)
  → Page body: getVideoByShareToken(token) again
    → checks token match AND shareTokenExpiry > now()
    → if expired/invalid: renders "Link Expired" state
    → if valid: renders the same <VideoPlayer/> used on the authenticated page
  ↓
Recipient watches the video — incrementVideoViews and recordWatch both fire
  exactly as they would for a logged-in viewer, with recordWatch using an
  anonymous localStorage id instead of a viewerId
  ↓
(Later) Owner clicks "Revoke link" in the share modal
  → revokeShareToken(videoId) [Server Action]
    → UPDATE videos SET share_token=NULL, share_token_expiry=NULL
  → the old URL, if visited again, now matches zero rows → "Link Expired"
```

---

## 26. Interview Question Bank

### Beginner

**Q: What is this app, in one sentence?**
A browser-based screen recording and video sharing platform (similar to Loom) with AI-generated summaries/chapters, a custom video player, and timestamp-pinned collaboration features (comments and private notes), built on Next.js and Postgres.

**Q: Why use React state instead of just changing HTML directly?**
Directly mutating the DOM (e.g., `document.getElementById(...).innerText = ...`) works but doesn't scale — you'd have to manually track every place that value is displayed and update each one, and manually keep them in sync with the underlying data. `useState` centralizes "what is true right now" in one place, and React handles propagating that to every part of the UI that depends on it.

**Q: What happens after a user clicks "Sign in with Google"?**
See [§5.3](#53-the-login-flow-traced-end-to-end) — `authClient.signIn.social()` redirects to Google, Google redirects back to a better-auth-owned callback route, which creates/updates the `user`/`account`/`session` rows and sets a cookie, then redirects to the home page.

**Q: Why does the app show a skeleton loading state instead of a blank page?**
`app/(root)/loading.tsx` is shown automatically by Next.js while the actual page's data-fetching (a database query) is still in progress — see [§24.9](#249-streaming--suspense). It's better UX than a blank white screen, and better than a generic spinner because it hints at the shape of the content that's coming.

### Intermediate

**Q: Explain hydration in the context of this app.**
See [§24.3](#243-hydration). Concretely: the home page's video grid HTML is fully rendered server-side (with real titles, thumbnails, view counts already in the markup) before it reaches the browser. Hydration is the moment React "wakes up" that HTML and attaches the actual `onClick` handlers (e.g., navigating when a `<VideoCard>` is clicked) — before hydration completes, the page *looks* interactive but isn't quite yet, for a very brief window.

**Q: Why use Server Actions instead of a traditional REST API?**
See [§24.6](#246-rest-apis-vs-server-actions). Because this app has exactly one client (its own Next.js frontend), there's no need for a general-purpose API contract that other consumers would rely on — Server Actions eliminate an entire layer of route definitions and request/response parsing boilerplate that would otherwise be needed for zero actual benefit in this app's context.

**Q: Walk me through what happens when someone clicks "Delete" on a video.**
`VideoDetailHeader`'s `handleDelete` shows a `confirm()` dialog; on confirm, calls `deleteVideo(videoId)`. The Server Action **first** confirms the caller actually owns the row, then deletes the database row *scoped to the requesting user's id* (`and(eq(videos.videoId, videoId), eq(videos.userId, userId))`), and only then removes the Cloudinary assets (best-effort, in parallel). Ordering matters here and is worth calling out: the row delete is ownership-scoped but the CDN delete is not, so destroying assets first would let any signed-in user wipe another user's media by id while that user's row survived, leaving a page pointing at a dead asset. Every child row (comments, notes, view events, playlist memberships) is auto-removed by Postgres's `onDelete: "cascade"` foreign keys.

**Q: Why does the search feature strip punctuation from the title comparison?**
See [§14.1](#141-the-search-query). Real users don't reliably remember or type exact punctuation — a search for "nextjs" should match a title like "Next.js Tutorial." Stripping hyphens/periods/spaces from both the stored title and the incoming query before comparing closes that gap.

### Advanced

**Q: Why does the canvas-compositing recording use a Web Worker instead of `requestAnimationFrame`?**
See [§6.3](#63-a-real-bug-this-app-hit-and-how-it-was-fixed) in full — this is the single best "hardest bug" story in this codebase, and should be told with the actual before/after code, not just the summary.

**Q: How does this app prevent one user from tampering with another user's data through a Server Action?**
Three layers, worth naming explicitly: (1) every mutating action independently re-derives the session from request headers server-side — never trusts a client-supplied user id; (2) every mutation's SQL `WHERE` clause includes an ownership check *in the same query* as the mutation itself, so an unauthorized attempt affects zero rows rather than relying on a separate "check then act" step that could have a race condition between the check and the action; (3) input is re-validated at every action's entry point (`lib/validate.ts`), because a Server Action is a real network endpoint that could be called with arbitrary payloads bypassing the app's own frontend entirely.

**Q: Why is `chapters` a JSON column instead of its own table, when `comments` is a real table?**
See [§24.11](#2411-database-normalization-vs-denormalization). The dividing line: does this data have its own lifecycle/authorship independent of the parent, and would it ever need its own query? Comments are authored by *someone other than the video's owner*, get deleted individually, and could plausibly need a future "all comments by user X" query — none of that is true of chapters, which are small, owner-authored, always read as a whole list alongside the video itself.

**Q: This app has no vector database or RAG pipeline — when would you actually need one?**
See [§24.12](#2412-rag-retrieval-augmented-generation--and-why-this-app-does-not-use-it). RAG earns its complexity when a query needs to draw on a *corpus* larger than what fits in one prompt — e.g., "find the video where I explained database indexing," searched by *meaning* across every video's transcript, not just keyword matching within one video at a time. This app's current search is keyword/`ILIKE`-based specifically because that's sufficient for its actual scale and use case; RAG would be the right next step only if semantic, cross-video search became a real requirement.

---

## 27. Common Follow-Up Questions

**"What if the database goes down?"**
Every Server Action that touches the database would throw, and — since the shared `withError` wrapper is currently a pass-through, not a try/catch — that error propagates up to whatever called the action. In a Client Component, an uncaught error inside an `async` handler generally just logs to the console and leaves the UI in its prior state (no auto-retry currently implemented); in a Server Component doing a top-level `await`, it would trigger the nearest `error.tsx` boundary, showing the branded "Something went wrong" page with a Try Again button. A genuine improvement here would be retry-with-backoff for transient Neon cold-start latency, and a more specific error message than the generic boundary provides.

**"How would you scale this to a lot more traffic?"**
The individual pieces already scale reasonably well for their tier: Cloudinary handles video storage/CDN delivery at scale as part of its own service; Neon's serverless Postgres scales connections automatically. The one place that would need direct attention is the `video_views` table — `getChannelAnalytics` currently computes aggregates *live*, on every page load, via a `JOIN` and several aggregate functions over the raw event table. At high volume (millions of view events per popular video), that live aggregation would get slow; the fix is a standard one — a periodic job that rolls raw events up into pre-computed daily/hourly summary rows, and querying *those* instead of the raw log for the dashboard.

**"Why this architecture, and not microservices/a separate backend?"**
For a project at this scope (one team, one deployable, no need for independent scaling of "backend" vs "frontend"), a monolithic Next.js app with Server Actions removes an entire category of complexity — no separate API to version, no CORS configuration, no duplicated type definitions between a frontend and backend repo. Microservices earn their complexity when different parts of a system need genuinely independent deployment cadences, scaling profiles, or team ownership boundaries — none of which apply here.

**"What would you change if you were starting over?"**
A few honest answers: (1) the `withError` wrapper in `lib/actions/video.ts` should actually catch and normalize errors, rather than being a pass-through seam; (2) the video detail page is a Client Component that fetches its data through a Server Action *after* hydration, adding a round trip before anything renders — making it a Server Component that passes data to a client player would remove that; (3) `parseTimestamp` in `VideoChapters.tsx` duplicates logic that already exists as `parseTimeToSeconds` in `lib/utils.ts` — a small missed consolidation from when the chapters feature was built before the transcript-seeking feature introduced the shared version.

---

## 28. Full Walkthrough: A Day in the Life of a Video

This final section narrates, start to finish, everything that happens to one specific video — call it "How I fixed the login bug" — from the moment it's recorded to the moment someone else finishes watching it, tying together every system this document has covered.

1. **Recording.** Udit opens SnapCast, clicks **Record a video**, enables the microphone and webcam (bottom-right, circular, medium size), and hits Record. A 3-2-1 countdown plays. The browser's native picker appears; he chooses "Entire Screen." For the next four minutes, his screen and webcam are composited onto an invisible canvas 30 times a second — driven by a Web Worker so it keeps working even if he alt-tabs to check something — and that composited stream is encoded by `MediaRecorder` into one-second chunks, each immediately written to both an in-memory array and IndexedDB (in case his laptop dies mid-recording). In parallel, the Web Speech API listens to his narration and builds a timestamped transcript sentence by sentence.

2. **Stopping and reviewing.** He clicks Stop. The chunks are assembled into one video Blob, instantly playable in a preview `<video>` tag right there in the modal. He clicks **Continue to Upload**.

3. **Uploading.** On the upload page (pre-filled with his recording, thanks to a `sessionStorage` handoff), he types a title and description, leaves the thumbnail blank, and sets visibility to `link-only`. On submit: a signed, single-use Cloudinary upload URL is requested from the server (his session is checked first); the actual video bytes are streamed directly from his browser to Cloudinary via `XMLHttpRequest` (never touching this app's own server), with a live percentage bar; since he skipped the thumbnail, a Cloudinary auto-generated frame (`so_1`, one second in) is used instead; finally, a new row is inserted into the `videos` table — with every field re-validated server-side regardless of what the client claims — and the transcript is saved as a second, separate write.

4. **AI enrichment.** The moment the video page loads and the player reports it's ready to play, `processVideoAI` fires automatically. It reads the saved transcript, sends it to Gemini 2.0 Flash, and gets back a 2-3 sentence summary, five tags, and (since a transcript with real timestamps exists) four to eight chapter markers — validated, clamped to the video's real duration, sorted, and forced to start at `0:00`. The video's `processingStatus` flips from `idle` → `processing` → `ready`, and the page silently refetches to show the result.

5. **Sharing.** Udit clicks the share icon, generates a 7-day link, and pastes it into a Slack message to a colleague. When Slack unfurls the link, it fetches the page's Open Graph metadata — the video's real title, its AI summary as the description, and its thumbnail as the preview image — all generated server-side by `generateMetadata()` before the actual page body ever renders.

6. **Watching.** The colleague, not logged into SnapCast at all, clicks the link. `middleware.ts` lets the request through unauthenticated, specifically because `/share/*` is excluded from the login wall. The share page validates the token is real and unexpired, then renders the exact same custom `<VideoPlayer>` component used everywhere else in the app — full seek bar with chapter ticks, speed control, keyboard shortcuts, all of it. Three seconds into playback, a view is recorded on the simple counter; when the colleague finishes watching and closes the tab, a `pagehide` event fires one more precise analytics event — this browser's anonymous id, how many seconds were actually watched, and whether it counts as "completed" — into the `video_views` table.

7. **Feedback.** The colleague, still without an account, can't comment (comments require login) — but if Udit had shared the actual `/video/[videoId]` link with a teammate who *does* have an account, that teammate could jump straight to the moment they had a question about, post a comment pinned to `1:47`, and Udit would see it — with a "reply" thread, an author avatar, and a one-click delete available to either of them.

8. **Later, from the dashboard.** A week later, Udit visits his own profile page. Because he's the owner, a `ChannelAnalyticsPanel` renders — a Server Component that queries, in one aggregate SQL statement, how many unique viewers watched across every video he owns, his average completion rate, and his top five most-viewed videos, rendered as simple hand-built bar charts. He notices this particular video has a high completion rate, adds it to a new "Onboarding" collection alongside three others, and moves on.

Every step above is real, traceable code in this repository — not a hypothetical. If any single step in this walkthrough is unclear, its corresponding numbered section above has the exact file, the exact function, and the reasoning behind it.

---

## 28. The One-Take Editor

### 28.1 Why this feature, and who it's for

The recorder in [§6](#6-the-recording-engine) captures a take; it can't fix one. For the people who record the most short technical videos (engineers walking through a PR, devrel recording a feature demo, a founder recording a bug repro), the real cost isn't recording. It's **re-recording**: one flubbed sentence or a 5-second "where was that tab" pause sends them back to the start. Full video editors are far too heavy for a throwaway 3-minute demo.

The editor's promise is *record messy, ship clean*. Record once. Tighten every pause with one click. Delete a flubbed sentence by deleting its words from the transcript. Share the edit immediately, or export a real MP4.

This feature was chosen over alternatives (AI auto-clipping into short-form clips, server-side compression or chunking, semantic search) because it addresses the most frequent pain for the target user, and because it can be built **entirely free to operate**. Every expensive step runs on the user's device.

### 28.2 Architecture at a glance

```
/video/[id]/edit  (Server Component: getEditorData, owner-only, else notFound())
   └── <Editor>                                    components/editor/Editor.tsx
         ├── useAudioAnalysis(videoUrl)            lib/media/useAudioAnalysis.ts
         │     fetch <cloudinary>.mp3 → OfflineAudioContext(16 kHz mono) → detectSilences
         ├── useTranscriber()  ── Web Worker ──    lib/media/transcribe.worker.ts
         │     Whisper tiny.en (transformers.js, WASM) on pause-aligned windows
         │     → refineWords(words, silences) → saveWordTranscript (server)
         ├── historyReducer (undo/redo)            lib/media/history.ts
         │     cuts: Cut[] in SOURCE time  → mergeRanges / keptSegments / summarizeEdit
         ├── <Timeline> canvas waveform + cut overlays
         ├── <TranscriptPane> memoized sentence rows, pause chips
         ├── autosave (debounced) → saveEdit (server) → videos.edl
         └── <ExportDialog> → useExporter() ── Web Worker ── lib/media/export.worker.ts
               mediabunny + WebCodecs: demux → decode → keep → re-time → encode → MP4

/video/[id] and /share/[token]
   └── <VideoPlayer cuts={video.edl.cuts}>  skips cuts live; controls use the edited timeline
```

The pure logic in `lib/media/` (`edl.ts`, `silence.ts`, `align.ts`, `pauses.ts`, `history.ts`, `sanitize.ts`) has no browser or React dependencies, and is what the 61 editor unit tests exercise.

### 28.3 The edit model: a non-destructive cut list

An edit is an **Edit Decision List**: `{ version: 1, cuts: [{ start, end, reason }], pauseLevel }`, stored in `videos.edl` (`jsonb`). Three decisions shape it:

- **Cuts are in source time.** Comments, notes, chapters and `?t=` deep links all point at moments in the *original* recording. Storing cuts against the same clock means nothing needs re-anchoring when an edit changes, and every cut can be restored.
- **Cuts are stored unmerged, with a reason** (`"silence"` from pause tightening or `"manual"` from the user). Merging happens on read (`mergeRanges`). Keeping reasons lets "switch pause level" replace only the automatic cuts while keeping manual ones. The current level is *derived* from the cuts (`levelOf` in `Editor.tsx`), not stored separately, so undo/redo can never leave the level control out of sync.
- **The source file is never modified.** Viewers get the edit by *skipping* cut ranges during playback. Nothing is re-encoded unless the owner explicitly exports.

`edl.ts` provides the timeline math: `keptSegments`, `editedDuration`, `sourceToEdited` / `editedToSource` (to map the player's clock and seek bar), `nextPlayableTime` (where playback should jump when it enters a cut), and `subtractRange` (restore: removes a range from every cut, splitting partial overlaps).

### 28.4 Getting audio without downloading the video

Cloudinary serves an **audio-only rendition** of any video when the URL's extension is swapped to `.mp3` (`audioRenditionUrl` in `lib/media/audio.ts`). Measured at ~100 kbps (~0.75 MB per minute), it's a fraction of the video's size. It's decoded with an `OfflineAudioContext` created at 16 kHz mono, which resamples during decode, so there's no resampling code at all. 16 kHz mono is exactly what Whisper needs, and plenty for loudness analysis.

**Load time, measured on the live site** (10-minute talk): the rendition downloads in 0.58 s (8.5 MB, 169 ms to first byte, even on a CDN miss, because Cloudinary stores derived assets permanently) and decode plus analysis takes ~1.4 s. The one slow case is the very first request for a video's rendition, when Cloudinary transcodes it on demand: 15.9 s for that talk. Three things keep this quick at no cost:

- **Intent prefetch.** `prewarmAnalysisAudio` (`audio.ts`) starts the download when an owner hovers or focuses an Edit / Open editor link, and `loadAnalysisAudio` takes over that same in-flight download when the editor opens (the link is a client-side navigation, so both share one JavaScript context). The HTTP cache isn't relied on: on the live site an 8.5 MB rendition wasn't cached, and an earlier cache-based version downloaded it twice. Each URL is warmed at most once per two minutes, and an unused buffer is released after two minutes. It requests exactly what the editor would, so it adds no Cloudinary work. Renditions are deliberately *not* generated for every upload: that would spend processing quota on videos that are never edited.
- **No bandwidth contention.** The editor's preview video uses `preload="metadata"`, so it doesn't start buffering the whole video while the analysis audio downloads.
- **An honest wait.** If no bytes have arrived after 4 s, the editor says Cloudinary is preparing the audio for the first time and that it's instant afterwards, instead of sitting silently at 0%.

If decoding fails, which is most often a recording made without a microphone, the editor says the video has no audio track, rather than showing a raw decoder error.

### 28.5 Pause detection (`lib/media/silence.ts`)

1. **Loudness envelope:** RMS level in dBFS over 20 ms frames.
2. **Adaptive threshold:** the 10th percentile of frame loudness estimates the noise floor and the 90th estimates speech level. The threshold sits 30% of the way from floor to speech, so a laptop mic in a café and a studio mic both work without a fixed −40 dB guess.
3. **Refusal when unsure:** with less than 10 dB between speech and noise, it returns no pauses rather than cutting into speech.
4. **Blip absorption:** quiet runs separated by sub-80 ms clicks or breaths count as one pause.

Detection runs once at the most sensitive setting (`MIN_DETECTED_PAUSE = 0.4 s`). The three levels in `pauses.ts` (Gentle ≥ 1.2 s with 0.3 s padding, Balanced ≥ 0.7 s / 0.2 s, Tight ≥ 0.45 s / 0.12 s) only *filter* that list, so switching levels is instant. The buttons display the seconds each level would remove from this recording, computed against the real edit.

**Measured against ffmpeg** (`silencedetect` at −40 dB) on a recording with 8 known pauses: all 8 were found and every edge was within ~60 ms. The differences fall on the safe side: detected pauses start slightly later and end slightly earlier, so speech edges aren't clipped.

### 28.6 Transcription in the browser (`transcribe.worker.ts`)

Whisper `tiny.en` (quantized to 8-bit, 41 MB, downloaded once from the Hugging Face Hub and cached by the browser) runs through transformers.js on the WASM backend, inside a Web Worker so the editor stays responsive. Word-level timestamps come from Whisper's cross-attention alignment. That's why the model is `Xenova/whisper-tiny.en`: the `onnx-community` export was tested and fails with "Model outputs must contain cross attentions".

Whisper processes 30-second windows. Rather than chopping blindly, `planTranscriptionWindows` splits long audio into windows of ≤ 28 s **at the midpoints of detected pauses**, so no word straddles a boundary. Progress is real: model bytes during download, then windows completed with words streaming into the transcript as they arrive.

Saving the transcript (`saveWordTranscript`) also rewrites the sentence-level `transcript` / `transcriptSegments` the rest of the app reads. Search, the transcript tab and AI chapters therefore improve too, including for **uploaded** videos, which had no transcript before. `processingStatus` is reset so the next view regenerates the AI summary from the better text.

### 28.7 Correcting Whisper's word times (`refineWords` in `align.ts`)

Whisper's word timestamps are approximate, and on test recordings they were wrong in two consistent ways:

| Error | Measured example | Consequence if uncorrected |
|---|---|---|
| The word before a pause absorbs the pause | "flow." reported 3.16–5.96 s; audio silent from 3.01 s | A kept word renders as cut once the pause is tightened; cutting that word removes 2.8 s instead of 0.3 s |
| Times run late by 0.2–0.5 s | "Wait," reported at 23.78 s; speech resumed at 23.38 s | Cutting a sentence leaves its first syllable audible |

The waveform is measured directly, so silence detection wins any disagreement:

1. A word that **starts in speech** is clipped at the first pause it runs into (the smear is always at the end).
2. A word that **starts inside a pause** belongs *before* it, unless it starts in the pause's last 0.2 s, in which case it's an early start of the next phrase. Given the late bias, "before" is the safe default.
3. Words are kept ordered and non-overlapping.
4. **Edges snap to pauses:** the first word after a pause starts exactly where speech resumes, and the last word before it ends where speech stopped.

The regression test in `tests/align.test.ts` uses **real Whisper output** from a test recording and asserts that no word overlaps a pause, that phrases start at measured onsets, and that pause cuts never strike through a kept word.

### 28.8 Cutting by text

Selecting words (click, shift-click or drag) and pressing ⌫ calls `cutForWords`. The cut runs from the first selected word's start to the **next kept word's start**, so the pause after the deleted words goes with them. Otherwise deleting a sentence would leave a doubled silence. Pressing ⌫ on an already-cut selection restores it. Each pause appears in the transcript as a chip (e.g. `2.0s`) that toggles just that pause. The timeline supports the same cut and restore actions on a dragged time range, which is how material with no words (a silent screen fumble) is removed.

### 28.9 Live preview and viewer playback

Both the editor preview and `VideoPlayer` skip cuts on `requestAnimationFrame`. `timeupdate` fires only ~4 times a second, which would let up to a quarter second of removed audio leak through. rAF stops completely in a background tab while audio keeps playing, though (this was observed in testing), so `timeupdate` remains as a fallback. A backgrounded viewer hears at most ~0.25 s of a cut edge, not the whole cut.

`VideoPlayer` shows the **edited** timeline everywhere: the clock, the seek bar (seeks map through `editedToSource`), ±5 s and digit-key jumps, and chapter ticks. Deep links and comment timestamps stay in source time, so they remain valid across re-edits. Two existing player bugs surfaced and were fixed along the way. On a server-rendered page, the browser could load metadata before hydration, so `onLoadedMetadata` was missed and the duration showed `0:00`. MediaRecorder WebM files report an `Infinity` duration until scanned, which is now handled via `durationchange`.

### 28.10 Export: a real MP4, rendered on the device (`export.worker.ts`)

**What was tried first:** rendering on Cloudinary with its splice transformation. Measured result: a single splice is accurate (10.045 s for a 10 s target), but chained splices of the same asset ignore every layer's end offset after the first. Three segments rendered as **26.4 s instead of 15 s**, and four as 32.8 s instead of 18 s. Splicing distinct derived assets returned HTTP 400. That made server-side rendering on the free stack a dead end.

**What runs instead:** WebCodecs with [mediabunny](https://mediabunny.dev) in a Web Worker:

1. Demux the source over HTTP range requests (`UrlSource`, with bounded retries: its default retries forever, which would hang the dialog when offline).
2. Negotiate codecs the device can encode: H.264 → VP9 → AV1 for video and AAC → Opus for audio, scaled down to the chosen preset (Original / 1080p / 720p / Compact), never up.
3. For each kept segment, iterate decoded frames and audio from 0.25 s before it (pre-roll, so a frame that starts before the cut is still found), keep what falls inside the segment, and **re-time** it onto the edited timeline. Video and audio use the same segment offsets, which is what keeps them in sync across every cut. Audio is trimmed sample-accurately at each boundary (`AudioSample.trim`). A video frame less than half inside a segment is dropped (measured slivers were 13 ms), letting its neighbour hold. This avoids near-duplicate timestamps that strict players reject.
4. Encode with the hardware encoder and mux to MP4 with the index at the front (`fastStart: "in-memory"`), so it streams.

**Measured:** a 33 s recording edited to 19.325 s exported as 19.313 s video and 19.320 s audio, and ffmpeg decoded it cleanly. Every tightened pause measured ~0.3 s, matching the configured padding. Rendering ~19 s of 720p took 3.0–3.4 s (5–6× real time) in Chromium. The dialog reports real progress, the negotiated codecs, the render speed, and the **actual** output size against the original's `Content-Length`, including when the output is larger (for example, on very compressible synthetic test video).

### 28.11 Security and validation

- `getEditorData` returns `null`, and the page `notFound()`s, unless the caller owns the video. `saveEdit` and `saveWordTranscript` go through `requireOwnedVideo`, which reports "Video not found" for both missing and not-yours, so ids can't be probed.
- All client input is untrusted. `sanitize.ts` rejects non-arrays and oversized payloads (≤ 40,000 words, ≤ 5,000 cuts, words ≤ 48 characters), drops malformed items, clamps times to the stored duration plus 2 s of slack, rounds to milliseconds and sorts.
- `words` is excluded from every viewer payload (`buildVideoWithUserQuery` destructures it out), because viewers only need the cut list.
- **Known limitation:** edits change what SnapCast *plays*, not the stored asset, so the original remains reachable at its Cloudinary URL. When removed material must not exist, export and re-upload the MP4.

### 28.12 Clips, navigation and leaving the editor safely

- **Clip links.** A selection's **Copy clip link** produces `/video/<id>?t=<start>&end=<end>` in source time (like `?t=` deep links, so it survives re-edits). `VideoPlayer` seeks to `t`, pauses at `end` (checked on the same rAF/`timeupdate` loop that skips cuts), marks the range on the seek bar, and offers **Watch full video**, which drops `end` from the URL. Replaying a finished clip restarts it; seeking more than 0.75 s past the end (or pressing play there) means the viewer wants the whole video, so clip mode ends instead of trapping them. If the clipboard is unavailable, the link is shown in a pre-selected field instead of failing silently.
- **Clip export.** **Export clip** renders `clipSegments(kept, selection)` (`edl.ts`, unit-tested): only the kept material inside the selection, so a clip of an edited video is itself edited.
- **Autosave on in-app navigation.** `beforeunload` only covers page unloads; an in-app link unmounts the editor and would cancel the 700 ms debounce. The pending edit is held in a ref and sent on unmount. Measured: the editor unmounted 79 ms after an edit and the save left at 85 ms, once.
- **Navigation.** The navbar records route changes (`lib/navigation.ts`) as a mirror of the history stack. Returning to the page just below the top counts as a back navigation and pops, so landing from an email, opening the editor, and pressing the browser's back leaves no in-app page behind the landing page. `BackLink` uses `router.back()` only when there is one, and otherwise links to a parent (Library, Collections); `tests/navigation.test.ts` covers these cases. It's a real `<Link>`, so it works without JavaScript and middle-clicks open the parent.
- **Owner nudge.** `EditNudge` invites owners of unedited videos into the editor (dismissible per video, stored in `localStorage`) and summarizes the edit on edited ones. Viewers never see it.

### 28.13 Limitations, stated plainly

| Limitation | Why | Mitigation |
|---|---|---|
| Filler words ("um", "uh") rarely appear in the transcript | Whisper is trained on cleaned transcripts | Pause tightening, and manual timeline cuts |
| Memory: ~3.8 MB per minute of analysis audio; export is buffered in memory | Whole-file processing in the browser | Practical ceiling ~30–45 min recordings |
| Preview skip precision ~16 ms visible, ~250 ms in a background tab | rAF vs `timeupdate` | Export is frame- and sample-accurate |
| Switching pause level drops per-pause overrides | Levels regenerate automatic cuts | Manual cuts are kept; undo restores |
| Export verified in Chromium only | Firefox/Safari WebCodecs support varies by version | The dialog surfaces "can't encode" errors |
| No timeline zoom | Scope | Transcript selection gives word-level precision |
