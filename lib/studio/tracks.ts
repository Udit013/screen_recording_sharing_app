// Multitrack audio: the original recording plus any number of added tracks
// (music, voiceover, sound effects), each holding clips of uploaded audio.
//
// Time model:
//   - The ORIGINAL audio follows the cut list (it lives in source time).
//   - ADDED clips sit on the EDITED timeline: a music bed starts at 0:00 of
//     the final video and doesn't jump when you remove a pause. Each clip
//     plays asset time [in, out) starting at edited time `start`.
//
// Pure functions: the editor, the preview scheduler and the export mixer all
// use them, and tests/tracks.test.ts checks them as plain numbers.

export type TrackKind = "music" | "voice" | "sfx";

export interface AudioClip {
  id: string;
  /** Uploaded asset (Cloudinary, this video's audio folder). */
  url: string;
  name: string;
  /** Length of the whole asset in seconds. */
  assetDuration: number;
  /** Where the clip starts on the edited timeline. */
  start: number;
  /** Part of the asset that plays: [in, out). */
  in: number;
  out: number;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface AudioTrack {
  id: string;
  name: string;
  kind: TrackKind;
  gainDb: number;
  muted: boolean;
  clips: AudioClip[];
}

export interface AudioMix {
  version: 1;
  /** The recording's own audio. Muted = removed from preview and export. */
  original: { muted: boolean; gainDb: number };
  tracks: AudioTrack[];
}

export const MIX_LIMITS = {
  maxTracks: 8,
  maxClipsPerTrack: 50,
  maxAssetSeconds: 60 * 60,
  minClip: 0.05,
  gainDb: { min: -60, max: 12 },
  fadeMs: { min: 0, max: 20000 },
  /** Upload size cap enforced by the editor before uploading. */
  maxUploadBytes: 50 * 1024 * 1024,
};

export const KIND_LABELS: Record<TrackKind, string> = { music: "Music", voice: "Voiceover", sfx: "Sound effects" };

/** Default level for a new track: music sits under speech. */
export const KIND_GAIN: Record<TrackKind, number> = { music: -14, voice: 0, sfx: -4 };

export const emptyMix = (): AudioMix => ({ version: 1, original: { muted: false, gainDb: 0 }, tracks: [] });

/** True when the mix is exactly "original audio, untouched". */
export const isPlainMix = (m: AudioMix) =>
  !m.original.muted && m.original.gainDb === 0 && m.tracks.every((t) => t.muted || t.clips.length === 0);

let idc = 0;
export const newId = (p: string) => `${p}${Date.now().toString(36)}${(idc++).toString(36)}`;

export const clipLength = (c: AudioClip) => c.out - c.in;
export const clipEnd = (c: AudioClip) => c.start + clipLength(c);
const round = (t: number) => Math.round(t * 1000) / 1000;
export const dbToGain = (db: number) => (db <= MIX_LIMITS.gainDb.min ? 0 : Math.pow(10, db / 20));

/** Last moment any added clip plays. */
export const mixEnd = (m: AudioMix) =>
  m.tracks.reduce((e, t) => t.clips.reduce((x, c) => Math.max(x, clipEnd(c)), e), 0);

// ── Editing ──────────────────────────────────────────────────────────────

const byStart = (cs: AudioClip[]) => [...cs].sort((a, b) => a.start - b.start);

export function addTrack(m: AudioMix, kind: TrackKind): AudioMix {
  if (m.tracks.length >= MIX_LIMITS.maxTracks) return m;
  const n = m.tracks.filter((t) => t.kind === kind).length + 1;
  const name = `${KIND_LABELS[kind]}${n > 1 ? ` ${n}` : ""}`;
  return { ...m, tracks: [...m.tracks, { id: newId("t"), name, kind, gainDb: KIND_GAIN[kind], muted: false, clips: [] }] };
}

export const updateTrack = (m: AudioMix, id: string, patch: Partial<Omit<AudioTrack, "id" | "clips">>): AudioMix => ({
  ...m,
  tracks: m.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
});

export const removeTrack = (m: AudioMix, id: string): AudioMix => ({ ...m, tracks: m.tracks.filter((t) => t.id !== id) });

/**
 * Where a clip of `length` seconds can go on a track at or after `at`,
 * without overlapping the track's other clips (skipping `ignore`). Returns
 * the first free start time.
 */
export function freeSlot(track: AudioTrack, at: number, length: number, ignore?: string): number {
  let t = Math.max(0, at);
  for (const c of byStart(track.clips)) {
    if (c.id === ignore) continue;
    if (clipEnd(c) <= t + 1e-6) continue;
    if (c.start >= t + length - 1e-6) break;
    t = clipEnd(c);
  }
  return round(t);
}

/** Adds a whole asset as a clip at the first free spot at or after `at`. */
export function addClip(m: AudioMix, trackId: string, asset: { url: string; name: string; duration: number }, at: number): AudioMix {
  const track = m.tracks.find((t) => t.id === trackId);
  if (!track || track.clips.length >= MIX_LIMITS.maxClipsPerTrack) return m;
  const len = Math.min(asset.duration, MIX_LIMITS.maxAssetSeconds);
  const clip: AudioClip = {
    id: newId("c"),
    url: asset.url,
    name: asset.name,
    assetDuration: round(asset.duration),
    start: freeSlot(track, at, len),
    in: 0,
    out: round(len),
    gainDb: 0,
    fadeInMs: track.kind === "music" ? 1000 : 0,
    fadeOutMs: track.kind === "music" ? 2000 : 0,
  };
  return mapTrackClips(m, trackId, (cs) => byStart([...cs, clip]));
}

const mapTrackClips = (m: AudioMix, trackId: string, f: (cs: AudioClip[]) => AudioClip[]): AudioMix => ({
  ...m,
  tracks: m.tracks.map((t) => (t.id === trackId ? { ...t, clips: f(t.clips) } : t)),
});

export const findClip = (m: AudioMix, clipId: string) => {
  for (const t of m.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return null;
};

export function updateClip(m: AudioMix, clipId: string, patch: Partial<Pick<AudioClip, "gainDb" | "fadeInMs" | "fadeOutMs" | "name">>): AudioMix {
  const f = findClip(m, clipId);
  if (!f) return m;
  return mapTrackClips(m, f.track.id, (cs) => cs.map((c) => (c.id === clipId ? { ...c, ...patch } : c)));
}

/** Moves a clip to start at `start`, stopping at its neighbours. */
export function moveClip(m: AudioMix, clipId: string, start: number): AudioMix {
  const f = findClip(m, clipId);
  if (!f) return m;
  const { lo, hi } = neighbours(f.track, f.clip);
  const len = clipLength(f.clip);
  const s = Math.min(Math.max(start, lo), Math.max(lo, hi - len));
  return mapTrackClips(m, f.track.id, (cs) => byStart(cs.map((c) => (c.id === clipId ? { ...c, start: round(s) } : c))));
}

function neighbours(track: AudioTrack, clip: AudioClip) {
  const others = byStart(track.clips.filter((c) => c.id !== clip.id));
  let lo = 0, hi = Infinity;
  for (const o of others) {
    if (clipEnd(o) <= clip.start + 1e-6) lo = Math.max(lo, clipEnd(o));
    else if (o.start >= clipEnd(clip) - 1e-6) { hi = Math.min(hi, o.start); }
  }
  return { lo, hi };
}

/**
 * Trims a clip's left or right edge to edited time `t`. The left edge moves
 * the asset's `in` point with it (the audio under the edge stays put, like
 * every editor's trim), bounded by the asset and the neighbours.
 */
export function trimClip(m: AudioMix, clipId: string, edge: "left" | "right", t: number): AudioMix {
  const f = findClip(m, clipId);
  if (!f) return m;
  const { lo, hi } = neighbours(f.track, f.clip);
  const c = f.clip;
  let next: AudioClip;
  if (edge === "left") {
    const minStart = Math.max(lo, c.start - c.in);               // can't reveal before the asset starts
    const maxStart = clipEnd(c) - MIX_LIMITS.minClip;
    const s = Math.min(Math.max(t, minStart), maxStart);
    next = { ...c, start: round(s), in: round(c.in + (s - c.start)) };
  } else {
    const maxEnd = Math.min(hi, c.start + (c.assetDuration - c.in)); // can't play past the asset's end
    const e = Math.min(Math.max(t, c.start + MIX_LIMITS.minClip), maxEnd);
    next = { ...c, out: round(c.in + (e - c.start)) };
  }
  return mapTrackClips(m, f.track.id, (cs) => cs.map((x) => (x.id === clipId ? next : x)));
}

/** Splits a clip at edited time `t` into two clips that play back-to-back. */
export function splitClip(m: AudioMix, clipId: string, t: number): AudioMix {
  const f = findClip(m, clipId);
  if (!f) return m;
  const c = f.clip;
  if (t <= c.start + MIX_LIMITS.minClip || t >= clipEnd(c) - MIX_LIMITS.minClip) return m;
  const cut = round(c.in + (t - c.start));
  const a: AudioClip = { ...c, out: cut, fadeOutMs: 0 };
  const b: AudioClip = { ...c, id: newId("c"), start: round(t), in: cut, fadeInMs: 0 };
  return mapTrackClips(m, f.track.id, (cs) => byStart(cs.flatMap((x) => (x.id === clipId ? [a, b] : [x]))));
}

export const removeClip = (m: AudioMix, clipId: string): AudioMix => ({
  ...m,
  tracks: m.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) })),
});

// ── Mixing ───────────────────────────────────────────────────────────────

/** Gain of a clip (clip gain × fades) at edited time `t`; 0 outside the clip. */
export function clipGainAt(c: AudioClip, t: number): number {
  const local = t - c.start, len = clipLength(c);
  if (local < 0 || local >= len) return 0;
  let g = dbToGain(c.gainDb);
  const fi = c.fadeInMs / 1000, fo = c.fadeOutMs / 1000;
  if (fi > 0 && local < fi) g *= local / fi;
  if (fo > 0 && len - local < fo) g *= (len - local) / fo;
  return g;
}

/** Decoded audio for a clip's asset: stereo planes at the mix sample rate, covering asset time [from, from + length). */
export interface DecodedClip {
  left: Float32Array;
  right: Float32Array;
  /** Asset time of the first frame. */
  from: number;
  sampleRate: number;
}

/**
 * Adds every audible clip into the stereo block that starts at edited time
 * `t0` (`frames` long, at `sampleRate`). `decoded` maps clip id → its audio.
 * The same routine mixes the export; the preview uses Web Audio nodes with
 * the same gains (see useMixPreview).
 */
export function mixInto(
  mix: AudioMix,
  decoded: Map<string, DecodedClip>,
  left: Float32Array,
  right: Float32Array,
  frames: number,
  t0: number,
  sampleRate: number
) {
  // Work in absolute frame numbers so block boundaries never change which
  // frames a clip covers.
  const n0 = Math.round(t0 * sampleRate);
  const t1 = (n0 + frames) / sampleRate;
  for (const track of mix.tracks) {
    if (track.muted) continue;
    const tg = dbToGain(track.gainDb);
    if (tg === 0) continue;
    for (const c of track.clips) {
      if (clipEnd(c) <= n0 / sampleRate || c.start >= t1) continue;
      const d = decoded.get(c.id);
      if (!d) continue;
      const first = Math.max(0, Math.ceil(c.start * sampleRate - 1e-6) - n0);
      const last = Math.min(frames, Math.ceil(clipEnd(c) * sampleRate - 1e-6) - n0);
      const n = d.left.length;
      for (let i = first; i < last; i++) {
        const t = (n0 + i) / sampleRate;
        const g = tg * clipGainAt(c, t);
        if (g === 0) continue;
        // Position in the decoded buffer, linearly interpolated (handles any rate mismatch).
        const p = (c.in + (t - c.start) - d.from) * d.sampleRate;
        let k = Math.floor(p + 1e-6);
        if (k < 0 || k >= n) continue;
        const fr = k + 1 < n ? Math.max(0, p - k) : 0;
        if (k + 1 >= n) k = n - 1;
        const l = fr ? d.left[k] + (d.left[k + 1] - d.left[k]) * fr : d.left[k];
        const r = fr ? d.right[k] + (d.right[k + 1] - d.right[k]) * fr : d.right[k];
        left[i] += g * l;
        right[i] += g * r;
      }
    }
  }
}

// ── Validation ───────────────────────────────────────────────────────────

const num = (v: unknown, min: number, max: number, fb: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const text = (v: unknown, max: number, fb: string) =>
  typeof v === "string" ? v.replace(CONTROL, "").trim().slice(0, max) || fb : fb;
const ID = /^[a-z0-9]{1,40}$/i;
const KINDS: TrackKind[] = ["music", "voice", "sfx"];

/**
 * Validates an untrusted mix. `isAllowedUrl` decides which asset URLs may be
 * referenced (the server only allows this video's own audio folder on the
 * configured Cloudinary account); clips with other URLs are dropped.
 * Overlapping clips on one track are dropped too. Never throws.
 */
export function sanitizeMix(input: unknown, isAllowedUrl: (url: string) => boolean): AudioMix {
  const m = obj(input);
  const o = obj(m.original);
  const rawTracks = Array.isArray(m.tracks) ? m.tracks.slice(0, MIX_LIMITS.maxTracks) : [];
  const tracks: AudioTrack[] = [];
  for (const rt of rawTracks) {
    const t = obj(rt);
    const kind = KINDS.includes(t.kind as TrackKind) ? (t.kind as TrackKind) : "music";
    const clips: AudioClip[] = [];
    const raw = Array.isArray(t.clips) ? t.clips.slice(0, MIX_LIMITS.maxClipsPerTrack) : [];
    for (const rc of raw) {
      const c = obj(rc);
      const url = typeof c.url === "string" ? c.url : "";
      if (!url || !isAllowedUrl(url)) continue;
      const assetDuration = num(c.assetDuration, MIX_LIMITS.minClip, MIX_LIMITS.maxAssetSeconds, NaN);
      if (!Number.isFinite(assetDuration)) continue;
      const inP = num(c.in, 0, assetDuration - MIX_LIMITS.minClip, 0);
      const out = num(c.out, inP + MIX_LIMITS.minClip, assetDuration, assetDuration);
      clips.push({
        id: typeof c.id === "string" && ID.test(c.id) ? c.id : newId("c"),
        url,
        name: text(c.name, 120, "Audio"),
        assetDuration: round(assetDuration),
        start: round(num(c.start, 0, 24 * 3600, 0)),
        in: round(inP),
        out: round(out),
        gainDb: num(c.gainDb, MIX_LIMITS.gainDb.min, MIX_LIMITS.gainDb.max, 0),
        fadeInMs: num(c.fadeInMs, MIX_LIMITS.fadeMs.min, MIX_LIMITS.fadeMs.max, 0),
        fadeOutMs: num(c.fadeOutMs, MIX_LIMITS.fadeMs.min, MIX_LIMITS.fadeMs.max, 0),
      });
    }
    // No overlaps within a track: keep the earlier clip.
    const kept: AudioClip[] = [];
    for (const c of byStart(clips)) if (!kept.length || c.start >= clipEnd(kept[kept.length - 1]) - 1e-6) kept.push(c);
    tracks.push({
      id: typeof t.id === "string" && ID.test(t.id) ? t.id : newId("t"),
      name: text(t.name, 60, KIND_LABELS[kind]),
      kind,
      gainDb: num(t.gainDb, MIX_LIMITS.gainDb.min, MIX_LIMITS.gainDb.max, 0),
      muted: t.muted === true,
      clips: kept,
    });
  }
  return {
    version: 1,
    original: { muted: o.muted === true, gainDb: num(o.gainDb, MIX_LIMITS.gainDb.min, MIX_LIMITS.gainDb.max, 0) },
    tracks,
  };
}

/** The URL rule the server applies: this video's folder on our Cloudinary account. */
export const audioUrlRule = (cloudName: string, videoId: string) => (url: string) =>
  url.startsWith(`https://res.cloudinary.com/${cloudName}/video/upload/`) &&
  url.includes(`/snapcast/audio/${videoId}/`) &&
  !/[\s"'<>\\]/.test(url);

/**
 * The mix as seen by an export that starts `offset` seconds into the edited
 * timeline (a clip export): every clip moves earlier, and a clip that
 * started before the offset is trimmed to begin at 0.
 */
export function shiftMix(m: AudioMix, offset: number): AudioMix {
  if (offset <= 0) return m;
  return {
    ...m,
    tracks: m.tracks.map((t) => ({
      ...t,
      clips: t.clips.flatMap((c) => {
        if (clipEnd(c) <= offset) return [];
        const s = c.start - offset;
        return [s >= 0 ? { ...c, start: s } : { ...c, start: 0, in: c.in - s, fadeInMs: 0 }];
      }),
    })),
  };
}
