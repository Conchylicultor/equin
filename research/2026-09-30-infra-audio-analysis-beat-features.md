# Audio analysis — YouTube `videoId` → cached beat features, on `infra/deps`

Task A (audio half) of [`2026-09-29-apps-sonata-ug-sheet-alignment.md`](2026-09-29-apps-sonata-ug-sheet-alignment.md).
Supersedes the *layout* of [`2026-09-29-infra-audio-analysis-pipeline.md`](2026-09-29-infra-audio-analysis-pipeline.md)
(its sidecar and on-demand-deps parts are now `infra/deps`,
[`2026-09-29-infra-deps-v2.md`](2026-09-29-infra-deps-v2.md)); its library
choices still hold: yt-dlp with bun as its JS runtime, PyAV decoding, Beat This!
(no DBN) for beats and downbeats, and librosa CQT chroma, CPU by default.

## Context

Task B (the aligner) needs **beat features** for any YouTube `videoId`: the
beat times and downbeats, a per-beat chroma and bass chroma, the duration and
an analysis version. They are computed out of process and cached per video, and
the audio download sits in a bounded cache. `infra/deps` now gives on-demand
Python envs (`defineDep` + `pythonEnv`, `ensureDep(dep, exec)`, `runPython`),
and `hello-python` is its placeholder consumer. This task adds the first real
consumer and deletes the placeholder.

Done when features exist for 3–4 reference songs and their beat grid, rendered
as clicks over the audio, checks out by ear.

## Design decisions

1. **Two Python projects, so two deps, not one.**
   - `youtube-audio`: yt-dlp + yt-dlp-ejs, about 15 MB.
   - `audio-python`: torch, beat-this, librosa, av and numpy, about 500 MB.

   The reason: a dep's identity is its `uv.lock` hash. yt-dlp ships a release
   almost every week, since YouTube keeps breaking it, and the `uv` updater
   bumps it. In one shared project every bump would reinstall torch on every
   machine. Split this way, a yt-dlp fix costs 15 MB. It also puts the
   YouTube-specific piece under `integrations/youtube`, and keeps the extractor
   generic: it takes an audio file.

2. **Host-wide file state, no DB.**
   - Both caches are host-wide data dirs, shared by every worktree (the Sheet
     Sage precedent).
   - The `supervised_job_runs` ledger is per-worktree DB. It cannot say "another
     worktree is analysing this video", so running and failed are **state files
     beside the cache, written under a host flock per `videoId`**. This mirrors
     `deps`' own `installing.json` / `failed.json` / `ready.json` idiom.
   - The features file itself, written temp-then-rename, is what "ready" means.
   - `running.json` counts only while its flock is held. A stale one, left by a
     killed run, reads as `absent`.

3. **A library call for B, a job for requests.** B's own chain job (fetch → features → align) calls
   `ensureBeatFeatures(videoId, exec)` inside its `run` body. It needs no queue
   hop, and its `ExecContext` proves it runs off the event loop. A request path
   (endpoint, CLI) uses `requestBeatFeatures(videoId)`, which enqueues this
   plugin's supervised job (lock = `videoId`) and returns at once.
   `readBeatFeatures(videoId)` is a cheap file read that is safe on the event
   loop.

4. **No live value yet.** B stores the alignment record in the DB, and the
   player's status renders from that. A adds a pushed per-video state only if
   B or C turns out to need it.

5. **A permanent failure stays failed.** "Video unavailable", age-gated and
   private videos are `NonRetryableError`s, recorded in `failed.json` with
   yt-dlp's message, and `requestBeatFeatures` does not retry them unless
   called with `force`. Transient failures (network, timeout) get
   `runAttempts: 2`.

6. **Versioning.** `ANALYSIS_VERSION` is in the file path
   (`beat-features/v<N>/<videoId>.json`) and in the JSON. A bump makes every
   video `absent` again, so it gets re-analysed and old and new results never
   mix. Cached audio survives a bump.

## Layout

```
plugins/integrations/plugins/youtube/
  core/                    NEW barrel: VideoIdSchema (the 11-char regex) + youtubeVideoId(raw),
                           moved from integrations/hooktheory/core (importers updated; no re-export)
  plugins/audio-fetch/     NEW
    python/                uv project, package=false: yt-dlp, yt-dlp-ejs; .python-version 3.14.7
      youtube_audio/fetch.py   stdin {videoId, outDir, bunPath} → stdout {file, ext, durationSec, title, channel, ytDlpVersion}
                               -f bestaudio, native container, no ffmpeg; --js-runtimes bun:<bunPath>;
                               downloads to a temp name, renames; yt-dlp's "unavailable" errors → exit 3 + message
    data-dirs/             cache/youtube-audio (reclaim: safe)
    server/
      youtubeAudioDep      defineDep, in the plugin's deps/ barrel
      fetchYouTubeAudio(videoId, exec, {log}) → {path, meta}   hit ⇒ touch mtime, no Python;
                           miss ⇒ ensureDep + runPython under a per-video host flock; bunPath = process.execPath
      YouTubeAudioUnavailableError (extends NonRetryableError)
      youtube-audio.sweep  defineJob, daily cron (main only by default): evict by oldest mtime
                           past 30 days, then oldest-first beyond a 2 GB cap; skips files whose flock is held
plugins/infra/plugins/audio-analysis/   NEW (single plugin; later extractors add modules or sub-plugins)
  core/                    BeatFeaturesSchema, ANALYSIS_VERSION, BeatFeaturesStateSchema,
                           get/request endpoints (defineEndpoint)
  python/                  uv project, package=false: torch, beat-this (git, pinned commit), librosa, av, numpy
      singularity_audio/beat_features.py  stdin {audioPath, device, outPath} → writes features JSON to outPath,
                                          stdout a small summary {beats, medianBpm, seconds}
      singularity_audio/sonify.py         stdin {audioPath, beats, outPath} → clicks (accented downbeats) mixed into a wav
  data-dirs/               cache/beat-features (v<N>/<videoId>.json + .running.json / .failed.json),
                           cache/audio-models (TORCH_HOME for the Beat This! checkpoint; reclaim: safe)
  server/
    audioPythonDep         defineDep, in the plugin's deps/ barrel
    ensureBeatFeatures(videoId, exec, {log, force?}) → BeatFeatures
        flock(videoId) → re-check → running.json → fetchYouTubeAudio → ensureDep(audioPythonDep)
        → exec.admit(runPython(beat_features)) → parse with the schema
        → rename into place → clear running.json; on a throw write failed.json and rethrow
    readBeatFeatures(videoId) → absent | running{since, phase} | ready{features} | failed{message, at, permanent}
    requestBeatFeatures(videoId, {force?})   enqueues the job unless ready or permanently failed
    audio-analysis.beat-features             defineSupervisedJob, run body, lock = videoId, runAttempts 2
    GET  /api/audio-analysis/beat-features/:videoId    → state (features included when ready)
    POST /api/audio-analysis/beat-features/:videoId    → request, returns state
  cli/                     ./equin audio features <videoId…> [--force] [--clicks <dir>] [--device cpu|mps]
                           runExec + cliExecContext (the deps CLI pattern): runs ensureBeatFeatures in the
                           foreground, prints a summary per song, and optionally writes <videoId>-clicks.wav
```

Deleted: `plugins/infra/plugins/deps/plugins/hello-python/`. Its mentions in
`deps/CLAUDE.md`, the `uv-updater` test and comments move to `audio-analysis`
or `youtube/audio-fetch`. Generated registries and docs are rewritten by
`./equin build`.

## Contract 1 as built (written back into the vision doc)

```ts
BeatFeatures = {
  videoId: string;
  analysisVersion: number;        // bump ⇒ re-analysis; also in the path
  durationSec: number;
  sampleRate: number;             // of the analysed signal
  tuningCents: number;            // estimated offset from A440, already compensated in the chroma
  beats: {                        // beat i spans [t, beats[i+1].t); the last one ends at durationSec
    t: number;                    // seconds
    downbeat: boolean;
    barPos: number;               // 1-based position in its bar; 0 before the first downbeat
    chroma: number[];             // 12 bins C..B, treble CQT (MIDI ≈48–96), beat-synchronous median, max-normalised
    bass: number[];               // 12 bins, bass range (MIDI ≈28–52), same treatment
    rms: number;                  // loudness of the span, 0–1: lets B's filler state spot silence and intros
  }[];
  source: { audioFormat: string; ytDlpVersion: string; model: string; device: "cpu" | "mps" };
}
```

The fields beyond the vision doc's are `barPos`, `tuningCents`, `rms` and
`source`. The arrays are max-normalised, so B picks its own template scoring.
Floats are rounded to 4 decimals, which puts a 4-minute song at about 100 KB.
The zod schema checks both bin counts are 12.

## Steps

1. `integrations/youtube/core`: add `VideoIdSchema` and move `youtubeVideoId` there. Repoint its importers.
2. `youtube/audio-fetch`: the uv project (`uv lock`), dep, data dir, `fetchYouTubeAudio`, and the sweep job with a unit test (eviction order at the cap and the TTL, on a temp dir). Prove the bun JS-runtime download on one real video **first**. It is the riskiest external piece.
3. `audio-analysis`: the core schema and state, the uv project (Beat This! pinned to a git commit; check the checkpoint licence), the extractor and sonify modules, `ensureBeatFeatures` / `read` / `request`, the job, the endpoints and the CLI verb.
   Unit tests:
   - the schema round-trips;
   - `readBeatFeatures` maps every file combination to its state, including a stale `running.json`, an old-version file and a permanent failure.
4. Delete `hello-python` and repoint its mentions.
5. Measure on the reference songs:
   - CPU vs MPS time, with beats compared between the two;
   - the install footprint (du of both envs and the checkpoint).

   MPS becomes the default only if it is more than 2× faster and within 10 ms of CPU.
6. Write the "Contract 1 as built" note into the vision doc. Record the numbers and the by-ear verdicts in this doc.
7. `./equin build` (backgrounded), `./equin check`, and `./equin test` for both plugins.

## Verification

- **Reference songs.** Run `./equin audio features <ids…> --clicks <scratch>` on four songs:
  - "Let It Be", steady piano, about 72 BPM;
  - "Wonderwall", strummed with a capo, about 87 BPM;
  - "Someone Like You", sparse and rubato-ish, about 67 BPM;
  - "Take On Me", a fast synth track, about 169 BPM.

  Each run is checked two ways:
  - **Objective:** the median BPM is within ±3% of the known tempo (octave errors show up here), and downbeats fall every 4 beats for most bars.
  - **By ear:** the user listens to each `<videoId>-clicks.wav` and gives a verdict, which is recorded here.
- **Job path, on the deployed worktree.**
  - `POST /api/audio-analysis/beat-features/<id>` for a fresh song, then `GET` shows `running` and then `ready`. The file sits under `~/.singularity/cache/beat-features/v1/`.
  - A second POST is a no-op.
  - A bogus or removed video ends `failed` with `permanent: true` and yt-dlp's message, and a re-POST does not retry it.
- **First use.** With both deps removed (`./equin deps remove …`), the first POST shows the deps installing in Settings → Dependencies, and then the features land.
- **Concurrency.** Two concurrent `ensureBeatFeatures` calls for one video, from two worktrees, download and analyse once.

## Measurements (2026-09-30, Apple Silicon, standalone runs of the extractor)

Run on the four reference songs with the locked env synced into a scratch dir
(`uv sync --frozen`), `beat_features` then `sonify`, on CPU and MPS.

| Song (videoId) | Known | Median BPM | Δ | Beats | Bars of 4 beats | Other bar lengths | CPU total / Beat This! | MPS total / Beat This! |
|---|---|---|---|---|---|---|---|---|
| Let It Be (`QDYfEBY9NM4`) | ~72 | 69.8 (mean 70.5) | −3.1 % | 279 | 83 % | 13 bars of 2 | 18.9 s / 13.2 s | 11.6 s / 5.7 s |
| Wonderwall (`FVdjZYfDuLE`) | ~87 | 88.2 | +1.4 % | 357 | 96 % | 4 bars of 2 | 18.7 s / 13.0 s | 11.2 s / 4.7 s |
| Someone Like You (`hLQl3WQQoQ0`) | ~67 | 136.4 | **2× (octave)** | 624 | 94 % | a few of 1, 3, 5 | 19.7 s / 13.3 s | 10.7 s / 3.7 s |
| Take On Me (`MIgK3zOk0zg`) | ~169 | 166.7 (mean 169.3) | −1.4 % | 636 | 99 % | 1 bar of 3 | 19.4 s / 13.2 s | 9.7 s / 3.5 s |

- **Tempo.** Three of four within about ±3 %. The median is quantised by
  Beat This!'s 50 fps frames (20 ms), which alone moves a 70 BPM reading by
  about 1.5 %. Let It Be sits just outside ±3 % on the median and inside it on
  the mean. Someone Like You is tracked at **double tempo**, an octave error
  left uncorrected by design (B tolerates half and double grids).
- **Downbeats.** Every song's first beat is a downbeat. 83–99 % of bars are
  4 beats. Let It Be's 2-beat bars are not obviously wrong; the by-ear check
  decides.
- **CPU vs MPS.** Identical output: same beat count, every beat time equal to
  4 decimals, same downbeats, on all four songs. The Beat This! stage is
  2.3–3.8× faster on MPS. The whole analysis (decode 1.5 s + beats + chroma
  4–5 s, both device-independent) is **1.6–2.0× faster**, and uses about 4×
  less CPU time (8 s vs 25–34 s user). Peak RSS is ≈1.2 GB either way.
- **Default device: CPU** at the time. It has since been superseded: the
  device is now config, defaulting to `auto`. See "Fast defaults" below.
- **Chroma cost.** The first cut ran `librosa.effects.harmonic` on the
  waveform: 27–57 s per song, more than the beat tracker. HPSS by median
  filtering on the CQT magnitude instead takes about 1 s, so chroma (tuning,
  CQT, HPSS) is 4–5 s.
- **Footprint.**
  - `audio-python` env: **≈950 MB** installed (torch 549 MB, llvmlite 129 MB,
    scipy 70 MB, av 44 MB, sklearn 31 MB, sympy 29 MB, numpy 24 MB). A warm uv
    cache syncs it in 7 s.
  - The uv-managed CPython (3.14.7 pin): ≈70 MB (shared with every Python dep).
  - The Beat This! `final0` checkpoint: 81 MB in `cache/audio-models`.
  - `youtube-audio` env: 16 MB.
  - Features: 65–150 KB per song (4-decimal floats, compact JSON).
- **Beat This! packaging and licence.** `beat-this` 1.1.0 is on PyPI now
  (since April 2026), so it is a normal locked dependency, not a git one. The
  README's licence section (added 2026-05-28) states that the code **and the
  published model weights** are MIT. Some training data is under restrictive
  licences, which the authors leave to the user to assess. That does not
  affect using the published weights for inference. The checkpoint URL is the
  authors' JKU cloud share, pinned by sha256 in `beat_features.py`.
- **Locked versions.** torch 2.14.0, torchaudio 2.11.0 (Beat This! uses it
  only for its mel spectrogram, not for I/O), librosa 1.0.0, av 18.1.0,
  numpy 2.5.3, beat-this 1.1.0. The lock was resolved with `exclude-newer`
  set to 2026-09-27, matching the uv updater's cooldown.
- **By ear.** The click tracks are `<scratchpad>/clicks/<videoId>-clicks.wav`,
  pending the user's verdict.

## Fast defaults (2026-09-30, second pass)

The user wanted a 4-minute song in about 5 s instead of about 19 s. The speed
knobs are now user config (`audioAnalysisConfig`, Settings → Config), and the
fast options are the defaults:

| Setting | Options | Default | Changes the output? |
|---|---|---|---|
| `device` | `auto` \| `cpu` \| `mps` | `auto` (MPS when available) | No. Recorded as `source.device` |
| `beatModel` | `small0` \| `final0` | `small0` | Yes. Part of the cache key |
| `chroma` | `fast` \| `full` | `fast` | Yes. Part of the cache key |

**Cache key.** The path is `beat-features/v2/<settingsKey>/<videoId>.json`,
where `settingsKey` is `<beatModel>-<chroma>chroma`, for example
`small0-fastchroma` or `final0-fullchroma`. The same settings are written to
`source.settings`.
- The lock, the running and failed markers, and the job's lock all sit under
  that key.
- Switching the config back finds the earlier entry again.
- The device is not in the key: small0 on CPU and on MPS gave bit-identical
  beats and downbeats on all four songs, as final0 did before.
- `ANALYSIS_VERSION` went to 2, because the decode changed (below).

### Where the 19 s went

On this machine, the stages broke down as follows:

- **Imports: about 5 s in total.**
  - torch took about 1.5 s.
  - `scipy.signal` took about 1.5 s. librosa loads it lazily through its
    window functions.
  - librosa's own submodules, which pull in numba, took about 0.7 s.
  - The old log's "chroma 4–5 s" was mostly these imports. The first call to
    `estimate_tuning` took 6 s, and the second took 0.7 s.
- **Decode: about 1.5 s.**
  - About 0.75 s is Opus decoding itself.
  - About 0.5 s went to 12,000 per-frame calls into PyAV's `AudioResampler`.
- **Beat This! inference, excluding imports:**
  - final0: about 11 s on CPU, about 1 s on MPS.
  - small0: about 6 s on CPU, about 0.45 s on MPS.

### What changed

1. **Decode.** Frames are decoded at their native rate and layout. The whole
   signal is then resampled once with soxr HQ, which gives a better filter
   than swresample's default. This saves about 0.4 s. There is no quality
   tradeoff, so it is the only path and has no config knob.
   - Threads did not help, because PyAV holds the GIL.
   - Four processes, each decoding a segment, saved about 0.4 s more. That
     was not worth the complexity.
   - libopus decoding at a lower rate was slower in PyAV's build.
   - `soxr` is now declared in `pyproject.toml`. It was already locked as a
     dependency of librosa and beat-this. The lock was re-resolved with the
     same `exclude-newer`, and no versions changed.
2. **Two processes.** The chroma runs in a spawned child. The child imports
   librosa, scipy and numba while the parent decodes. The parent then sends
   the child the signal, imports torch and tracks the beats. The child's
   traceback, or its exit code if it dies, is raised in the parent.
   - A thread was tried first. The two import chains contend for the GIL, so
     the thread was no faster.
3. **`small0`.** Its checkpoint is about 8 MB and is sha256-pinned like
   final0's.
4. **Fast chroma.**
   - Tuning is estimated from every fourth STFT frame (`hop_length` 2048).
   - The CQT uses a 1024-sample hop, which is 46 ms, or at least 7 frames per
     beat at 170 BPM.
   - The HPSS kernel is halved to 15 frames, so it still spans 0.7 s.
   - The first cut dropped HPSS instead. That was only about 0.1 s cheaper,
     but drums leaked into the bass. The strongest bass pitch class then
     matched `full` on only 45 % (Take On Me) to 87 % of beats, with a
     centred cosine of 0.83–0.96.

### Measurements

The comparison ran back to back on each song: the fast defaults
(auto → mps / small0 / fast), then the previous behaviour (cpu / final0 /
full). The machine was **heavily loaded**, with a 1-minute load average of
18–21 on 18 cores from other agents' builds. On quieter runs (load 6–7), the
fast defaults took **6.9 s and 8.8 s wall** on Let It Be. No quiet window came
during this pass, so the ≈5 s target is **not demonstrated**.

The parent's critical path is:
- Python start and the numpy/av imports: about 0.4 s.
- Decode: about 1.2 s.
- torch import: about 1.5 s.
- MPS initialisation, model load and inference: about 1.2 s.

That puts the floor near 4.5 s on an idle box.

Wall times in the table include interpreter start-up. CPU time is user plus
sys, both processes included.

| Song | Load (1 min) | Fast: wall / CPU | decode · chroma child ready + compute · Beat This! (incl. torch import) | Full: wall / CPU | decode · chroma · Beat This! |
|---|---|---|---|---|---|
| Let It Be | 19.2 / 20.4 | 22.3 s / 10.0 s ¹ | 6.7 · 10.5 + 2.2 · 7.3 | 28.6 s / 34.1 s | 2.3 · 2.7 · 22.8 |
| Wonderwall | 21.4 / 19.8 | 9.4 s / 9.1 s | 2.1 · 3.3 + 1.3 · 4.2 | 34.3 s / 32.5 s | 1.9 · 4.2 · 29.1 |
| Someone Like You | 18.3 / 18.2 | 10.7 s / 8.7 s | 2.7 · 3.5 + 1.4 · 5.2 | 39.4 s / 34.8 s | 4.3 · 3.1 · 29.7 |
| Take On Me | 19.6 / 18.0 | 10.6 s / 9.2 s | 1.5 · 2.9 + 1.1 · 4.5 | 19.9 s / 32.5 s | 1.5 · 2.6 · 15.8 |

¹ A load spike: this run's decode alone took 6.7 s, against 1.2–1.6 s on
every other run of the same file.

Across this pass, the fast defaults were **2–4× faster in wall time** and used
**about 3.5× less CPU**. MPS moves the beat tracker's work onto the GPU.

**Agreement: fast defaults (small0) vs final0.** Beats and downbeats count as
agreeing within 50 ms. The chroma comparison uses the same final0 grid for both
variants, max-normalised profiles, and a centred cosine (the mean removed per
beat, so the shared floor does not inflate the score).

| Song | Beats small0 / final0 | final0 beats matched / small0 beats matched | Downbeats: final0 matched / small0 matched | Median BPM small0 / final0 | Treble: centred cos mean (p5, min) · argmax agree | Bass: centred cos mean (p5, min) · argmax agree |
|---|---|---|---|---|---|---|
| Let It Be | 279 / 279 | 100 % / 100 % | 97.4 % / 88.4 % | 69.8 / 69.8 | 0.994 (0.980, 0.950) · 95 % | 0.997 (0.991, 0.972) · 97 % |
| Wonderwall | 362 / 357 | 100 % / 98.6 % | 98.9 % / 95.8 % | 88.2 / 88.2 | 0.985 (0.954, 0.851) · 90 % | 0.995 (0.987, 0.954) · 96 % |
| Someone Like You | 632 / 621 | 99.2 % / 97.5 % | 98.7 % / 96.9 % | 136.4 / 136.4 | 0.994 (0.979, 0.883) · 92 % | 0.999 (0.996, 0.978) · 98 % |
| Take On Me | 633 / 636 | 99.4 % / 99.8 % | 98.1 % / 99.4 % | 166.7 / 166.7 | 0.982 (0.946, 0.743) · 87 % | 0.984 (0.952, 0.855) · 90 % |

- **Beats.** More than 97 % agree both ways on every song. The median BPM is
  identical on all four. There is no new tempo-octave flip: Someone Like You
  is at double tempo with both models.
- **Downbeats.** small0 marks some extra downbeats. On Let It Be it marks 86
  against final0's 78, so only 88 % of its downbeats match. That is the one
  place small0 reads visibly differently. Let It Be's bar lengths were already
  the least regular (final0: 83 % of bars were 4 beats).
- **Chroma.** On average the fast chroma is within about 0.98–0.999 of `full`.
  The worst beats are the densest synth passages of Take On Me (min 0.74).
  Tuning estimates agree to within 1 cent.
- **Device.** small0 on CPU and on MPS gave identical output, down to
  0.0 s of beat-time difference, so the device stays out of the cache key.
- **Not yet done:** the by-ear check of small0's click tracks.

### Deployed run and the default beat model (after the build)

All four songs through `./equin audio features` on the deployed worktree,
with `small0` + fast chroma + MPS, at load 19–22 on 18 cores the whole time:
23–44 s per song (the old defaults took 40–60 s under similar load). Under load
the time is contention and Python start-up, not the models: the chroma process
took 8–25 s to import, and MPS beat tracking took 9.5–22 s, against 3.5–5.7 s
when quieter (the CPU-side spectrogram, the kernel launches and a per-process
MPS warm-up all compete for CPU). The ~5 s target still needs an idle machine.

The share of bars that are 4 beats is the clearer downbeat signal here:

| Song | final0 | small0 |
|---|---|---|
| Let It Be | 83 % | **64 %** (31 two-beat bars) |
| Wonderwall | 96 % | 91 % |
| Someone Like You | 94 % | 94 % |
| Take On Me | 99 % | 97 % |

Downbeats feed the aligner directly, and each video is analysed once, so the
**default beat model is `final0`**; `small0` stays a setting. Fast chroma, the
single-pass decode and `device: auto` stay the defaults.

## Risks

- **yt-dlp vs YouTube.** Breakage is expected. It surfaces as `failed(message)`, and the fix is a `youtube-audio` lock bump, which the `uv` updater makes cheap after the split.
- **Beat This! packaging.** Resolved: it is on PyPI (1.1.0), locked like any other package, and its weights are MIT (see Measurements). Its checkpoint is downloaded by the extractor itself, sha256-checked, into `cache/audio-models`.
- **Tempo octave errors on ballads.** B has to tolerate half or double grids anyway. The contract carries raw beats, and nothing is "corrected" in A.
