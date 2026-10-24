# Pane `appPath` → `appIndex`: the intent is a boolean, not a restated path

## Context

`Pane.define({ appPath })` marks a pane as its app's index/landing pane by naming
the app's base path as a string (`"/pages"`, `"/mail"`, …). Now that `app` is
mandatory on every pane, that string is a **second copy of a fact the pane
already carries**: `app.basePath`.

Two sources for one fact means they can disagree, and nothing rejects the
disagreement:

```ts
Pane.define({ id: "x", app: mailApp, segment: "", appPath: "/pages" });  // compiles
```

That pane resolves as nobody's index. Bare `/mail` shows an empty main area,
bare `/pages` still resolves to the real Pages index (first match wins), and
there is no error anywhere. The intent — *"I am my app's landing pane"* — is a
boolean, but it is spelled as a path that has to be typed correctly.

Three further invariants are equally unenforced today:

- an index pane must be a **root-segment** pane (`useIndexMatch` silently skips
  one with a real segment);
- an app may have **at most one** index pane (`useIndexMatch` silently takes the
  first);
- the empty `segment: ""` / `segment: "/"` on every index pane is itself a
  restatement of "I have no URL of my own", which `appIndex` already says.

## The change

`appPath?: string` becomes **`appIndex?: boolean`**, and the match is made
against the pane's own `app.basePath`. Declaring the wrong app's index becomes
unrepresentable: there is no path to mistype, and the only path in play is the
one the pane's `AppRef` already owns.

```ts
export const mailRootPane = Pane.define({
  id: "mail-root",
  app: mailApp,
  appIndex: true,          // ← was: segment: "", appPath: MAIL_APP_PATH
  component: MailRoot,
});
```

`segment` is dropped from every index pane: it defaults to `""`, and an index
pane having no URL segment is now an enforced invariant rather than an authored
convention.

### Naming

`appIndex`, not `index` — `index` is unusably generic to grep for in a repo
where every barrel is `index.ts`. It joins the existing boolean vocabulary on
`Pane.define` (`titleOwner`, `keepMountedWhenCollapsed`), which uses no `is`
prefix.

### The invariants become loud

`useSyncPaneRegistry` already throws on a segment collision; the two new checks
sit beside it, in the same loop, with the same shape of message:

- **`appIndex` + a non-empty segment** → throw. An index pane is reached at its
  app's bare root, so it can have no URL segment of its own.
- **two `appIndex` panes for the same `app.id`** → throw, naming both pane ids
  and the app.

Registry sync is the only place that sees the whole registered set, and it is
where the existing global-uniqueness invariant lives, so both belong there
rather than in `useIndexMatch` (which would have to defend on every render and
could only silently skip).

`useIndexMatch` then reduces to its actual question:

```ts
for (const pane of registry.values()) {
  if (!pane.appIndex) continue;
  if (normalizeAppPath(pane.app.basePath) !== bp) continue;
  …
}
```

## Files

**The primitive** — `plugins/primitives/plugins/pane/web/pane.ts`

- `PaneInternal.appPath?: string` → `appIndex: boolean` (normalized to
  always-present at define time, like `titleOwner`). Rewrite the doc comment.
- `DefineArgs.appPath` and `RouteDefineArgs.appPath` → `appIndex?: boolean`.
- `define()`: `appIndex: args.appIndex ?? false`.
- `useSyncPaneRegistry()`: the two throws above (a `Map<appId, paneId>` beside
  the existing `patternOwner` map).
- `useIndexMatch()`: match on `appIndex` + `app.basePath`.
- Refresh the stale `appPath` mentions in comments (lines ~2033, ~2138).

**The 11 index panes** — mechanical, one shape:
`segment: "" | "/"` + `appPath: <path>` → `appIndex: true`, and reword the
adjacent comment. Representative paths:

- `plugins/apps/plugins/mail/plugins/shell/web/panes.tsx`
- `plugins/apps/plugins/pages/plugins/welcome/web/panes.tsx`
- `plugins/apps/plugins/agent-manager/plugins/welcome/web/panes.tsx`
  (the one with `segment: "/"`)
- …plus deploy/servers, events/shell, prototypes/gallery, settings/config,
  sonata/library, story/shell, website/shell, workflows/definitions.

All 11 already agree with their `app.basePath`, so this migration changes no
behavior.

**The `*_APP_PATH` aliases** — the same duplication one level up. Each is
`export const X_APP_PATH = <app>.basePath` documented as *"the app's base URL
path **and its index pane's `appPath`**"*; with `appPath` gone, two of the three
have no remaining reader:

- `events/shell/web/slots.ts` + barrel — delete `EVENTS_APP_PATH`.
- `settings/shell/web/slots.ts` + barrel — delete `SETTINGS_APP_PATH`
  (its one consumer is `settings/config/web/panes.tsx`).
- `mail/shell/web/slots.ts` + barrel — delete `MAIL_APP_PATH`; its one
  remaining consumer, `mail-root.tsx`'s
  `navigate(\`${MAIL_APP_PATH}/threads\`)`, reads `mailApp.basePath` from the
  shell's `core` barrel instead.

**Docs**

- `plugins/primitives/plugins/pane/CLAUDE.md` — a short **"The app's index
  pane"** subsection under *A pane's home app*: what `appIndex` means, the two
  invariants, and that an index pane declares no `segment`.
- `plugins/apps/plugins/events/plugins/shell/CLAUDE.md` — one stale sentence.

**Tests**

- `pane/web/__tests__/deep-link-load-gap.test.tsx` and
  `deep-link-settle-then-register.test.tsx` — the two fixture panes.
- New `pane/web/__tests__/app-index.test.tsx`: the index resolves from
  `app.basePath` with nothing else authored; a second `appIndex` pane for the
  same app throws at registry sync; an `appIndex` pane with a real segment
  throws.

`research/` docs that mention `appPath` are historical records of how the design
got here and are left as written.

## Verification

1. `./equin build` (background) — type-check + checks + deploy.
2. `./equin test plugins/primitives/plugins/pane`.
3. Drive the deployed app: every app's **bare root** must still land on its
   index pane rather than an empty main area —
   `http://<worktree>.localhost:9000/mail`, `/pages`, `/agents`, `/settings`,
   `/events`, `/workflows`, `/sonata`, `/story`, `/website`, `/deploy`,
   `/prototypes`. A screenshot of two of them (`/mail`, `/pages`) via
   `e2e-harness/e2e/screenshot.ts` is the cheap end-to-end proof.

## Why matching on `app.basePath` is genuinely single-source

`useIndexMatch` compares the surface's `basePath` — which arrives via
`Apps.App.path` → `appPathFor()` → `PaneSurfaceProvider` — against the pane's
`app.basePath`. Those two are provably the same value: the
`apps-paths-from-app-ref` check
(`framework/tooling/checks/plugins/apps-paths-from-app-ref`) already rejects any
`Apps.App({...})` whose `id`/`path` is not literally written as
`<appRef>.id` / `<appRef>.basePath`. So after this change the whole chain from
`defineApp` to index resolution has exactly one authored path per app.
