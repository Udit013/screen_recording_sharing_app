import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const videos = pgTable("videos", {
  id: uuid("id").primaryKey().defaultRandom().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  videoUrl: text("video_url").notNull(),
  videoId: text("video_id").notNull().unique(),
  thumbnailUrl: text("thumbnail_url").notNull(),
  visibility: text("visibility")
    .$type<"public" | "private" | "link-only">()
    .notNull()
    .default("public"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  views: integer("views").notNull().default(0),
  duration: integer("duration"),
  transcript: text("transcript"),
  transcriptSegments: jsonb("transcript_segments")
    .$type<TranscriptEntry[]>()
    .default([]),
  aiSummary: text("ai_summary"),
  tags: text("tags").array().default([]),
  shareToken: text("share_token").unique(),
  shareTokenExpiry: timestamp("share_token_expiry"),
  chapters: jsonb("chapters").$type<Chapter[]>().default([]),
  // Async-ish processing status: idle | processing | ready | failed
  processingStatus: text("processing_status")
    .$type<"idle" | "processing" | "ready" | "failed">()
    .notNull()
    .default("idle"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Timestamped personal notes on a video ──────────────────────────────────
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  videoId: text("video_id")
    .notNull()
    .references(() => videos.videoId, { onDelete: "cascade" }),
  timestamp: integer("timestamp").notNull().default(0),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Playlists / Collections ────────────────────────────────────────────────
export const playlists = pgTable("playlists", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const playlistVideos = pgTable("playlist_videos", {
  id: uuid("id").primaryKey().defaultRandom(),
  playlistId: uuid("playlist_id")
    .notNull()
    .references(() => playlists.id, { onDelete: "cascade" }),
  videoId: text("video_id")
    .notNull()
    .references(() => videos.videoId, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

// ── Per-view watch events (powers analytics) ───────────────────────────────
export const videoViews = pgTable("video_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  videoId: text("video_id")
    .notNull()
    .references(() => videos.videoId, { onDelete: "cascade" }),
  // nullable: anonymous viewers via share links have no account
  viewerId: text("viewer_id").references(() => user.id, {
    onDelete: "set null",
  }),
  // anonymous fingerprint (session id) for unique-viewer counting
  anonId: text("anon_id"),
  watchedSeconds: integer("watched_seconds").notNull().default(0),
  completed: boolean("completed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const schema = {
  user,
  session,
  account,
  verification,
  videos,
  notes,
  playlists,
  playlistVideos,
  videoViews,
};
