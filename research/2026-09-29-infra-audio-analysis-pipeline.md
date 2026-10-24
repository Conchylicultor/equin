# Audio analysis pipeline — from a YouTube `videoId` to cached beat features

Task A of [`2026-09-29-apps-sonata-ug-sheet-alignment.md`](2026-09-29-apps-sonata-ug-sheet-alignment.md).
That doc sets the goal and the two contracts. This one is A's own plan.

## Context

Singularity has no audio analysis today. Nothing in the repo provisions Python,
uv, ffmpeg or yt-dlp. Aligning a UG sheet to a recording (task B) needs the
**beat features** for any `videoId`: beats, downbeats, per-beat chroma and bass
chroma, the duration and an analysis version. They are computed out of process
and cached per video. The pipeline is generic infrastructure. Stems,
transcription and lyric timing will run on the same runtime later.

The outcome: `ensureBeatFeatures(videoId)` enqueues a supervised job. The job
downloads the audio (bounded cache), runs a Python extractor, and writes
versioned features to a host-wide cache. `readBeatFeatures(videoId)` answers
with a state. Done when 3–4 reference songs have features and their beat grid,
sonified as clicks over the audio, checks out by ear.

## Choices, and why

| Concern | Choice | Why |
|---|---|---|
| Python + deps | **uv** in `mise.toml` `[tools]`: one ~35 MB static binary, locked and upgraded like bun/go. **Nothing else is installed up front.** uv fetches its own CPython 3.12 and the locked env the first time a feature needs them (see *On-demand dependencies*). | uv is the only piece small enough to give every user. Python, torch and the models (~500 MB) are paid only by users who actually analyse audio. Lazy-installing uv through mise is off the table: shim auto-install is disabled on purpose (`research/2026-09-27-global-mise-shim-self-loop.md`). |
| Where the env lives | Host-wide, content-addressed: `cache/python-envs/<project>-<uv.lock hash>/`, built with `UV_PROJECT_ENVIRONMENT=… uv sync --frozen`. | Worktrees with the same lock share one env, and a worktree trialling a dependency bump gets its own (a different hash) without touching main's. A reclaimed env is simply rebuilt on next use. |
| Beats + downbeats | **Beat This!** (CPJKU, ISMIR 2024), with its minimal post-processing (no DBN) | State of the art on beats and downbeats, and it copes with tempo changes and no fixed meter. It is pip-installable on Python 3.12, and its only heavy dependency is torch. **madmom** is unmaintained and breaks on numpy 2 and Python ≥ 3.10 builds. **allin1** needs madmom plus natten, a Linux-oriented, painful install. **librosa** `beat_track` has no downbeats and makes tempo-octave errors. |
| Chroma + bass chroma | **librosa** CQT chroma: estimate the tuning first, keep the HPSS harmonic part, log-compress, then take the beat-synchronous median over each beat span. Treble range ≈ MIDI 48–96, bass range ≈ MIDI 28–52. | Deterministic, CPU-cheap and dependency-light. The two ranges give the bass chroma B wants for roots and inversions. A learned chroma (deep chroma, NNLS) would add madmom or vamp. `analysisVersion` exists so one can replace it later without mixing results. |
| Audio fetch | **yt-dlp** as a Python package in the same env (`python -m yt_dlp`), `-f bestaudio`, native container (webm/opus or m4a), no post-processing. yt-dlp's YouTube JS challenges run on **bun** (`--js-runtimes bun:<path>`, plus the `yt-dlp-ejs` package). | This needs no system ffmpeg: a single-format download needs no merge. yt-dlp needs a JS runtime for YouTube now, and bun is already on every machine. The version is locked in `uv.lock`, and yt-dlp breakages get fixed by a uv bump, like any other dependency. |
| Decoding | **PyAV** wheels (FFmpeg libraries bundled), resampled to 22.05 kHz mono (and whatever rate Beat This! wants) | Again, no system ffmpeg. The wheel is self-contained. |
| CPU vs MPS | Default **CPU**. The extractor takes `device` as an argument, and implementation measures both on the reference songs. MPS becomes the default only if it is more than 2× faster and its beats match the CPU run within 10 ms. | Beat This! runs a ~4-minute song in seconds on an M-series CPU, and the chroma is CPU-only regardless. MPS adds nondeterminism and first-call warm-up for a small gain. The measured numbers go into this doc. |
| Install footprint | Estimated: torch (~70 MB wheel, ~350 MB installed), Beat This! checkpoint (~80 MB, pinned URL + sha256, in `cache/audio-models`), librosa/numpy/scipy/av/yt-dlp (~150 MB). Paid once per machine, **only on first use** of an audio feature (roughly 1–2 min on a normal link). | Implementation measures the real sizes and records them here. |
| One env for all extractors? | Yes for now: one `pyproject.toml`, one lock. If a future extractor (demucs, whisper) pins a conflicting torch, it becomes a second uv project under the same runtime. `runPython` takes the project id from the start, so that split is additive. | |

## On-demand dependencies (generic)

Heavy, optional dependencies install **the first time a feature needs them**,
never at `bun install`. This is a small primitive,
`infra/on-demand-deps`, and the Python env is its first user:

```ts
const audioPythonEnv = defineOnDemandDep({
  id: "audio-python",
  stamp: () => `${uvLockHash}-${uvVersion}-${modelPins}`,  // what "installed" means; a change ⇒ reinstall
  install: async ({ log, signal }) => { /* uv sync --frozen, fetch + sha256 the checkpoints */ },
  describe: "Python audio tools (~500 MB, first use only)",
});

// Only callable from out-of-process work: needs the ExecContext token that a
// supervised `run` body receives, which the backend's request path never has.
const ready = await ensureDep(audioPythonEnv, ctx);   // installed → returns at once
runPython(ready, { entry: "beat_features", input });  // runPython takes the proof, so "forgot to ensure" is a type error
```

- **Where the install runs.** Inside the consumer's supervised job, which is
  already a child process. The download never touches the backend's event loop,
  which is the failure the chromium provision doc warns about. The rule is
  enforced by type (rung 2): `ensureDep` needs an `ExecContext` that only a
  supervised `run` body receives. That is a small additive field on
  `defineSupervisedJob`'s `run` context.
- **Concurrency.** A host-wide `flock` per dep id (`packages/flock`), so two
  worktrees asking at once install once. The second one waits, then reads the
  stamp.
- **Atomic.** The stamp file is written only after `install` succeeds, so an
  interrupted install is "not installed" and gets retried.
- **Visible state.** `depState(id)` is `absent | installing | ready | failed(message)`,
  pushed as a live value, so B/C can render "Preparing audio tools (first use)…"
  instead of a spinner that lies. A failed install fails the job with the
  installer's own message.
- **Opt-out of laziness.** An optional `./equin deps install <id>`
  prewarms a dep (for example on a demo machine). The same `install` runs.
- **Future users.** Stems and transcription reuse `audio-python` or declare their
  own dep. Chromium could migrate later: it is optional for most users too. That
  is out of scope here.

## Layout

The new umbrella is `plugins/infra/plugins/audio-analysis/`. The download goes
beside the player, as the vision suggests.

```
plugins/infra/plugins/audio-analysis/
  CLAUDE.md                       umbrella prose
  plugins/sidecar/                the Python runtime (generic)
    python/                       NEW leaf folder: a uv project
      pyproject.toml, uv.lock, .python-version (3.12)
      singularity_audio/__main__.py   `python -m singularity_audio <entry>`: JSON on stdin, JSON on stdout
      singularity_audio/beat_features.py, sonify.py, fetch.py
    data-dirs/index.ts            cache/python-envs, cache/audio-models (both reclaim: safe, rebuilt on demand)
    server/index.ts               audioPythonEnv = defineOnDemandDep({ … uv sync + pinned model downloads … })
                                  runPython(ready, { entry, input, signal|timeoutMs, log }) → parsed JSON | throws PythonEntryError
  plugins/beat-features/
    core/index.ts                 BeatFeatures zod schema + ANALYSIS_VERSION (the contract, shared with B)
    data-dirs/index.ts            cache/beat-features/<videoId>.v<N>.json (host-wide; reclaim: safe)
    server/index.ts               beatFeaturesJob (defineSupervisedJob, built-in ledger, lock = videoId, `run` body)
                                  ensureBeatFeatures(videoId), readBeatFeatures(videoId) → absent | running | ready | failed(message)
                                  GET/POST /api/audio/beat-features/:videoId (defineEndpoint)
    scripts/analyze.ts            dev: runs fetch + extract for a videoId in-process, prints a summary, writes the click-track wav
plugins/infra/plugins/on-demand-deps/    NEW generic primitive (see below)
  server/index.ts                 defineOnDemandDep, ensureDep, depState, the dep-states live value
plugins/integrations/plugins/youtube/plugins/audio-fetch/
  data-dirs/index.ts              cache/youtube-audio (host-wide; reclaim: safe)
  server/index.ts                 fetchYouTubeAudio(videoId, { signal, log }) → { path, format, durationSec }
                                  (runs the sidecar's `fetch` entry, writes to a temp name then renames, touches mtime on hit)
                                  youtubeAudioSweep: defineJob, daily cron, main only, evicts by LRU mtime past 30 days
                                  or beyond a 2 GB cap
```

Notes:

- **`python/` is a new entry in `LEAF_FOLDERS`**
  (`plugins/framework/plugins/plugin-id/core/plugin-id.ts`), with a boundary-table
  row that imports nothing (`boundaries/core/boundary-config.ts`). Nothing
  imports it: `runPython` runs it by path. This is the vocabulary's own
  extension point ("a new kind of folder is one entry…"), which beats
  smuggling `.py` files into `scripts/`. `.gitignore` gains `__pycache__/`.
- **Only the sidecar knows about Python.** The fetch and the extractor go through
  `runPython`. The fetch lives under `integrations/youtube` because it is
  YouTube-specific. Future non-YouTube sources (local files, a follow-up) feed
  the same extractor a path.
- **Job shape.** `beatFeaturesJob` uses a `run` body, so the in-process TS
  orchestrates two sidecar calls: fetch, then extract. It uses the built-in
  `supervised_job_runs` ledger with `lock: (i) => i.videoId`, which keeps a
  second enqueue of the same video from running twice, and `runAttempts: 2`.
  A download error from YouTube ("video unavailable", age-gated) is a
  `NonRetryableError` with the message yt-dlp gives. The extractor runs inside
  a 1-unit `withHostGrant`, so a batch of analyses yields to builds. The run
  writes the features file atomically (temp file, then rename). Its presence
  is what "ready" means. The ledger's open or failed row gives "running" and
  "failed (why)". Failure is a state, never a missing file read as "not yet".
- **Cache versioning.** The file name carries `ANALYSIS_VERSION`, and so does the
  JSON. `readBeatFeatures` ignores other versions, so a model upgrade re-analyses
  instead of mixing old and new results. Audio stays cached across versions.
- **Host-wide caches, main-only sweep.** Both caches are machine-wide, following
  the Sheet Sage precedent. Every worktree shares one download and one analysis.
  Only main runs the sweep (the attachments orphan-sweep pattern).

## Contract 1 refinement (recorded back into the vision doc)

```ts
BeatFeatures = {
  videoId: string;
  analysisVersion: number;          // bump ⇒ re-analysis
  durationSec: number;
  sampleRate: number;               // of the analysed signal
  tuningCents: number;              // estimated deviation from A440, already compensated in chroma
  beats: {                          // beat i spans [t, next.t) — the last one ends at durationSec
    t: number;                      // seconds
    downbeat: boolean;
    barPos: number;                 // 1-based position in its bar (from Beat This!'s downbeats), 0 before the first downbeat
    chroma: number[12];             // C..B, max-normalised, from treble CQT
    bass: number[12];               // same, bass range
    rms: number;                    // loudness of the span, 0–1 — lets B's filler state spot silence/intros
  }[];
  source: { format: string; ytDlpVersion: string; model: string; device: "cpu" | "mps" };
}
```

The additions relative to the vision are `barPos`, `tuningCents`, `rms` and
`source`. `rms` and `tuningCents` are cheap and serve B directly. The chroma
arrays are max-normalised, not L2-normalised, so B can pick its own template
scoring. Implementation adds a "Contract 1 as built" note to the vision doc.

## Steps

1. Add `uv = "latest"` to `mise.toml`, lock it through `./equin toolchain upgrade` (the only thing that moves `mise.lock`), and confirm that `toolchain:resolved` and `mise run doctor` know about uv.
1b. Build `infra/on-demand-deps` (`defineOnDemandDep`, `ensureDep` with its host flock and stamp, `depState` live value, the `deps install` CLI verb), and add `ExecContext` to the supervised-job `run` context.
2. Add the `python/` leaf folder to the vocabulary and the boundary table. Add `__pycache__` to `.gitignore`.
3. Build the sidecar plugin: the uv project (`uv lock` generates `uv.lock`), the `audio-python` on-demand dep, the env and model data dirs, and `runPython` over `spawnCaptured` (JSON on stdin, one JSON document on stdout, stderr streamed to `log`, a bounded timeout).
4. Build the `audio-fetch` child of `integrations/youtube`: the `fetch` entry, the atomic cache write, and the LRU sweep job.
5. Build `beat-features`: the core schema, the extractor entry, the supervised job, the read/ensure API, the endpoints, and `scripts/analyze.ts` with the sonify output (clicks at each beat, an accented click on downbeats, mixed over the audio into a wav).
6. Measure CPU vs MPS and the install footprint, then write the numbers and the contract-as-built into this doc and the vision doc.
7. Run `./equin build` (codegen registers the plugins and the data dirs), then `./equin check`.

## Verification

- **Unit tests** (`./equin test plugins/infra/plugins/audio-analysis`):
  - the BeatFeatures schema round-trips;
  - `readBeatFeatures` maps each (file, ledger row) state correctly, including a stale version;
  - the sweep's eviction order at the cap, on a temp dir.
- **Reference songs** (varied on purpose), through `scripts/analyze.ts`:
  - a steady piano pop song ("Let It Be");
  - a strummed guitar song with a capo ("Wonderwall");
  - a sparse, rubato-ish ballad ("Someone Like You");
  - a fast synth track ("Take On Me").

  Each run logs the beat count, the median BPM, the downbeat spacing and the timing. It writes `<song>-clicks.wav` to the scratch dir for you to listen to. The by-ear verdict per song goes into this doc.
- **The job path**: `POST /api/audio/beat-features/:videoId` for one song on the deployed worktree. Then `GET` shows running, then ready, the file is in `~/.singularity/cache/beat-features/`, and the `supervised_job_runs` row is closed with exit 0 (checked with `query_db`). A second POST is a no-op cache hit, and a bogus videoId ends in `failed` with yt-dlp's message.
- **First-use path**: with `~/.singularity/cache/python-envs` empty, `bun install` downloads nothing Python-related. The first POST shows the dep going `installing` → `ready`, then the job completes. Two concurrent first POSTs (two worktrees) install once. Killing the job mid-install leaves no stamp, and the next run reinstalls. Unit tests cover `ensureDep`'s stamp and lock logic on a temp dir.

## Risks

- **yt-dlp vs YouTube churn.** Download breakages are expected over time. They surface as `failed(message)`, and the fix is a uv bump. The bun JS-runtime path needs to be proven early (step 4 comes before the extractor).
- **First-use latency.** The first analysis on a machine waits roughly 1–2 min for the download. This deliberately departs from the vision's "provisioned at install time", and the vision doc is updated to match.
- **Beat This! licence**: MIT code, and the checkpoint licence has to be confirmed at implementation.
