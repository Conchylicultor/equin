# YouTube audio download: the intermittent HTTP 403, retried and classified

## Context

`youtube_audio.fetch` (`plugins/integrations/plugins/youtube/python/youtube_audio/fetch.py`,
run by `fetchYouTubeAudio` in `plugins/integrations/plugins/youtube/plugins/audio-fetch/server/internal/fetch.ts`)
failed on Shape Of You's third candidate (`liTfD88dbCo`) with
`ERROR: unable to download video data: HTTP Error 403: Forbidden` during the
UG alignment auto-pick (research/2026-10-07-apps-sonata-ug-alignment-video.md, Results).

Since then, d44826495b added a first classification layer: exit 3 `UNAVAILABLE`
→ `YouTubeAudioUnavailableError`, exit 4 `DOWNLOAD_FAILED` → `YouTubeAudioDownloadError`,
so a 403 now skips one candidate instead of failing the whole walk. What remains:

- Nothing retries the 403, so a video YouTube *does* serve is still lost.
- Classification reads yt-dlp's English message with regexes, and passes the
  result to TS through an exit code and a regex over the stderr tail.
- Bot checks and network failures are still a raw `PythonEntryError` with a
  Python traceback in its message.

## What the investigation found (2026-10-07)

Environment: yt-dlp 2026.8.19 (latest stable on PyPI), yt-dlp-ejs 0.8.0 (latest), bun 1.4.2.

1. **The 403 is intermittent, not per-video.** Re-running the real download
   path on `liTfD88dbCo`: the first try got 403, and the next 7 tries succeeded.
   A cheaper probe (extract, then a 1 KB range GET on the chosen stream) passed
   63 of 63 over 21 videos × 3. The original failure and my reproduction look
   the same: extraction succeeds (visionos player API, format 251), then the
   **first** request to the `googlevideo.com` stream URL is refused in
   `http.py establish_connection`.
2. **yt-dlp does not retry it.** Its `retries` cover 5xx, timeouts and
   truncated reads. A 403 on the stream is fatal, and the URL that was refused
   is never refreshed.
3. **A fresh extraction fixes it.** Each re-extraction mints a new signed URL
   (often on another CDN node), and every retry I ran succeeded.
4. **Ruled out:**
   - **The pinned version:** it is the latest stable release. The known
     `android_vr` 403 (yt-dlp#17456) was fixed in 2026.08.19, the version we
     already pin.
   - **An IP mismatch:** the stream URL is signed for the extracting IP (`ip=`
     is the rotating macOS temporary IPv6). Fetching it from the other address
     family returns 302 and then 206, so it is not refused.
   - **The JS runtime:** bun is found when given the real binary. The default
     visionos client needs no challenge.
5. **No client fallback is possible.** I tried `android_vr`, `tv`, `web_safari`,
   `ios`, `mweb` and `web` on 4 videos. Every one returned "Requested format is
   not available", because without a PO token they now serve no audio formats.
   Visionos is the only client that works without one. A PO-token provider
   (bgutil + a server) is a separate, much larger change, and only worth it if
   visionos stops working (see Follow-ups).

**Conclusion.** Googlevideo sometimes refuses a freshly signed visionos stream
URL on its first request, and the cause is on YouTube's side. The fix is to
re-extract and try again. A video that still gets 403 after the retries is
reported as "refused", which is likely to clear later.

## Design

### 1. Python: retry with a fresh URL (`fetch.py`)

- Wrap `extract_info(url, download=True)` in at most `ATTEMPTS = 3` attempts.
  Each attempt opens a new `YoutubeDL`, so the stream URL is signed again.
  Wait 1 s, then 3 s, between attempts.
- Retry only when the stream is refused. The cause comes from the exception,
  not from the message text:
  - `DownloadError.exc_info[1]` is a `yt_dlp.networking.exceptions.HTTPError`
    with `status == 403`.
  - The 403 happened while downloading, not while extracting: `info` was
    resolved and the downloader raised.
- Log each retry on stderr, for example
  `stream refused (HTTP 403, format 251, client visionos); re-extracting, attempt 2/3`.
- The `.part` cleanup in `finally` runs after each attempt.

### 2. Failure is data, not an exit code (the module's stdout contract)

The single stdout document becomes a discriminated union. The process exits 0
for any failure it has classified. A non-zero exit then means only a real crash
(a bug), which stays loud with its traceback.

```jsonc
{ "ok": true,  "file", "format", "durationSec", "title", "channel", "ytDlpVersion", "attempts" }
{ "ok": false, "kind": "unavailable" | "refused" | "blocked" | "network",
  "message": "<one readable line>", "detail": "<yt-dlp's own line>", "attempts": n }
```

| kind | meaning | scope | transient? |
|---|---|---|---|
| `unavailable` | private, removed, age-gated, members-only, "Video unavailable" | this video | no |
| `refused` | stream still 403 after the retries, or any other unclassified `DownloadError` on this video (e.g. a broken format) | this video | yes |
| `blocked` | "Sign in to confirm you're not a bot" (bot check on this IP) | machine | yes |
| `network` | `TransportError` / DNS / connection reset or refused / timeout | machine | yes |

- **How each kind is detected.**
  - `network` comes from the exception type: `isinstance(cause, TransportError)`
    and not an `HTTPError`.
  - `refused` comes from the status of the `HTTPError`.
  - `unavailable` and `blocked` can only be told apart by yt-dlp's extractor
    message, so the `PERMANENT` and `MACHINE` regexes stay for those two kinds
    only. `MACHINE` loses its network alternatives, which now come from the
    exception type.
- **The message is readable.** For example: `YouTube refused the audio stream
  (HTTP 403) on 3 fresh tries`, `YouTube asks this machine to prove it is not a
  bot`, or `Cannot reach YouTube: <reason>`. `detail` keeps yt-dlp's own line,
  without the `ERROR: ` prefix.
- The classifier is one pure function, `classify(err, attempts) -> dict`, in
  `fetch.py`.
- `EXIT_UNAVAILABLE` and `EXIT_DOWNLOAD_FAILED` are deleted, along with the
  `UNAVAILABLE:` and `DOWNLOAD_FAILED:` stderr protocol.

### 3. TS: the schema decides the error (`audio-fetch/server/internal/fetch.ts`)

- `FetchOutputSchema` becomes `z.discriminatedUnion("ok", …)`.
- `EXIT_*`, `*_LINE` and the stderr-tail regexes are deleted.
- One pure mapping, `failureError(videoId, failure)`:
  - `unavailable` → `YouTubeAudioUnavailableError` (a `NonRetryableError`, unchanged).
  - `refused` → `YouTubeAudioDownloadError` (retryable, unchanged name).
  - `blocked` and `network` → **new** `YouTubeAccessError`
    (`kind: "blocked" | "network"`, retryable, a readable message, no
    traceback). It is **not** covered by `isYouTubeAudioError`, because it is
    the machine's failure. The UG candidate walk (`decide.ts`
    `candidateFailure`) therefore still fails the run instead of blaming the
    candidate, now with a legible reason.
- Each error carries `reason` (the readable message) and `detail` (yt-dlp's
  line). `candidateFailure` and the audio-analysis `failed` state keep reading
  `err.reason`, so neither consumer changes.
- Export `YouTubeAccessError` from the server barrel, and add it to
  `server/testing`.
- Update the plugin description in `server/index.ts`, and the "Unavailable" /
  "Download failed" sections of `audio-fetch/CLAUDE.md`. That includes the
  investigation's findings: the intermittent 403 is retried with a fresh URL,
  and visionos is the only client that works without a PO token.

### 4. Tests

- **`audio-fetch/server/internal/fetch.test.ts` (new, pure):**
  - Every `kind` maps to its error class.
  - `isYouTubeAudioError` is true for `unavailable` and `refused` only.
  - The union schema rejects a malformed document.
- The Python retry and classifier are checked in Verification. There is no
  Python test runner in the repo, and this change does not add one.

## Files

- `plugins/integrations/plugins/youtube/python/youtube_audio/fetch.py`: retry loop, `classify`, union output.
- `plugins/integrations/plugins/youtube/plugins/audio-fetch/server/internal/fetch.ts`: union schema, `failureError`, `YouTubeAccessError`.
- `plugins/integrations/plugins/youtube/plugins/audio-fetch/server/{index.ts,testing/index.ts}`: export the new error.
- `plugins/integrations/plugins/youtube/plugins/audio-fetch/server/internal/fetch.test.ts`: new.
- `plugins/integrations/plugins/youtube/plugins/audio-fetch/CLAUDE.md`: updated prose.
- No consumer changes are needed:
  - `decide.ts` and the audio-analysis `ensure.ts` read `isYouTubeAudioError`, `isNonRetryableError` and `.reason`.
  - `decide.test.ts` already builds its errors from `server/testing`.

## Verification

1. `./equin test plugins/integrations/plugins/youtube/plugins/audio-fetch`.
2. Run the module by hand against the installed env with a scratch harness
   (`runPython` equivalent):
   - Real videos (`liTfD88dbCo`, `dQw4w9WgXcQ`) → `ok: true`.
   - A removed or private id → `unavailable`.
   - With `HTTPS_PROXY=http://127.0.0.1:9` → `network`, a readable message, and no traceback.
   - A scratch wrapper that monkeypatches the HTTP downloader to raise
     `HTTPError(403)` on the first 1 or 2 calls → `ok: true` with
     `attempts: 2` or `3`. Raising on every call → `refused`, `attempts: 3`.
3. `./equin build`, then trigger an UG alignment / beat-features run on a
   fresh video, and confirm the download and the logs show the per-attempt line.
4. `./equin check` (type-check, boundaries, docs in sync).

## Follow-ups (not in this change)

- **If visionos stops working** (403 on every attempt, or no audio formats):
  - Add a PO-token provider (yt-dlp's `bgutil-ytdlp-pot-provider`, its script
    mode run on bun) and fall back to the `web` clients.
  - Today that is speculative, so it is filed as a task, not built.
- **Shape Of You result:** after this lands, re-running Shape Of You's alignment
  should let the walk reach `liTfD88dbCo` again.

## Results (2026-10-07)

`youtube_audio.fetch` was run by hand against the installed env (yt-dlp
2026.8.19). The HTTP downloader was patched to raise HTTP 403 for the
injected cases.

| case | output | attempts |
|---|---|---|
| `liTfD88dbCo` (the original failure) | `ok: true`, webm | 1 |
| 403 injected once | `ok: true` | 2 |
| 403 injected twice | `ok: true` | 3 |
| 403 on every try | `refused`: "YouTube refused the audio stream (HTTP 403, format 251, visionos client) on 3 fresh tries" | 3 |
| a non-existent id | `unavailable`: "This video is unavailable" | 1 |
| `HTTPS_PROXY` set to a dead port | `network`: "Cannot reach YouTube: [Errno 61] Connection refused" | 1 |

- No case printed a traceback or left a `.part` file.
- Found during implementation: running `process_ie_result(info, download=True)`
  on an info dict that was already processed fills `requested_downloads`
  without `ext`. The file's container is therefore read from the path that
  was written.
- `./equin test …/audio-fetch` passed 15 of 15.
- `./equin build` succeeded, checks included.
