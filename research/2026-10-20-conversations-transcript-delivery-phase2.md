# SDK Claude Phase 2, steps 1–3: transcript delivery

Track: wiki *Mental model → Agent Manager → SDK Claude*; the design agreed on its sub-page *Phase 2: transcript delivery and streaming*. This doc covers steps 1–3 and the measurement. Streaming (step 4) is the next session.

## Context

Every change to a transcript cost the size of the whole conversation:

- `transcript-watcher` re-read every file of the session chain and parsed all of it.
- `jsonl-events` pushed the whole `JsonlEvent[]` to the page.

Opening a conversation loaded and drew all of it.

What actually reached the page from a 52 MB transcript: 8.7 MB per change, mostly prompt images (`user-text` segments, 4.2 MB) and attached-file payloads (3.3 MB). Tool-result images (23 MB in the file) were already dropped by the parser. `api-request-blob` lines (12 MB) carry no timestamp, so they never became events.

## What was built (and where it differs from the plan)

### 1. Images by reference — `transcript-source/server/internal/image-key.ts`

- An event carries `TranscriptImage { key, mime }` instead of base64. This covers `user-image`, user-text image segments, and attached-file images (`content.file.image`).
- **The key encodes its own locator.** For an inline image it is the transcript file, the line's byte offset, length and uuid, and the image's index in the line. For a prompt's `@/path.png` it is the path plus the file's mtime and size.
  - Any host answers a key with no per-conversation state, a sub-agent's file included, and after a restart.
  - This replaces the planned per-conversation image table.
- `GET /api/transcript-images/:key` (jsonl-viewer) calls `TranscriptSource.image(key)`. Each host reads with its own I/O through `readImageKey`.
  - The desktop host refuses anything outside `~/.claude/projects/**.jsonl` and any non-image path.
  - The memory host slices its stored JSONL.
- **Immutable cache.** The read re-checks the line's uuid, or the file's mtime and size, and answers 410 when they changed — never other bytes. So the response is `cache-control: immutable`.

### 2. Read only appended bytes — `TranscriptLines` + `readChain`

Measured first: on the 52 MB transcript the full read took 25 ms of I/O, 37 ms of JSON decoding and **8 ms of event building**. So the planned incremental parser state machine, with every cross-line rule re-expressed as a mutation, was not worth its risk. Instead:

- **`TranscriptLines` (transcript-source, portable)** keeps the chain's decoded lines, **held slim**:
  - inline images become keys;
  - tool-result images and `toolUseResult` are dropped, except an AskUserQuestion answer;
  - an `api-request`'s request body is reduced to the fields `requestConfigOf` reads (`slimApiRequestLine`, pinned by a test);
  - lines with neither a uuid nor a timestamp are dropped.

  `append(file, offset, bytes)` decodes only complete lines; an incomplete tail waits for the next read. `events()` rebuilds from the held lines (memoized per change). The cross-line rules (branch filter, pairing, merging) therefore always see the whole chain, and an incremental read cannot answer differently from a full one.
- **`readChain(paths, previous)` (transcript-watcher)** continues the previous read when the chain is the same files (same inode) and only the last one grew, or new files followed. Anything else starts over: a rewind renames and rewrites the file, an earlier file grew, or a file shrank.
- The watcher room's `read(paths, previous)` passes its last value in. `mergeChainLines` is now a one-off read through `TranscriptLines`.

### 3. Send changes, open on the latest window

- **`jsonlEvents` is a key-range-paged `liveValue`** (`query {id}`, rows `{id, seq, event}`, newest first, 200 per page, `maxLimit` 5000), not the external collection the plan named.
  - It gets keyed deltas, one watch per question (`whileSubscribed`), `sliceRange` and a `meta` sibling (`count`, `firstAssistantSeq`).
  - Row id: `tool:<toolUseId>` for a tool call, `s<seq>` otherwise.
- **One watch, one memo per conversation** (`conversation-events.ts`): a refcounted hub over one `TranscriptSource.watch`. It primes the shared signed memo before any value is notified, so every value served from a conversation's events reads memory.
- **Page:**
  - `useTranscriptWindow` gives the events oldest first, the row ids, `firstSeq` and the paging handles.
  - `TranscriptView` takes `ids` (stable React keys), `firstSeq` and `older`. A top sentinel loads older pages through `useInView`, and `KeepAnchorAcross` keeps the reader in place.
  - Folds know `answeredBefore`.
- **Whole-conversation readers** (audited 18):

| Reader | Source now |
| --- | --- |
| AskUserQuestion state, change-answers | the drawn window (a tail window holds every event after a drawn call) |
| pending turns, selection toolbar, event filters, context folds | the window |
| workflow node pane | `transcriptToolCall` (one call by id) |
| event counter | `jsonlEvents.meta` |
| outline | `jsonl-viewer.outline.turns` value; a jump to an unloaded turn scrolls to the top (older pages load) and reveals the row once it mounts |
| task-progress overlay | `jsonl-viewer.task-tools.aggregate` value |
| background shells | `background-shells.facts` value (status joined on the page) |
| sub-agent statuses, sub-agent pane's Agent call | `subagents.parent-facts` value |
| artifacts | `conversations.conversation-view.artifacts` value; each kind's pure extractor moved to `core/` and is contributed server-side (`ConversationArtifactExtractor`), browser-recordings included |
| usage / token budget / agents stats | **resumable folds** (`TranscriptFold`: `init`, `step`, and a `before` value): the server folds everything before the window, the page continues over the loaded rows up to the reading position |
| agent thread | one page at the ceiling (a thread is drawn whole), kept live by deltas |

- **Generic primitives:**
  - `serveTranscriptValue(value, derive)` and `useWholeTranscript(value, derive)`: the same `derive` on the server over a window, or locally over a whole transcript (a sub-agent pane).
  - `serveTranscriptFold` and `useTranscriptFold`.
  - `readyResource` (live-state), `scrollToTop` (auto-scroll), and the `OutlineRail` prop `onUnmounted`.
- An equal recompute hands back the object last served, so the runtime sends nothing.

### The outline jump, and the primitive fixes it surfaced

A jump to a turn older than the window: `TranscriptView`'s `seekOlder` (in its drawn context) keeps the view at the top while older pages load — re-asserting the top after each, since the parked reader's browser scroll anchoring holds the old first row — and the outline reveals the row instantly once it has mounted. The e2e `toc-lands-on-right-message.ts` (now: the rendered prompts are the outline's TAIL; an entry may load before it is revealed) caught three things, each fixed where it lives:

- `OutlineRail`: `onUnmounted(id)` (a pick whose element is not mounted goes to the host) and `revealBehavior` (`auto` for a host that loads content above the target while it scrolls — a smooth scroll aims at an offset fixed when it starts).
- `KeepAnchorAcross`: `weakAttr` now also applies to a candidate inside a marked ancestor; the transcript marks its pinned (sticky) prompt headers, which do not move when content lands above them and so made a wrong anchor.
- `useActiveInView` (scroll-spy): kept watching for ids whose element is not mounted until every one has enrolled (scoped to the scroller once known) — it stopped after the first, so a row mounted later (an older page) never counted, and the current dash stuck.

## Measured before / after

**Server, per appended line** (`transcript-source/scripts/transcript-delivery-bench.ts`, replaying the last 100 lines one at a time):

| Transcript | Before: per change | After: server per line (median / p95) | After: delta per line (median / p95 / max) |
| --- | --- | --- | --- |
| 52 MB, 2,565 lines, 735 events | full read + parse 71–75 ms, push 8.70 MB | 2.6 / 4.6 ms | 0.2 / 1.7 / 2.8 KB |
| 51 MB, 5,458 lines, 1,561 events | 97–106 ms, push 3.21 MB | 11 / 21 ms | 0.2 / 4.7 / 15.6 KB |

Lines held in memory per open conversation: 8.6 MB and 8.2 MB. Before the request-body slimming, the second transcript held 45 MB.

**Opening the page** (`jsonl-viewer/e2e/open-cost.ts`, fresh browser session per run; bytes are the live-state frames of the transcript's own reads):

| Conversation | Before (main) | After (this build) |
| --- | --- | --- |
| 52 MB (`conv-1792111276-74mf3o`) | 17.4 MB received (the 8.7 MB array, twice); 518 rows drawn; first row 17–23 s | 0.8 MB; 142 rows drawn (the latest 200 events); first row 13 s (36–42 s on the two runs right after the deploy restart) |
| 51 MB (`conv-1792039733-mdzd1h`) | no row within 90 s | 1.4 MB; 136 rows; first row 5.6–6.9 s |

Time to first row includes the whole app boot (about 8 MB of other live state) on a loaded machine. Builds and tests of other worktrees were running, so treat it as indicative. The byte counts are exact.

## Verification

- Tests:
  - `read-chain.test.ts`: incremental equals full at chunk sizes of 1, 7, {13, 1, 64} and 100,000 bytes; a split line; a rewind sibling; a replaced file; a shrunk file; a new chain file (fork); an earlier file growing; slim holding.
  - `transcript-lines.test.ts` (the chain merge) and `api-request.test.ts` (the slimming preserves the config).
  - The existing parser and watcher suites.
  - Result: 127/127 in transcript-watcher and transcript-source; 1004 bun and 215 vitest across `plugins/conversations`.
  - One pre-existing vitest suite fails at import, untouched by this branch: `attachment/plugins/instructions/web/__tests__/instructions-view.test.tsx` imports the Bun-only `infra/paths/core` (`import.meta.dir`) under jsdom.
- Live on the build:
  - images load from their URLs (all 200);
  - scrolling to the top loaded older pages (142 → 433 → 518 rows) with the reading position kept;
  - `outline/e2e/toc-lands-on-right-message.ts` on the 52 MB conversation: 9/9. The first, middle and last turn (the first loaded on demand) each land on their row and become the current dash. On main, the same conversation did not draw within the script's 30 s boot.

## Not in this session

- Token streaming (step 4).
- The `@singularity-host` mark: the four Phase-1 checkouts still exist.
- A viewport-mode transcript (no 5000-event ceiling for the page). The largest transcript measured parses to 1,561 events.
