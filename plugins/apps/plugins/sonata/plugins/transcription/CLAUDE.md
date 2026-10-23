# transcription

Sonata transcription (design: `research/2026-10-13-global-agent-workspaces-and-sonata-transcription.md`
§4): an agent you can watch turns sheet music in a video, photos or a PDF into a MusicXML song.

## The flow

1. **Transcribe…** (library "+" menu, `web/components/transcribe-dialog.tsx`): the standard
   `LaunchAgentForm` — free text (a link, instructions, page photos / PDFs pasted or dropped inline as
   attachment refs) plus the usual launch-option pills. The transcription decides where its agent runs, so
   the dialog declares `ownedOptions={[workspaceLaunchOption]}` (no Workspace pill, never sent), and
   `textRequired`.
2. Its `getRequest` calls `POST /api/sonata/transcription/prepare` (`server/internal/routes.ts`): the
   song (`musicxml` source, placeholder title), its `sonata_songs_ext_transcription` row (`status`,
   `input` = `{kind:"prompt", prompt, attachmentIds}`, `taskId`, `conversationId`, `error`), a task in
   the **Sonata** category whose workspace (`setTaskWorkspace`) is
   `{ kind: "scratch", profile: "sonata.transcription", input: { songId, source } }`. The form then
   launches that task through the standard `POST /api/tasks/launch` with the user's options, so a task
   filed with Run Off still launches into the transcription workspace later.
   `conversation-status.ts` records each new conversation of the task on the song.
3. The profile (`profile.ts`) writes the agent's CLAUDE.md (`instructions.ts` — THE product: the
   render → side-by-side → fix loop and the MusicXML conventions), waits for `transcriptionDep`
   (`dep-ready.ts`: `requestDep` + `onDepInstallSettled`, since the spawn job has no `ExecContext`),
   writes `./bin/st` (the checkout's `bin/st` with `ST_PYTHON` set) and copies uploads to
   `input/NN-<name>`. The agent sees only `sonata_submit_transcription` and `flag_raise` — no
   `exit_clean`: it ends its turn, so the conversation stays open for the user's corrections.
4. `sonata_submit_transcription({ path })` (`mcp-tool.ts` / `submit.ts`): the song comes from the
   conversation's workspace spec, never from the agent; `path` must resolve inside the workspace
   (symlinks included, `workspace-file.ts`); `importMusicXmlForSong` — a `MusicXmlParseError` goes
   back to the agent as the tool's error — then status `ready` and `recordScratchDelivery` (tasks-core's
   `attempt_deliveries` fact). The agent writes a two-line summary and ends its turn. The tool's
   schema is `transcriptionScore` (`core/result.ts`, a `defineThreadResult`), so the thread parses
   exactly what the tool accepted.
5. **The thread** (`web/components/transcription-thread.tsx`, an `<AgentThread>` from
   `conversations/agent-thread`): the player's pending body while transcribing / failed, and the
   player's **Transcription** section (`Sonata.Section`, editor area) once the score is in. A reply
   ("bar 12 is wrong") resumes the same conversation; the agent fixes, resubmits, and the score is
   replaced in place (`markReady` again stamps the song, which re-hydrates the player).
6. A conversation closed (`done`) while still transcribing marks the song `failed`
   (`conversation-status.ts`, on `conversation.statusChanged`); an agent that merely ended its turn
   without a score is not a failure — the thread shows it and the user replies. A failed song's
   conversation working again (a reply from the thread resumes even a closed one) marks it
   transcribing. **Retry** (the thread header, or the bare state line when no conversation ever
   started) relaunches on the same task and song (`launchTranscription`, the stored input's prompt
   and the default model). `url` / `files` inputs are the earlier dialog's rows, still decoded and
   retried.

Every status write stamps the song row (`updateSongMeta`), which is what re-hydrates an open player.
The extension EXPOSES the run state (`status`, `conversationId`, `error`) on the songs entity
(`shared/shape.ts`, served by `LiveColumns.Expose`), so every list of songs carries it: the card badge
(the status options, `web/internal/presentation.tsx`) and the player's pending body (`Library.Source` `hydrate` →
`pending` with `TranscriptionBody`, which reads the song row live) — the thread, or the error and Retry.

The task derives `done` from the delivery fact alone: tasks-core completes a delivered attempt as
soon as no agent is working on it, so the task reads done once the agent ends its turn, in progress
while a correction runs, and done again after — the conversation itself stays open.

## The `st` toolkit

- **Dep**: `transcriptionDep` (id `sonata-transcription`, `deps/`), a `pythonEnv` over `python/`.
  `bin/st` runs with `ST_PYTHON=<ready.dir>/bin/python`; the profile writes the agent a `./bin/st`
  wrapper setting it. The source runs from the checkout (PYTHONPATH), the env is shared.
- **Contract**: each subcommand is deterministic, prints a short summary of what it wrote, and on an
  expected failure exits 1 with one `st: <reason>` line on stderr (no traceback).

| command | does |
|---|---|
| `st fetch <url> --out <dir> [--cookies-from-browser <b>]` | `<dir>/video.mp4` + `meta.json` (title, caption, uploader, duration) via yt-dlp |
| `st frames <video> --out <dir> [--region x,y,w,h] [--threshold N]` | finds the sheet band (stable, bright, high-contrast rows), keeps a crop whenever it changes: `NN.png`, `thumbnail.png`, `frames.json` |
| `st pages <pdf> --out <dir> [--scale 2]` | `NN.png` per PDF page |
| `st render <score.musicxml> --out <dir>` | verovio → SVG → `NN.png` per page |
| `st side-by-side <a.png> <b.png> --out <c.png>` | `a` stacked over `b` |

Manual check: `scripts/smoke.sh` (needs the dep installed).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Sonata transcription in the library: a 'Transcribe…' entry in the + menu (a video/post link, or page images and PDFs) that creates the song and starts the transcribing agent; a transcribed song shows its agent run as an embedded agent thread — the steps, the agent's summary and a reply box — in the player until the score is in (Retry when it failed), then in the player's Transcription section, where a reply asks for a correction and the resubmitted score replaces the song's; and a Transcribing / Failed badge and cover on its card. Owns the sonata_songs_ext_transcription side-table: a transcribed song's run state (status, input, task, latest conversation, error). POST transcribe creates the song (MusicXML source), a Sonata task and a transcribing agent in a `sonata.transcription` scratch workspace (CLAUDE.md = the instructions, ./bin/st = the toolkit); its sonata_submit_transcription MCP tool imports the agent's MusicXML into the song. Exposes its status, latest conversation and error to every list of songs (LiveColumns.Expose); a conversation closed before submitting marks the song failed (retry relaunches).
- Web:
  - Contributes:
    - `Library.Source` "transcription"
    - `Library.Cover` "transcription"
    - `FieldPresentation.Register` "exposure:sonata_songs_ext_transcription"
    - `Sonata.Section` "Transcription" → `TranscriptionSection`
  - Uses:
    - `apps/sonata/library.Library`
    - `apps/sonata/library.openSongImperative`
    - `apps/sonata/library.useCurrentSong`
    - `apps/sonata/shell.Sonata`
    - `conversations/agent-thread.AgentThread`
    - `infra/endpoints.useFetchEndpoint`
    - `network/live.FieldPresentation`
    - `network/live.useLiveRow`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/css/ui-kit.DialogTitle`
    - `primitives/launch.LaunchAgentForm`
    - `primitives/loading.Loading`
    - `primitives/overlay/imperative-dialog.openDialog`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `live.columns.expose` "sonata_songs ← sonata_songs_ext_transcription"
    - `taskCategory` "sonata"
    - `trigger` "sonata.transcription.conversation-status"
  - Uses: 30 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/sonata/library` ×4
    - `apps/sonata/sources/musicxml` ×3
    - `conversations/workspace` ×3
    - `tasks/tasks-core` ×3
    - `infra/deps` ×2
    - `infra/endpoints` ×2
    - `tasks/task-category` ×2
    - `conversations/model-provider/catalog.getModelCatalog`
    - `conversations/workspace/launch-option.setTaskWorkspace`
    - `conversations.createConversation`
    - `database.db`
    - `infra/attachments.getAttachment`
    - `infra/claude-cli/availability.assertClaudeCodeReady`
    - `infra/entity-extensions.defineExtension`
    - `infra/events.Trigger`
    - `infra/jobs.defineJob`
    - `infra/mcp.Mcp`
    - `network/live.LiveColumns`
  - DB schema: `plugins/apps/plugins/sonata/plugins/transcription/server/internal/tables.ts`
  - Entity extension of: `apps/sonata/library` (table `sonata_songs_ext_transcription`)
  - Register:
    - `defineJob('sonata.transcription.conversation-status')`
    - `mcpTool('sonata_submit_transcription')`
  - Routes:
    - `POST /api/sonata/transcription/prepare`
    - `POST /api/sonata/songs/:id/transcription/retry`
    - `GET /api/sonata/songs/:id/transcription`
- Core:
  - Uses: `conversations/agent-thread.defineThreadResult`
  - Exports (types):
    - `SubmitTranscription`
    - `TranscriptionStatus`
  - Exports (values):
    - `SUBMIT_TOOL`
    - `SubmitTranscriptionSchema`
    - `TRANSCRIPTION_STATUSES`
    - `transcriptionScore`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps/python.pythonEnv`
  - Exports (values): `transcriptionDep`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/shape --spacing`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/launch.ts`, `server/internal/profile-input.ts`, `server/internal/profile.ts`, `server/internal/submit.ts`, `server/internal/workspace-file.ts` (debt)

<!-- AUTOGENERATED:END -->
