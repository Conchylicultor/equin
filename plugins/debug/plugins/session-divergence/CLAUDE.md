# session-divergence

Watches for a conversation whose agent is **talking in a session the UI cannot see**.

A conversation's turns are assembled from the transcripts of the Claude session ids
recorded in its chain (`conversation_sessions`, owned by `conversations/session-chain`).
The poller appends to that chain whatever `runtime-tmux`'s `resolveSessionState` says
is live for the pane. In July 2026 that resolution read `pane_pid`'s sessions file
alone, so when Claude Code relocated a live session into a daemon-hosted descendant,
the pane stayed pinned to the launcher's tombstone id: the agent ran fine and wrote
turns for **12 hours** into a transcript nothing ever read. Nobody noticed, because a
conversation that is silently missing turns looks exactly like a conversation that is
idle. See `research/2026-07-09-conversations-session-chain.md`.

The fix (subtree-wide, freshest-mtime resolution) closed the shape we saw. It cannot
close the shape we haven't. **The trigger was never reproducible on demand** — it fired
once, on 1 of 23 panes, correlating with a Claude CLI self-update — so this monitor is
the only mechanism by which we learn whether the fix holds, or whether a future,
deeper handoff shape defeats it. Silence here is the signal.

On 2026-08-18 a second shape did defeat it — and this monitor stayed silent through the
whole 10-hour outage, which is the more important half of the story. Claude Code
*parked* a pane's session as a background job: it forked the conversation to a new
session id, handed it to a `--bg-pty-host` process that launchd re-parented, and left a
stub in the pane. The live session was **outside the pane's subtree entirely**, so the
subtree walk found one id, matched it against the chain, and agreed with the resolver it
exists to audit. Both now follow the pointer that links the two — the stub's
`parkedJobId` to the host's `jobId` — and both do so independently. See the 2026-08-18
addendum in the research doc.

## The predicate — omission

A per-worktree scheduled job (`debug.session-divergence-monitor`, every 5 min) takes
ONE process-table snapshot and, for each active conversation that still owns a live
tmux pane, flags a session id `s` **reachable from** that pane when all of:

- **(a)** `s` is absent from the conversation's recorded chain — no turn of `s` can
  ever render;
- **(b)** `s` has a transcript file on disk — the agent really is talking there,
  rather than `s` being a launcher tombstone that never ran a turn;
- **(c)** `s`'s transcript mtime leads the **baseline's** transcript mtime by more
  than `graceMinutes` — the conversation has actually moved there.

`(c)` is what keeps the monitor quiet in the ordinary fork: a freshly-spawned session
writes its transcript a moment before the 1s poller appends it to the chain, so for
that instant it trivially satisfies (a) and (b). It trips only once the lead outlives
the grace window — i.e. the poller had minutes of ticks and still never recorded it.
A conversation whose chain is empty, or none of whose entries resolve to a transcript,
is skipped: there is no baseline to measure a lead against.

**The baseline is the last *anchored* entry, not `chain.at(-1)`.** A chain corrupted by
cross-talk has a foreign id as its tail — that is how the 2026-08-19 incident presented
— so `chain.at(-1)`'s transcript is an unrelated worktree's file, and its mtime is an
unrelated agent's typing speed. Measuring a lead against that measures noise: a busy
stranger hides a genuine divergence, an idle one invents a fake one.
`resolveAnchoredChain` (from `transcript-watcher`) partitions the chain into the entries
that live in this conversation's own `~/.claude/projects/<dir>/` and the ones that do
not, and the last of the former is the newest transcript the UI can actually render.

Note (a) still tests the **whole** chain, foreign entries included: an id already
recorded is not an omission, whatever else is wrong with it. That is commission's job,
below.

**Reachable** means: named by a sessions file in the pane's process subtree, or — following
`parkedJobId` → `jobId` transitively — by a file claiming a background job one of those points
at. Reachability is the half that decides what the predicate can even see, so it is the half a
new detachment shape breaks first; `reachableSessionIds` is pure and unit-tested for that reason.

### The two exclusions, and the asymmetry that keeps them safe

Proximity is not ownership. Claude Code runs ONE background daemon per machine, parented
under whichever pane happened to start it, and lends its pre-warmed spares to any
conversation — so an unrelated agent's process really does sit in this pane's subtree,
writing a transcript hours ahead of the pane's own. Two kinds of subtree link are
therefore dropped before they can count as evidence:

1. **Foreign claim** — the record's `tmux` stamp names a *different* pane that
   `listPanes` knows about. Somebody else has said, on the record, that it is theirs.
2. **Background host** — `kind: "bg"`. A background session reaches a pane only through
   that pane's own `parkedJobId` → `jobId` hop, an explicit pointer rather than an
   accident of process parentage.

Without these the monitor would fire on the daemon-hosting pane every 5 minutes forever
the moment the resolver (correctly) stopped adopting the lent spare's id: absent from
the chain ✓, has a transcript ✓, leads the tail ✓. An alarm that always fires is an
alarm that is off — which is why this had to land with the resolver fix, not after it.

**These are not the resolver's inclusion rule, and must never become it.** The resolver
admits a record only when it claims the pane (by stamp, or by being unstamped, non-`bg`
and local to the pane's worktree). This detector excludes only what *somebody else* has
claimed. Everything merely **unclaimed** — unstamped, wrong `cwd`, a stamp naming a pane
that no longer exists — stays evidence here even though the resolver refuses it. That
gap **is** the monitor: the shapes the resolver deliberately declines to guess at are
the shapes that froze a transcript for 747 minutes in July 2026 and for 10h25m on
2026-08-18.

## The other predicate — commission

The predicate above is one-directional by construction: its first test is
`if (recorded.has(sessionId)) continue`, so an id the resolver wrongly **adopted** is
skipped *because* it was adopted. Cross-talk corruption is self-concealing to it, which
is why the 2026-08-19 incident was found by a human reading a transcript. Two detectors
in `detect-commission.ts` close that direction:

- **directory-mismatch** — a chain entry whose transcript resolves outside its own
  conversation's anchor directory. Scoped to active conversations (resolving every id
  of every conversation that ever existed is an unbounded glob on a 5-minute job).
- **shared-session-id** — one `claude_session_id` recorded on two or more conversations
  (`listSharedClaudeSessionIds`, owned by `session-chain`). Pure SQL: no process tree,
  no filesystem, no assumption about how Claude encodes a cwd into a directory name. It
  therefore answers for a **hibernated** conversation whose pane died days ago and whose
  transcripts have been swept, and it would have caught the 2026-08-19 incident the
  minute it happened. It reports the fact to *every* holder of the id — it cannot see
  which one is the impostor, and guessing is not its job.

Both file `conversation-foreign-session`, the kind owned by `transcript-watcher` (the
read path files it too when it refuses to merge a foreign transcript): same condition,
same answer — go delete that `conversation_sessions` row — two discovery routes, one
deduped task per corrupt row.

They are kept **out of** `detectDivergences` on purpose. The two predicates do not take
the same inputs (one needs the live process tree and pane list; the other works with no
pane at all) and do not cover the same conversations, so merging them would mean either
running the process walk for rows that do not need it, or wrapping the carefully
specified (a)/(b)/(c) contract in branches until it no longer has one answer.

## Why it does not reuse `resolveSessionState`

The monitor shares `captureProcessTree` / `subtreePids` with `runtime-tmux` (exported
from its barrel for exactly this) so subtree membership can never differ from the
resolution it audits. But it reads the `~/.claude/sessions/<pid>.json` files itself
rather than calling `resolveSessionState`, because **that resolver is what is on
trial**: if it picks the wrong id, a detector built on it agrees with it and stays
silent. The process walk is shared; the session evidence is independent.

The parked-job hop is duplicated here for the same reason, deliberately: sharing the
resolver's implementation of it would mean one bug blinds both. What is shared is the
*shape of the world* (the process tree); what is duplicated is every judgement about it.

## Layout

- `core/config.ts` — `enabled` + `graceMinutes` (runtime-editable in Settings → Config).
- `core/kinds.ts` — the report payload: the conversation, both session ids, both mtimes.
- `server/internal/detect.ts` — the omission predicate, with its filesystem/DB reads
  behind an injectable `DetectDeps` so it is unit-testable (`detect.test.ts`); plus the
  pure `reachableSessionIds` (subtree ids, claim exclusions, parked-job hops) its IO
  shell wraps.
- `server/internal/detect-commission.ts` — the two commission detectors, behind their own
  `CommissionDeps` (`detect-commission.test.ts`). They return
  `ForeignSessionPayload` directly, so a detector cannot report a shape it did not
  observe.
- `server/internal/monitor-job.ts` — the scheduled job: read config, run all three
  predicates, file a report each. `perWorktree: true` because the chain rows it audits
  live in each worktree's own DB fork (same reason `queue-health` samples its own queue).
- `server/internal/divergence-kind.ts` — the omission report kind, deduped one row per
  conversation, `warning` variant with a 6h notification re-arm. The commission kind
  (`conversation-foreign-session`) lives in `transcript-watcher`, which also files it
  from the read path.
- `web/` — the one-line Debug → Reports summary and the config registration.

> The config `name` `session-divergence`, the job name
> `debug.session-divergence-monitor`, and the report kind
> `conversation-session-divergence` are load-bearing explicit literals — persisted
> config and report dedup depend on them; do not rename. `SessionDivergencePayload`
> stays scoped to the omission case: the commission arms have their own union
> (`ForeignSessionPayloadSchema`), and forcing one schema to carry both would make each
> arm fabricate the other's fields.

## Testing

```bash
bun test plugins/debug/plugins/session-divergence
```

To exercise it end-to-end, force a synthetic divergence by inserting an older tail into
`conversation_sessions` for a live conversation, wait one cron tick, and confirm exactly
one `conversation-session-divergence` report — and zero rows for the healthy panes.

For commission, insert a live conversation's `claude_session_id` into a second
conversation's chain and confirm one `conversation-foreign-session` row per holder. A
standing row for a pane nobody corrupted means an exclusion above has stopped working.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Session-divergence report renderer: a one-line Debug → Reports summary for the conversation-session-divergence kind, plus the enabled/grace config registration. Session-divergence monitor: a per-worktree scheduled job that takes one process-table snapshot (sharing runtime-tmux's own captureProcessTree), reads every Claude session id reachable from each live conversation pane — its process subtree plus the parked-background-job pointers out of it — and files one deduped conversation-session-divergence report per conversation whose live session is absent from the recorded session chain while its transcript leads the chain tail's by more than the grace window — i.e. the agent is talking where the UI cannot see.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "session-divergence"
    - `Reports.KindView` → `SessionDivergenceSummary`
  - Uses:
    - `config_v2.ConfigV2`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `reports.Reports`
- Server:
  - Contributes:
    - `ConfigV2.Register` "session-divergence"
    - `report-kind` "conversation-session-divergence"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `conversations/runtime-tmux.captureProcessTree`
    - `conversations/runtime-tmux.listPanes`
    - `conversations/runtime-tmux.ProcessTree`
    - `conversations/runtime-tmux.subtreePids`
    - `conversations/session-chain.listSessionChain`
    - `conversations/session-chain.listSharedClaudeSessionIds`
    - `conversations/session-chain.SharedSessionId`
    - `conversations/transcript-watcher.AnchoredChain`
    - `conversations/transcript-watcher.findTranscriptPath`
    - `conversations/transcript-watcher.resolveAnchoredChain`
    - `infra/jobs.defineJob`
    - `infra/paths.CLAUDE_SESSIONS_DIR`
    - `reports.recordReport`
    - `reports.ReportKind`
    - `tasks/tasks-core.listActiveConversations`
  - Register: `defineJob('debug.session-divergence-monitor')`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/bool/config.boolField`
    - `fields/int/config.intField`
  - Exports (types): `SessionDivergencePayload`
  - Exports (values):
    - `sessionDivergenceConfig`
    - `SessionDivergencePayloadSchema`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/detect.ts` (debt)

<!-- AUTOGENERATED:END -->
