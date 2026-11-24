# SnapCast Studio: audio, captions and video editing

The editor at `/video/[id]/edit` is a small studio for one recording. All of it runs in the browser and is free to run. No paid API is used for editing, and AI (Gemini) is used only for summaries and chapters, never to edit.

It has four tabs:

| Tab | What it does |
|---|---|
| **Transcript** | Whisper transcription on the device, cut by deleting words, tighten pauses |
| **Captions** | Captions from the transcript, edited and styled, burned into exports or downloaded as SRT/VTT |
| **Video** | Output shape (16:9, 9:16, 1:1, 4:5), fill/fit/blur, crop, brightness/contrast/saturation |
| **Audio** | Gain, pitch shift, clean-up filters, noise gate, 10-band EQ, compressor, echo, reverb, limiter, fades, normalisation, presets |
| **Tracks** | Multitrack audio: music, voiceover and sound-effect tracks; mute, level, replace or extract the original audio |

Every change is non-destructive. The uploaded file is never modified. Everything shares one undo history (⌘Z / ⇧⌘Z) and one autosave. What you preview is what exports, because the preview and the exporter run the **same code**.

---

## Architecture

```
                 lib/studio/*  (pure TypeScript, unit-tested in Node)
   ┌───────────────┬────────────────┬───────────────┬────────────────┐
   │ fx.ts dsp.ts  │ captions.ts    │ frame.ts      │ doc.ts         │
   │ effect model  │ caption model, │ framing maths │ undoable doc:  │
   │ + DSP engine  │ SRT/VTT,       │ + drawFrame   │ cuts, fx,      │
   │               │ time mapping   │               │ captions, look │
   │               │ captionRender  │               │                │
   └──────┬────────┴───────┬────────┴──────┬────────┴────────────────┘
          │                │               │
   ┌──────▼─────────┐  ┌───▼───────────────▼──┐   ┌──────────────────────┐
   │ AudioWorklet   │  │ Preview stage canvas  │   │ Export Web Worker    │
   │ (live preview) │  │ (useStageRenderer)    │   │ (export.worker.ts)   │
   │ engine injected│  │ video → drawFrame →   │   │ decode → drawFrame → │
   │ as source text │  │ drawCaption           │   │ drawCaption → encode │
   └────────────────┘  └──────────────────────┘   │ audio → same engine  │
                                                  └──────────────────────┘
```

- **One engine, three callers.** `createAudioEngine` (lib/studio/dsp.ts) runs in the AudioWorklet for the live preview, in the export worker for the file, and in Vitest. The worklet can't import modules, so the engine is written to be self-contained and injected as source text (`worklet.ts`). A test rebuilds it the same way.
- **One draw path for pictures.** `drawFrame` (framing) and `drawCaption` (captions) take any 2D context. The preview draws from the `<video>`. The exporter draws from decoded `VideoSample`s on an `OffscreenCanvas`. Positions and sizes are fractions of the frame, so a 330 px preview and a 1080 px export match. Measured: a caption's bounding box agreed to within 0.001 of the frame between preview and export.
- **Source time everywhere.** Cuts, captions and word timings are stored in source time. Each consumer maps onto the edited timeline (`toEditedCaptions`, `captionsForSegments`). Undoing a cut therefore brings its captions back, and clip exports get captions on the clip's own timeline.

### Persistence

All settings live in the existing `videos.edl` jsonb column (`StoredEdl` in `drizzle/schema.ts`). No migration is needed:

| Field | Contents |
|---|---|
| `cuts`, `pauseLevel` | Unchanged |
| `audioFx?` | Audio Studio settings (`AudioFx`, version 1) |
| `captions?` | `{ version, burnIn, captions[], style }`. Text and timings only |
| `look?` | `{ version, aspect, fit, crop, focusX/Y, background, brightness, contrast, saturation }` |

- Every new field is optional. Edits saved before a field existed load with defaults, and a `saveEdit` call that omits a field keeps the stored value rather than wiping it.
- Everything is validated on the server: `sanitizeAudioFx`, `sanitizeCaptionTrack` and `sanitizeLook` clamp every number, drop unknown keys and never throw. Caption text is stripped of control and bidi-override characters.
- Saves are owner-only (`requireOwnedVideo`).
- **No media is ever stored in Postgres.** Rendered files exist only in the user's browser until they download them.

---

## Audio Studio

**Signal chain** (fixed order):

input gain → pitch shift → high-pass → noise gate → 10-band EQ → low-pass → compressor → delay → reverb → output gain → look-ahead limiter

Fades and peak normalisation are applied on the edited timeline, outside the per-sample chain.

**Processing**

- Always stereo. Mono sources are duplicated to two channels in both preview and export, so stereo effects sound the same in both.
- Export decodes the source audio at **its own sample rate** (never the 16 kHz analysis copy), trims it sample-accurately at each cut, processes it, compensates the engine's latency and applies fades.
- Normalisation is two-pass: the first pass measures the peak, the second applies the gain (capped at +24 dB).

**AAC priming fix (all MP4 exports)**

- AAC encoders add priming samples. Without an edit list, every export played its audio about 44 ms late.
- The exporter now measures the encoder's delay (it encodes a click, decodes it and finds the click) and shifts the audio timestamps. mediabunny then writes an `elst` box.
- Verified: a click at 8.000 s in the source is at 8.0000 s in the export.

**Pitch shift.** This is a manual shift in semitones (±12). It is *not* pitch correction: it never retunes notes to a key.

- Two read heads play the input at the pitch ratio, with sin² crossfades.
- When a head restarts, it searches up to 12.5 ms for the offset whose waveform matches the other head (the WSOLA idea), so the crossfade adds no phase jump.
- Measured: 220 Hz shifted by ±3, −4 and ±12 semitones lands within 0.5% of the target.
- A worst-case 128-frame block takes about 1 ms of the 2.67 ms real-time budget.
- Formants move with the pitch, so large shifts sound unnatural.

**Measured on exported files** (ffmpeg and Python, against a test file with a 100 Hz tone, a 3 kHz tone and a click at 8.000 s):

| Effect | Result |
|---|---|
| High-pass 1 kHz | 100 Hz −40.0 dB, 3 kHz −0.1 dB |
| Echo 250 ms | Repeat at exactly +250 ms, equal level at 50% mix |
| Limiter at −6 dBFS with +12 dB drive | Peak exactly −6.00 dBFS |
| Pitch +12 st | 100 Hz → 200 Hz; click at 7.9988 s (latency compensated) |
| WAV export of a 10 s edit | Exactly 10.000 s |
| Untouched video | Audio passes through unprocessed (faithful copy) |

**Presets**

- Voice presets: Clean Podcast, Professional Narration, Studio Vocal, Singing, Concert, Lo-Fi, Robotic (a comb filter), Bright, Warm, Deep Voice (−4 st).
- Also EQ, reverb and delay presets.
- Your own presets are saved in the browser's `localStorage`.

---

## Captions

- **Generate.** Captions are built from the word transcript. A new caption starts after a sentence end, a pause longer than 0.6 s, the word limit, or 4 s of speech.
- **Edit.** Edit text, split at the midpoint, merge with the next caption, delete, add one at the playhead, and nudge the start or end by 50 ms. Neighbours never overlap. Changing the text keeps word timings when the word count is unchanged; otherwise the words are spread evenly across the caption.
- **Templates.** Classic, Bold Reels, Karaoke, Word Pop, Modern Creator and Minimal. Each one sets font, size, weight, case, colours, outline, shadow, background panel, position, safe margin, words per line, lines and animation, and every setting can be edited.
- **Animations.**
  - Karaoke: highlights the spoken word.
  - Word pop: each word scales in as it's spoken.
  - Reveal: words appear one by one.
  - Fade: the caption fades in and out.
- **Burn-in.** The export composites each frame on an `OffscreenCanvas`. Screen recordings are often variable-frame-rate: a static screen can hold a single frame for seconds. Held frames are therefore split into 1/30 s steps whenever captions are drawn. Verified: a source with 5 frames in 10 s exported as 300 frames, with words popping in during a single source frame.
- **SRT / WebVTT.** Both are written on the edited timeline. VTT cue text is escaped, so caption text can't inject markup or fake a timing line.
- **Fonts.** Inter, Montserrat and Bebas Neue are self-hosted in `public/fonts/captions` (SIL OFL 1.1, licence files alongside) and loaded with `FontFace` in both the page and the worker. Static font files bypass the auth middleware so the worker can fetch them.

---

## Video

- **Shapes.**
  - Original, 16:9, 9:16, 1:1 and 4:5.
  - The export preset bounds the **short side**, so 720p vertical is 720×1280.
  - Output never exceeds the source's resolution.
- **Fill modes.**
  - Fill: crops to the frame, with a focus point that picks what stays in view.
  - Fit: shows the whole picture, with coloured bars.
  - Blur: shows the whole picture over a blurred, dimmed copy of itself.
- **Crop and colour.** Crop with four trims (minimum 10% of the frame). Brightness, contrast and saturation from −100 to +100, applied as canvas filters.
- **Preview.**
  - With no framing, the native video shows and only captions are drawn over it.
  - With framing, a canvas paints every frame from the playing (invisible) video.
  - The paused frame is painted with `requestVideoFrameCallback`. This was measured: Chrome's `loadeddata` fires before a frame can be drawn.
- **Verified.**
  - 9:16 + blur + captions exported at 720×1280.
  - 1:1 fill with the focus at the right edge exported exactly the right-most 720×720 of the source, at −30% brightness.

---

## Tracks (multitrack audio)

- **Model.** `edl.mix` holds:
  - the original audio's level and mute (the original follows the cut list);
  - up to 8 added tracks (music, voiceover, sound effects) of clips.
- **Clip timing.** Clips sit on the **edited** timeline, so a music bed doesn't jump when you remove a pause. Each clip plays `[in, out)` of its file starting at `start`, with its own level and fades. Tracks have a level and a mute.
- **Editing.**
  - Drag a clip to move it; it never overlaps its neighbours.
  - Drag its edges to trim. The left edge moves the in-point, like any editor.
  - Split at the playhead, delete, and undo all of it.
- **Original audio.**
  - **Replace…** mutes the original and opens a new voiceover track.
  - **Extract (WAV)** exports the edited original with no effects and no added tracks.
- **Storage.**
  - Files upload from the browser straight to Cloudinary (`snapcast/audio/<videoId>/`) with a server signature. The server never handles the audio.
  - Each file is decoded in the browser first, which checks it is playable and measures its duration. Files are capped at 50 MB.
  - The server only accepts clip URLs inside that video's own folder on the configured account.
  - Deleting a video deletes the folder.
- **One mixer.**
  - Export: `mixInto` (`lib/studio/tracks.ts`) adds clips sample by sample, indexed by absolute frame, so block boundaries never shift a clip. The added tracks join after the Audio tab's effects chain, which processes only the recording's own voice. Master fades and normalisation then apply to the whole mix.
  - Preview: `useMixPreview` schedules `AudioBufferSourceNode`s with the same gains and fades on the preview's master bus. It resyncs if the audio clock drifts more than 60 ms from the video.
- **Verified in exported files** (WAV and MP4, measured):
  - A clip placed at 4.0 s with in-point 1.0 s starts at 4.0000 s and ends at 7.0000 s.
  - A −6 dB sound-effects track measures exactly half amplitude.
  - The muted original is absent.
  - A cut moves the original but not the added clips.
  - Live preview schedules each clip once per play, at the right offset.
- **Clip exports.** Added audio is shifted onto the clip's own timeline.

## Convert (video ↔ audio)

The **Convert** page (`/convert`) works on any local file, and nothing is uploaded. The editor's export dialog also offers the same audio formats for the edited video.

- **Video → audio:** MP3, M4A (AAC), Opus (Ogg) or WAV, with bitrates from 64 to 320 kbps (Opus up to 256) and a size estimate before converting.
  - AAC and Opus use the browser's WebCodecs encoders.
  - WAV is written directly.
  - MP3 uses LAME compiled to WebAssembly (`@mediabunny/mp3-encoder` 1.62.1). The wrapper is MPL-2.0 and LAME itself is LGPL; it's loaded as a separate WASM module and is unmodified.
- **Audio → video:** an MP4 (H.264 + AAC) with:
  - a solid colour or an image background, optionally dimmed;
  - an animated **spectrum-bar** or **waveform** visualizer, or none;
  - an optional title, Latin or Devanagari;
  - shapes for Reels/Shorts/TikTok (9:16), YouTube (16:9), square and 4:5;
  - 480p/720p/1080p, three quality levels, 24/30/60 fps and an audio bitrate choice.

  The live preview and the encoder share one renderer (`lib/studio/visualizer.ts`): an FFT on a 24 kHz mono analysis signal.
- **Measured** with a click at exactly 1.000 s in the source:

  | Output | Click lands at |
  |---|---|
  | M4A, Opus, WAV | 1.000–1.001 s |
  | Audio → video MP4 | 1.0000 s |
  | MP3 output | 1.026 s |

  - Every file's duration matches its source.
  - The size estimate was 237 KB for a 236 KB MP3.
- **Two timing bugs found and fixed:**
  - mediabunny doesn't remove the MP3 encoder/decoder delay or the AAC priming of *inputs*, so converted audio ran 23–49 ms late. SnapCast now trims negative-timestamp priming, and reads the LAME tag's encoder delay (+529 decoder samples) for MP3 inputs (`lib/media/gapless.ts`).
  - The same fix applies to MP3 files used as multitrack clips: a click clip placed at 2.0 s now lands at 3.0000 s in WAV and MP4 exports.
- **Limitations:**
  - **MP3 outputs** start ~25 ms late in players, because mediabunny's MP3 writer has no room for the LAME gapless header. It's leading silence, and video exports use AAC, so A/V sync is unaffected.
  - **Bitrate** is a target. AAC uses fewer bits than requested on very simple material such as a pure tone, so estimates are an upper bound there.
  - **Memory:** files are decoded in memory. Practical limits are about 30 minutes of audio with a visualizer, longer without one.

## Vocal / instrumental separation

In **Convert → Vocals / Instrumental**, any local song or video can be split into vocals and instrumental on the device. You can play a live remix with independent levels (or either part solo) and download vocals, instrumental or the remix as MP3/M4A/Opus/WAV.

- **Model.** Spleeter 2-stems (Deezer, **MIT**), int8 ONNX export by the sherpa-onnx project (**Apache-2.0**). It is two U-Nets, about 26 MB each, downloaded once from Hugging Face and kept in Cache Storage. It runs in a worker on onnxruntime-web (WASM, MIT); onnxruntime-web is now a declared dependency, at the same version transformers.js already used. No API, no quota.
- **Signal path** (`lib/studio/separate.ts`, pure TypeScript):
  1. STFT: Hann 4096, hop 1024, 44.1 kHz.
  2. The models run on blocks of 512 frames × 1024 bins.
  3. Ratio masks are applied to the full complex STFT, then an inverse STFT.
- **Differences from the reference implementation:**
  - The reference zeroes everything above 11 kHz; SnapCast extends the masks there instead, so cymbals and air survive.
  - Blocks are processed one at a time, so memory stays bounded.
  - Tests prove vocals + accompaniment = input exactly, whatever the models output.
- **Measured.** Synthetic speech over a synthetic music bed, SDR against the true stems, in the browser:

  | Stem | Unseparated mix | Separated |
  |---|---|---|
  | Vocals | 3.9 dB | **11.2 dB** |
  | Instrumental | −3.9 dB | **7.4 dB** |

  - Remixing both stems at 0 dB reconstructs the original at 56 dB SDR.
  - Speed: 8× real time in the browser (single-threaded WASM) and 19× in Node.
  - With onnxruntime-node the same mix scored 7.5 / 3.7 dB. The int8 kernels differ between runtimes.
- **Limitations:**
  - Spleeter is a 2019 model, so expect audible bleed: reverb tails and some instruments leak into the vocals. Demucs separates better but is several times larger and slower in a browser.
  - The whole file is decoded in memory (about 30 minutes at most).
  - Results are reused within the session; they aren't stored on the server.
  - Separating a video's *original* audio into editable tracks inside the editor is not built yet. It needs stems that follow the cut list.

## Pitch correction

**Audio → Pitch correction** in the editor: pick a key and scale (chromatic, major, natural/harmonic minor, major/minor pentatonic, blues), a strength and a retune speed. A live readout shows the detected pitch, the target note and the correction. It combines with the manual pitch shift.

- **How it works** (inside the shared engine, so preview and export match):
  1. YIN pitch detection runs on a 16 kHz decimated mono copy every 256 samples (65–1000 Hz).
  2. The nearest note of the chosen key and scale is picked, with hysteresis so the target doesn't flicker between neighbours.
  3. The correction in cents is scaled by strength and smoothed by the retune time (0 ms = instant, robotic).
  4. It drives the WSOLA pitch shifter with a time-varying ratio.
  5. Short unvoiced gaps hold the correction, then release it.
- **Delay alignment.** The shifter reads the audio exactly as far back as the detector's analysis window, so each correction lands on the audio it was computed for.
  - Without this, correction trailed 5 Hz vibrato and removed little of it (23 → 18 cents spread).
  - With it, the spread drops to 3 cents.
  - This adds about 25 ms of latency, which exports compensate.
- **Measured:**
  - Unit tests: a 452 Hz tone in C major lands within 5 cents of A4. 475 Hz goes to A♯ in chromatic and to B in C major. In D major, F goes to F♯. Half strength corrects half-way. A slow retune arrives later.
  - Exported WAV: a sharp note with vibrato moved from +46 to −0.9 cents mean. 475 Hz moved from −67.5 to −0.4 cents.
  - Cost: worst 128-sample block 0.37 ms of the 2.67 ms real-time budget.
- **Limitations:**
  - It is monophonic: one voice. Chords, doubled vocals or loud backing confuse the detector (separate the vocals first).
  - Formants shift with the correction; this is fine for small corrections.
  - There is no note-by-note graphical editing.

## Transcription languages

Choose the spoken language before transcribing: **Auto-detect (English/Hindi)**, **English**, **Hindi**, **Sanskrit** or **Hinglish** (mixed). Everything runs in the browser with OpenAI Whisper weights (MIT) via transformers.js (Apache-2.0):

| Choice | Model | Download | What it does |
|---|---|---|---|
| English | `Xenova/whisper-tiny.en` (q8) | ~41 MB | As before |
| Hindi, Sanskrit, Auto, Hinglish | `Xenova/whisper-small` (q8, multilingual) | ~240 MB, once, cached | Word timestamps in all modes |

**What was found while building it:**
- **No language detection in transformers.js.** Without a language, it silently decodes multilingual audio as English. That *translated* a Hindi sample into English text.
  - SnapCast detects language itself from Whisper's first decoder step.
  - Detection is restricted to English and Hindi. Hindi is often mistaken for Urdu, which would switch the output to Arabic script.
- **Sanskrit can't be detected**: a Sanskrit verse scored English 0.81, Sanskrit 0.01. Decoding with Whisper's own Sanskrit token writes romanized Latin. Sanskrit mode therefore decodes with the Hindi token, which gives Devanagari.
- **Whisper writes one language per call.** Forced to Hindi, English words come out transliterated into Devanagari ("which makes" → "विछ मेख्स").
  - **Hinglish mode:** each window is decoded as Hindi for context. The window is also split into phrases at short pauses, and each phrase's language is detected. Phrases detected as English are decoded again in English and spliced in by word timestamp.
  - A language switch with **no pause** can't be separated, so English words inside a Hindi phrase stay in Devanagari.
- **Hindi punctuation.** The danda (।, ॥) ends sentences and captions.
- **Fonts.** Captions use Noto Sans Devanagari (OFL), self-hosted, as the second font in every caption style. Latin keeps the template font, Devanagari gets Noto, in both preview and export.

**Measured accuracy** (character error rate against the script read aloud, Node CPU). The test speech is synthetic (macOS voices Samantha, Lekha and Rishi); real voices, accents and microphones will differ:

| Sample | Mode | CER | Script | Speed |
|---|---|---|---|---|
| English | English / Auto | 0.000 | Latin ✓ | 10.7× / 2.3× real time |
| Hindi | Hindi / Auto (detected hi, p=0.98) | 0.112 | Devanagari ✓ | ~2× |
| Sanskrit verse | Sanskrit | 0.219 | Devanagari ✓ | ~2× |
| Hinglish (clauses switch at pauses) | **Hinglish** | **0.034** | Devanagari + Latin ✓ | 0.9× |
| same | Hindi only | 0.404 | English transliterated ✗ | 1.8× |
| Hinglish (English words mid-phrase) | Hinglish | 0.235 | English clause Latin ✓; "SnapCast", "feature" stay Devanagari | 0.9× |

**Browser check:** the multilingual model ran end to end in the editor:
- Hindi + Hinglish + English: 23 s of audio.
- The download plus first run took a few minutes; the model is cached afterwards.
- Captions were generated with karaoke highlighting.
- SRT/VTT written in UTF-8 with the right scripts.
- An MP4 with Devanagari captions burned in rendered correctly.

**Limitations:**
- The multilingual model is about 6× larger and much slower than the English one. Hinglish runs at roughly real time, because English phrases are decoded twice.
- Sanskrit spelling is phonetic (sandhi, visarga and vowel length are often wrong); expect to correct captions.
- Hindi spelling errors are common on proper nouns and English loanwords.
- Filler words aren't transcribed reliably in any language.

## What is implemented, and what is not

**Implemented and verified in exported files**

- Audio:
  - All effects, presets and fades listed above.
  - Normalisation.
  - Before/After and live preview.
  - Saved settings and custom presets.
  - WAV export.
  - Manual pitch shift.
- Captions: generation, editing, six templates, animations, burn-in, SRT/VTT, sync after cuts.
- Video: aspect presets, fill/fit/blur, crop, reposition, colour adjustments.

**Not implemented** (deferred; not offered in the UI)

| Feature | Why / what it needs |
|---|---|
| Formant-preserving pitch shift | Needs spectral-envelope processing (e.g. LPC or a phase vocoder). |
| Automatic ducking (music dips under speech) | Track levels are manual today. |
| Text and image overlays | Fits the existing `drawFrame` → canvas path, but there is no overlay model or UI yet. |
| Timeline improvements (zoom, track lanes, caption blocks on the timeline) | Not started. |
| Effects on the public video page | Viewers see cuts only. Audio effects, captions and framing appear in exported files, not in the hosted player. |
| Loudness normalisation in LUFS | Normalisation is peak-based. |

---

## Licences

**One npm dependency was added for the studio:** `@mediabunny/mp3-encoder` (MP3 export; browsers can't encode MP3 natively).

**Algorithms** (implemented from their published descriptions)

| Algorithm | Source / status |
|---|---|
| Biquad filters | Robert Bristow-Johnson, "Audio EQ Cookbook" (published formulas) |
| Reverb | Freeverb topology, Jezar at Dreampoint (public domain) |
| Pitch-shift splice alignment | WSOLA concept (Verhelst & Roelands, 1993), independently implemented |
| Compressor, gate, look-ahead limiter | Standard feed-forward designs |

**Assets**

| Asset | Licence |
|---|---|
| Inter, Montserrat, Bebas Neue, Noto Sans Devanagari fonts (Fontsource 5.3.0 builds) | SIL Open Font License 1.1, licence files in `public/fonts/captions/` |
| Whisper `Xenova/whisper-tiny.en` and `Xenova/whisper-small` weights | MIT (OpenAI Whisper) |

**Runtime dependencies** (versions as installed)

| Package | Licence |
|---|---|
| next 15.5.28, react / react-dom 19.1.0 | MIT |
| @mediabunny/mp3-encoder 1.62.1 | MPL-2.0 (bundles the LGPL LAME encoder as WebAssembly) |
| onnxruntime-web 1.31.0-dev (already used by transformers.js) | MIT |
| Spleeter 2-stems weights (Deezer), ONNX export by sherpa-onnx | MIT (weights), Apache-2.0 (export) |
| mediabunny 1.62.1 | MPL-2.0. Used unmodified; file-level copyleft applies only to changes to its own files |
| @huggingface/transformers 4.3.1 | Apache-2.0 |
| drizzle-orm 0.45.4 | Apache-2.0 |
| better-auth 1.7.12, @neondatabase/serverless 1.2.0, cloudinary 2.11.0, clsx, tailwind-merge | MIT |
| @google/generative-ai 0.24.1 | Apache-2.0 |
| dotenv 16.5.0 | BSD-2-Clause |

**The repository itself has no LICENSE file yet.** To publish SnapCast as open source, the owner needs to choose a licence (for example MIT, Apache-2.0 or AGPL-3.0) and add it. All dependencies above are compatible with any of those.

---

## Proprietary or hosted services still in use

| Service | Used for | Required? |
|---|---|---|
| **Cloudinary** | Video storage and delivery, thumbnails, the audio-only rendition used for analysis | Yes, today |
| **Neon** | Hosted Postgres (Postgres itself is open source) | Any Postgres works |
| **Vercel** | Hosting | Any Node host works (`next start`) |
| **Google OAuth** | Sign-in | Yes, today (the only provider configured) |
| **Google Gemini** | AI summaries and chapters only. Never editing | Optional |
| **Hugging Face Hub, jsDelivr** | First-time download of the Spleeter models (~52 MB), the Whisper models (41 MB English, ~240 MB multilingual) and the ONNX WASM runtime, then cached | Yes, today |
| **Cloudinary (added audio)** | Uploaded music / voiceover / effect files for the Tracks tab | Yes, when tracks are used |

## Self-hosting migration plan

The editing studio is already fully client-side, so it needs no changes. The steps below replace the hosted services around it, cheapest first:

1. **Hosting.** Build and run with `next build && next start` in a Node 20+ container behind any reverse proxy. Nothing depends on Vercel-specific APIs.
2. **Database.** Point `DATABASE_URL` at any Postgres 15+.
   - Swap the `@neondatabase/serverless` driver in `drizzle/db.ts` for `postgres` (postgres.js) or `pg` with the matching Drizzle adapter.
   - Schema and queries are unchanged. Run the existing Drizzle migrations.
3. **Sign-in.** better-auth supports email and password, GitHub and generic OIDC. Enable email/password, or point OIDC at a self-hosted Keycloak or Authentik, and remove the Google provider.
4. **Model and WASM CDNs.**
   - Serve the Whisper files and onnxruntime-web's WASM from `public/`.
   - Set `env.localModelPath` / `env.allowRemoteModels = false` and `env.backends.onnx.wasm.wasmPaths` in `lib/media/transcribe.worker.ts`.
5. **Media storage (the largest step).** Replace Cloudinary with S3-compatible storage (MinIO, Garage or any S3) and an ffmpeg worker that runs on upload. The worker produces:
   - an H.264/AAC MP4 with `+faststart`;
   - a JPEG thumbnail;
   - the mono MP3 audio rendition that the editor's analysis downloads.

   The upload flow then signs S3 PUTs instead of Cloudinary uploads. The editor and exporter only need a CORS-enabled URL (`Access-Control-Allow-Origin` and byte-range requests), because export and the Web Audio preview read the video cross-origin.
6. **AI summaries (optional).** Point the summary step at a local model (e.g. an Ollama endpoint), or turn it off. Editing doesn't use it.

## Known limitations

- Export buffers the output file in memory. The practical ceiling is about 30–45 minutes of 720p.
- More than two audio channels are folded to the first two.
- Canvas filters (colour adjustments, blur background) need `ctx.filter`. Without it, adjustments are skipped and the blur background falls back to a dimmed copy, in both preview and export.
- Burned-in captions use the self-hosted fonts. If they can't be fetched (offline), preview and export both fall back to a system sans-serif.
- Custom audio presets are per-browser (`localStorage`).
- Export was verified in Chromium. Firefox and Safari ship WebCodecs but weren't tested here.

## Verifying

```bash
npm test          # 188 unit tests: DSP, captions, framing, history, EDL, alignment, …
npx tsc --noEmit
npm run lint
npm run build
```

Exports were checked by rendering in the browser and measuring the files with ffmpeg: frame grabs, tone frequencies, click timing, durations and stream properties.
