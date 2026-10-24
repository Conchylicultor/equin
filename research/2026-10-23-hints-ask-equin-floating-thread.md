# Ask equin — a floating threaded conversation on any page

## Context

The ? help menu's **Ask equin how to…** entry
(`plugins/hints/plugins/help-menu/web/components/entries.tsx`, `AskEquinEntry`)
opens a `LaunchAgentForm` dialog: the question is filed as a Help task, and the
answer lands in the Agent Manager queue. So the user has to leave the page
they were asking about, find the conversation, and come back. That is the
wrong shape for a how-to question.

Wanted: the entry opens a **floating panel holding a threaded conversation**,
on whichever page the user is on, which stays with them as they move between
apps. They ask, watch it work, read the answer, and reply in the same thread.

The task asks for a **prototype first**, reviewed with the user before any
implementation. This plan covers the prototype in detail. It sketches the
implementation only to show that it can be built from what already exists.

## What already exists (and the implementation will reuse)

- **`conversations/agent-thread`**: the embedded conversation view, built for
  this case. `<AgentThread conversationId>` (user bubbles, a live step list,
  the answer, a composer that resumes an ended conversation, Stop),
  `EndThreadButton` (Done), `useStartThread({ profile, categoryId, model })`
  (files a task and launches it under a scratch profile, answering the
  conversation id), `useThreadProgress` (for a minimized pill), and
  `useThreadRuns(profile)` (recent runs, for history and restore after a
  reload).
- **Places' Ask Sonnet** (`apps/places/plugins/places-map`: `ask-thread.tsx`,
  `ask-pill.tsx`, `ask-history.tsx`, `use-ask.ts`; profile in
  `apps/places/plugins/ask/server/internal/profile.ts`) is a working
  precedent: a docked thread card, a progress pill that hides and shows it, a
  recent-questions list, and restore-on-load.
- **Scratch profiles** (`conversations/workspace`, `defineScratchProfile`): the
  agent's CLAUDE.md, its MCP tools and its permissions. They are cheap to
  start, with no checkout or DB fork.
- **`Core.Root`** mounts a component once, above every tab (the hints engine's
  `HintHost` does this). That is how a panel survives navigation between apps.
- `HELP_CATEGORY_ID` (`help-menu/core`) stays the category for the run's task.

## Phase A: the prototype (this task's deliverable)

`./equin prototype new "Ask equin"` mints the id. It is designed from
the blank template, following `prototypes/CLAUDE.md`. Metadata:
`<meta name="mocks" content="app:/">` (it lives over the whole app with its
chrome) and a description.

**The page.** It shows a neutral app screen, with a few apps on a rail so the
user can switch between them, and the global action bar with ?. The ? menu
lists the four entries (Replay the tour, Show tips again, Read the guide, Ask
equin how to…) and matches the onboarding mockup's look: near-black panels,
white pill primaries, one teal signal (`proto-1792668692-5ijcs8`).

**The flow.** It is scripted with timers, a fake agent:

1. **Ask.** "Ask equin how to…" opens the panel, with the composer focused and
   a chip for the current page ("On: Pages › Roadmap") that can be removed.
   With nothing asked yet, it shows 2–3 suggested questions for that page.
2. **Working.** The user's bubble appears, then a quiet live line ("Looking at
   pages/… · step 3"). Finished steps fold into "Looked at 4 files".
3. **Answer.** The answer is markdown with numbered steps. A **Show me**
   button on a step spotlights the real control on the page (the hints
   engine's spot). This is an idea to discuss: it turns an answer into a
   one-off tour.
4. **Follow-up.** The composer stays under the thread. A reply continues the
   same conversation.
5. **Minimize and navigate.** Minimizing collapses the panel to a pill
   showing progress, or an unseen dot. Switching apps on the rail keeps the
   pill and the thread. Clicking the pill reopens the panel where it was.
6. **Header.** The title is the question. It has New question, Recent
   questions (a short list), Open in Agent Manager (the escape hatch: the full
   transcript), Minimize, and Done (closes the conversation and drops its
   task).

**Options.** These are declared variants, never an in-page switcher:

- `placement: anchored | side | corner`. `anchored` is a popover hanging from
  ?, `side` is a full-height sheet on the right, `corner` is a chat bubble at
  the bottom right.
- `minimized: pill | badge`. `pill` is a floating pill with the step it is on;
  `badge` is a dot on ? itself.
- `context: chip | off`. This sets whether the current page is attached to the
  question.
- `scene: ask | working | answered | minimized`. This is the starting state,
  so each state can be screenshotted and compared.
- `accent: color` (teal default).

The layout is fluid, with no fixed widths, and it renders from `file://`.

**Verification.**
- Open it in the gallery at `http://singularity.localhost:9000` and click
  through the whole flow on each `placement`.
- Screenshot every `scene` × `placement` with
  `e2e-harness/e2e/screenshot.ts --path /api/prototypes/<id>/index.html?scene=…&placement=…`
  (passing these as query params, never changing the user's picks). Then
  check the screenshots at a narrow and a wide viewport.
- Hand the id to the user for review.

## Decisions (user, 2026-10-23)

- **Look**: cross-app — must sit well over every app, not the onboarding theme.
  Prototype compares `skin: chrome | app | glass` over three differently
  themed apps.
- **Placement**: a draggable card, default bottom-right. Drag is free; it
  snaps only when dropped within ~36px of a corner.
- **Minimal chrome**: no "Asking about <page>" line, no per-question page
  label, no model/workspace footer — the page context is attached silently;
  the workspace state is a dot on the header mark (tooltip).
- **One thread.** "Open in Agent Manager" for the full conversation; "New
  question" replaces it (the old one stays in the Agent Manager).
- **Workspace: read-only, no worktree** (revised). The agent runs in a scratch
  workspace that can read the checkout but never write. When something needs
  doing it **files a task** (`add_task`) that **auto-launches**; the answer
  shows the filed task live (Starting… → Working, opens in the Agent Manager).
- **Suggestions: a preset pool by category**, three shown per open:
  - always **one about the current page** (`page`: what can I do here, how
    do I change how this app looks, what shortcuts work here) — answered from
    the attached page context;
  - plus **two from two other categories**, random (`start`, `build`,
    `agents`, `find`, `data`, `news`), re-picked on every open / New question;
  - the **first few opens** lead with the newcomer pair: "What can I do on
    this page?" + "What's a good first thing to try?", then one random.
  The pool is plain data (a closed list). Per-app questions can come later.
- **Page context**: attached automatically (each question records its page).
- **Show me**: in the mockup (spotlight + caption, Next through targeted
  steps; switches app when the step lives elsewhere) — to see what it looks like.
- **Model**: Opus.
- **No "file a task" button**: agents already offer next steps as `<go>`
  choices; the card renders them (tinted, ▶ sends as a reply).

Prototype: `proto-1792772741-le95f8`.

## Phase B: to discuss at review (decides Phase C)

1. **Placement.** Which of anchored, side or corner? Should the panel be
   draggable?
2. **One thread or several?** One live thread at a time, with history to
   reopen older ones (Places' model), or several at once?
3. **What the agent can read.**
   - (a) A scratch profile with read-only access to the main checkout:
     Read/Grep/Glob allowed, Write/Edit/Bash denied. It is fast and cheap to
     start, and it cannot change code. **Chosen**, plus `add_task` with
     auto-start for anything that needs doing.
   - (b) A full worktree, as today. It can go on to fix things itself, but
     startup is slow (checkout plus DB fork).
4. **Page context.** Attach the current route and app automatically, or only
   when the user keeps the chip?
5. **"Show me".** Build it now (the answer would need a tool that names an
   anchor), or leave it for later?
6. **Model.** Sonnet (fast) or the user's default?
7. **Escalation.** When the answer is "equin can't do this yet", should there
   be a one-click "File it as a task" in the thread?

## Phase C: implementation sketch (after review; not started now)

- **Server.** A new sub-plugin, `plugins/hints/plugins/help-menu/plugins/ask`
  (or `hints/plugins/ask`, a sibling of the menu). It registers a `help.ask`
  scratch profile: instructions written from the existing `askHowToPrompt`
  brief and the page context input, tools `flag_raise` and no `exit_clean`,
  and permissions per decision B3.
- **Web.** A `Core.Root` host (`AskEquinHost`) owns a small module store
  (open, minimized, conversation id) and the floating panel. The panel is a
  surface from `primitives/overlay` (`floating-surface` or `popover`, to be
  confirmed at implementation) holding `<AgentThread>` and
  `EndThreadButton`. It starts runs with
  `useStartThread({ profile: "help.ask", categoryId: HELP_CATEGORY_ID, … })`,
  restores the newest unseen run once per load with `useThreadRuns`, and
  draws the minimized pill from `useThreadProgress`.
- **The entry.** `AskEquinEntry` opens the host instead of `openAskDialog`.
  The `LaunchAgentForm` dialog path is deleted.
- If B3 is (a), the scratch workspace's "no repo" assumption needs a sanctioned
  read-only path to the checkout. That would be a profile capability in
  `conversations/workspace`, not a one-off.
- **Verification.** `./equin build`, then in the agent's own build ask
  a question from two different apps, navigate mid-run, minimize, reply, and
  press Done. Check that the task shows under Help in the Agent Manager.
