# Agent workspaces (worktree | scratch) + Sonata sheet-music transcription

## Context

Instagram/YouTube piano videos often show an engraved score above the player (e.g. a "Funk Piano
Groove": grand staff, chord symbols `Dm9 C/E Fmaj7`, "Swung 16ths ♩=110"). We want an agent to
transcribe that score into something Sonata plays and engraves — and, generically, to transcribe any
sheet music (photo, PDF) later.

Two constraints from the user shape the design:

1. **It is an agent task you can watch** (open the conversation, read along, step in on an ambiguous
   bar) — not a hidden one-shot job.
2. **That agent must not carry Singularity's context.** Today every conversation runs in a git
   worktree of this repo, so it boots with the root CLAUDE.md, the plugin index, the repo's
   `.claude/settings.json` guards and every `equin` MCP tool — tens of thousands of wasted tokens for
   a task that never touches the code.

Hence two deliverables, the first generic and load-bearing:

- **Agent workspaces**: *where a conversation runs* becomes a first-class abstraction with two
  implementations — `worktree` (today's agent, unchanged behaviour) and `scratch` (a plain directory
  with caller-provided instructions, an MCP tool allowlist, no git / DB fork / build).
- **Sonata transcription**: a `scratch` profile + tools that turn images/video frames into MusicXML
  via a render-and-compare loop, a MusicXML source, and a "Transcribe" entry in the library.

## Findings that constrain the design

- The worktree is tied to the **attempt** (`attemptFields.worktreePath`,
  `plugins/tasks/plugins/tasks-core/core/internal/fields.ts:57`); invariant
  `basename(worktreePath) === attempt.id` and `isCanonicalWorktreePath`
  (`tasks-core/server/internal/mutations/cross-table.ts:88-109`). Every conversation has an attempt;
  every attempt a task.
- Lifecycle (`plugins/conversations/server/internal/lifecycle.ts`): prepare derives the path via
  `worktreePathFor` (`infra/worktree/server/internal/worktree.ts:196`); commit enqueues
  `databaseForkJob` and the spawn job with `needsWorktreeSetup`; `spawn-job.ts` runs `setupWorktree`
  (spare pool) then `Runtime.get(id).create(conversationId, worktreePath, …)`; `finishConversation`
  runs `forkConfig`; resume gates on `existsSync(worktreePath)`.
- Runtime registry precedent: `Runtime.register/get/all` (`conversations/server/internal/runtime.ts:143-170`).
  The workspace registry mirrors it; it is orthogonal to the runtime (tmux | api).
- Launch: `tmux-runtime.ts` ~L700-775 builds `claude [--model] [--effort] --settings '<json>' …`
  with `-c <worktreePath>`. Settings fragments merge through `mergeLaunchSettings`
  (`runtime-tmux/server/internal/launch-settings.ts`) — signal/relay hooks are absolute and survive
  any cwd. Only `.mcp.json` and the repo guards are cwd-relative.
- Transcripts are found by session id under `~/.claude/projects` (`transcript-watcher/.../anchor.ts`,
  `find-transcript-path.ts`), not by cwd → a scratch cwd works as long as all of a conversation's
  sessions share one cwd (forks included).
- MCP: `handle-mcp.ts` already filters per conversation (`McpTool.when({conversationId})`).
- Web: ~20 `conversation-view` contributors assume git (code/edited-files, explorer, commits-graph,
  branch, push-*, vscode, op-status, open-app, allow-monitor, markdown file links, …). **No slot has a
  predicate** — contributors always render.
- Reaper `debug/plugins/worktree-cleanup` scans `.claude/worktrees` only.
- Sonata: sources contribute `SonataDocument.Source` (pure `compile(raw) → Score`) +
  `Library.Source` (`hydrate`, `createOption`); persistence via `defineExtension` side tables; files via
  the attachments plugin; `createSongRow` is source-agnostic (MIDI source = template). No song
  "pending" state exists. Score (`score/core/types.ts`) has notes (pitch, spelling, start/duration,
  voice, track), tempo/time-sig maps, key, chord/section/lyric annotations — no ties/rests (inferred
  when engraving), no dynamics, **no swing**. No MusicXML/verovio dependency anywhere. On-demand
  deps: `defineDep` + `pythonEnv` (template: `integrations/plugins/youtube/deps/internal/yt-dlp.ts`);
  no ffmpeg (PyAV is the precedent, `infra/plugins/audio-analysis`).

## Design

### 1. Agent workspaces (`plugins/conversations/plugins/workspace/`)

**Kinds are a closed set → plain data in `core/`** (both runtimes need it; the open set is
*profiles*, below):

```ts
// workspace/core
type WorkspaceKind = "worktree" | "scratch";
type WorkspaceCapability = "git" | "db-fork" | "build" | "project-context";
const WORKSPACE_KINDS: Record<WorkspaceKind, { capabilities: readonly WorkspaceCapability[] }> = {
  worktree: { capabilities: ["git", "db-fork", "build", "project-context"] },
  scratch:  { capabilities: [] },
};
type WorkspaceSpec = { kind: "worktree" } | { kind: "scratch"; profile: ScratchProfileId };
```

**Server contract** — one implementation per kind, registered like `Runtime`:

```ts
interface WorkspaceImpl {
  kind: WorkspaceKind;
  pathFor(attemptId): string;                       // worktree: .claude/worktrees/<id>; scratch: ~/.singularity/workspaces/<id>
  onCommit(tx, attempt): Promise<void>;             // worktree: enqueue databaseForkJob; scratch: no-op
  prepare(attempt, spec, signal): Promise<void>;    // worktree: setupWorktree + spare refill; scratch: mkdir, write CLAUDE.md, materialize inputs, ensure deps
  onFinish(attempt): Promise<void>;                 // worktree: forkConfig; scratch: no-op
  launch(attempt, spec): LaunchFragment;            // extra argv + settings fragment for the runtime
  assertResumable(attempt): void;                   // existence check with kind-specific error text
}
```

- **Data**: attempts gain `workspace` (jsonb, `WorkspaceSpec`, zod-decoded via `sql-column`
  `parsedJson`; migration backfills `{kind:"worktree"}`). `worktreePath` → `workspacePath`, and the
  cross-table invariant generalizes to `workspacePath === impl(kind).pathFor(id)` (scratch dirs
  stop being "non-canonical" and getting refused/adopted wrongly).
- **Lifecycle**: `CreateConversationOpts` gains `workspace?: WorkspaceSpec` (default worktree).
  `prepare/commit/spawn/finish/resume` call the impl instead of `worktreePathFor` /
  `databaseForkJob` / `setupWorktree` / `forkConfig` / `existsSync` directly. Phase 1 is a pure
  refactor with `worktree` as the only impl — no behaviour change.
- **Runtime**: `ConversationRuntime.create(conversationId, cwd, opts)` takes `cwd` + the impl's
  `LaunchFragment` (rename only; tmux stays workspace-agnostic). Scratch's fragment:
  `--setting-sources user` (the user's own `~/.claude` settings and memory still apply — decided
  2026-10-13; only project/local repo context is dropped), `--strict-mcp-config --mcp-config
  <equin url for this conversation>`, plus the profile's `permissions` merged by
  `mergeLaunchSettings`. Hooks (signals, question relay) already come through `--settings` and keep
  working.
- **Scratch profiles — the open set** (contributed by feature plugins, server barrel):

  ```ts
  defineScratchProfile({
    id: "sonata.transcription",
    instructions: string,            // becomes the dir's CLAUDE.md — the agent's entire context
    mcpTools: ["sonata_submit_transcription", "flag_raise"],
    deps: [transcriptionToolsDep],   // ensured in prepare; bin dir put on PATH
    permissions: { allow: ["Bash", "Read", "Write", "Edit"] },   // scoped to the dir by cwd
    taskCategory: "sonata",
  })
  ```

  Instructions live in code, not in the row, so improving them applies to the next launch.
- **MCP allowlist**: `handle-mcp` resolves conversation → attempt → spec; for scratch it exposes
  exactly `profile.mcpTools`. Tools can declare `profiles: [id]` to be visible *only* there (so
  `sonata_submit_transcription` never shows to worktree agents). One generic filter, no per-tool
  `when` hand-rolling.
- **Web gating (type-level)**: the conversation row carries `workspace.kind`. Conversation-view slots
  (`Conversation.PromptBar`, `PromptInput`, `AbovePromptInput`, `conversationPane.Actions`, …) get a
  **required** `requires: readonly WorkspaceCapability[]` field on each contribution (`[]` = any);
  the slot host filters by `WORKSPACE_KINDS[kind].capabilities`. Required ⇒ tsc forces every existing
  contributor to state whether it needs git, which is the point. Server git resources reached by
  attempt (edited-files, attempt-work, commits-graph, code-explorer) assert the `git` capability at
  their resolve boundary (loud failure, never a silent empty diff).
- **Reaping**: a `workspace.scratch-reap` `defineJob` (scheduled) deletes scratch dirs whose task is
  done/dropped for > N days or whose attempt row is gone. `worktree-cleanup` stays the worktree impl's
  reaper.
- **Lean-context check**: user-level settings and memory (`~/.claude/settings.json`,
  `~/.claude/CLAUDE.md`, user plugins) are **kept on purpose** — agents follow the user's settings.
  Verify (see Verification) that project + local sources are absent and the `--settings` fragment
  still applies.

### 2. MusicXML source (`apps/sonata/plugins/sources/plugins/musicxml/`)

Useful on its own (MuseScore/Dorico/Sibelius exports) and the transcription output format (keeps
chord symbols, tempo, swing, voices, ties — MIDI drops them).

- `shared/parse.ts`: pure TS `parseMusicXml(xml) → Score` (`fast-xml-parser`, works on web and
  server; validation shares it). Maps parts/staves → tracks (RH/LH), `divisions` → beats, merges ties,
  unrolls repeats/voltas, `<sound tempo>`/`<metronome>` → tempoMap, `<time>`, `<key fifths>` →
  `meta.key`, `<harmony>` → authored chord annotations, `<pitch>` → spelling, `<voice>`,
  `<work-title>`/`<creator>` → meta. Unsupported constructs throw a typed error naming the element
  (fail loudly; the submit tool turns it into feedback for the agent).
- Persistence/hydration/create option/file-preview mirror `sources/plugins/midi` (extension table
  `{attachmentId, contentHash}`, attachment upload, `createSongRow`, content-hash dedup). `.musicxml`
  / `.xml` in v1; `.mxl` (zip) follow-up.
- **Swing**: Score has no swing, so a swung groove plays straight. Add `meta.swing?: {unit: 8|16,
  ratio}` (from MusicXML 4 `<sound><swing>`) applied by the playback session when scheduling —
  small, separately reviewable step inside this phase.

### 3. Library pending state (generic, `apps/sonata/plugins/library`)

`Library.Source.hydrate` returns a discriminated result instead of `raw | undefined`:
`{kind:"raw", raw} | {kind:"absent"} | {kind:"pending", label, Body}`. The player pane renders a
pending source's `Body` instead of composing an empty score (an empty score would be a false claim
about the song). The library card shows the status through a `Library.Fields` badge.

### 4. Transcription (`apps/sonata/plugins/transcription/`)

- **Input → song**: `POST /api/sonata/transcribe` with `{kind:"url", url}` (Instagram/YouTube/any
  yt-dlp site) or `{kind:"files", attachmentIds}` (images/PDF). Creates the song row (`source:
  "musicxml"`, placeholder title), an extension row
  `sonata_songs_ext_transcription {status: transcribing|ready|failed, input, taskId, error?}`, a task
  in the Sonata category, and launches it with `workspace: {kind:"scratch", profile:
  "sonata.transcription"}` and a prompt carrying the song id + input.
- **UI**: a "Transcribe…" `createOption` in the library "+" menu (paste link / drop files); the
  pending card + player `Body` show "Transcribing" with **Open conversation**; failed shows the
  error + Retry (relaunch on the same song).
- **Agent tools** (`python/` + `deps/`: one `pythonEnv` dep with yt-dlp, av, verovio, resvg-py,
  pypdfium2, pillow, numpy) exposed as a small CLI on PATH, so the deterministic work is code and the
  agent spends tokens only on reading music:
  - `st fetch <url>` → `input/video.mp4` (+ audio)
  - `st frames <video>` → detects the sheet region, samples frames on region change, dedupes by
    perceptual hash → ordered `frames/NN.png`
  - `st pages <pdf>` → `frames/NN.png`
  - `st render <score.musicxml>` → `render/NN.png` (verovio → svg → png), and `st side-by-side <a>
    <b>` for visual comparison
- **Profile instructions** (the scratch dir's CLAUDE.md): goal, the CLI, the loop — draft MusicXML
  from the frames, render, compare bar-by-bar against the source, fix, repeat until no differences;
  conventions (both staves, `<harmony>` for chord symbols, tempo + swing as written, title from the
  video caption); then call `sonata_submit_transcription`, or `flag_raise` when it cannot.
- **`sonata_submit_transcription({songId, path})`** (MCP, `profiles: ["sonata.transcription"]`):
  resolves `path` inside the conversation's workspace dir (rejects escapes), parses with
  `parseMusicXml` (a parse error is returned to the agent to fix), stores the attachment, writes the
  musicxml extension row, `updateSongMeta` (title, duration), sets status `ready`, marks the task
  done.

Follow-ups (not in this plan): the source video as the song's recording (recording plugin is
YouTube-only: widen `meta.recording.provider` + an attachment-backed `<video>` driver); "Transcribe
to Sonata" from the file explorer's PDF/image preview; `.mxl`.

## Phases (each independently buildable/reviewable)

1. **Workspace refactor** — `WorkspaceImpl` + registry, `worktree` impl, attempts.`workspace`
   column, lifecycle/runtime call through it. No behaviour change.
2. **Scratch workspace** — scratch impl, profiles, launch fragment, MCP allowlist, required
   `requires` on conversation-view contributions, git-capability asserts, scratch reaper.
3. **MusicXML source** (+ swing in Score/playback).
4. **Library pending hydrate**.
5. **Transcription** — deps/CLI, profile, endpoint, create option, submit tool.

Phases 3–4 are independent of 1–2 and can run in parallel.

## Critical files

- `plugins/conversations/server/internal/{lifecycle,spawn-job,runtime}.ts`
- `plugins/conversations/plugins/runtime-tmux/server/internal/{tmux-runtime,launch-settings}.ts`
- `plugins/tasks/plugins/tasks-core/core/internal/fields.ts`, `.../server/internal/mutations/cross-table.ts`
- `plugins/infra/plugins/worktree/server/internal/worktree.ts` (becomes the worktree impl's internals)
- `plugins/infra/plugins/mcp/server/internal/{handle-mcp,registry}.ts`
- `plugins/conversations/plugins/conversation-view/web/slots.ts` + every contributor (mechanical `requires`)
- `plugins/apps/plugins/sonata/plugins/library/web/{slots,panes}.tsx`, `score/core/types.ts`,
  `session/` (swing), `sources/plugins/midi/*` (template)

## Verification

- Phase 1: `./singularity build`; launch, resume, fork and push an ordinary task — identical to before;
  `./singularity test plugins/conversations plugins/tasks/plugins/tasks-core`.
- Phase 2: launch a scratch conversation with a trivial test profile; confirm in its transcript that
  the first-turn context has **no** repo CLAUDE.md / plugin index (ask it to list its instructions,
  and check the usage stat's context size vs a worktree agent), `/mcp` shows only the allowlisted
  tools, the conversation pane hides git surfaces, resume works, the reaper removes the dir after the
  task is dropped.
- Phase 3: unit tests for `parseMusicXml` on fixtures (ties, repeats, two staves, harmony, swing);
  import a MuseScore export and check notation + piano roll.
- Phase 5 end-to-end: Transcribe `https://www.instagram.com/p/Dd7oBnUua5Y/` from the library, watch
  the conversation, compare the engraved result against the video frame bar by bar, play it at 110
  swung. E2E script under `transcription/e2e/` drives the create option and waits for `ready`.

## Decisions (2026-10-13)

- Scratch agents keep the user's own `~/.claude` settings and memory; the profile's permissions are
  merged on top. Only the repo's project/local context is dropped.
- Instagram downloads may use browser cookies (`yt-dlp --cookies-from-browser`).
