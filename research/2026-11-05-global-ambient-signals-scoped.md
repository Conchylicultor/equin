# Ambient surface signals carry their scope

Task: the page's Wish popover reads the demo's task over the page's socket (supervisor
conv-1793665695-3p52r4). Track: wiki block-d04c6c0d-56fd-49f2-88f4-914e059cc83b. Background:
research/2026-11-04-global-no-route-string-in-scoped-code.md,
research/2026-11-04-global-web-storage-scoped-by-composition.md.

## Context

On `/demo`, `no-leak.ts` and `app-switch.ts` fail "the page's live-state socket subscribed to no
demo data": the page's socket sends `{"op":"sub","key":"tasks:rows","params":{"ids":"task-demo-dark-mode"}}`.

Path: the demo's conversation pane (inside `<DemoScope>` → `<PluginScope>` → `<AppEmbed>`) runs
`ActiveRelateSync`, which publishes `{ taskId }` into `task-draft-form/web/active-relate-context.ts`,
a module Map keyed by surface id. The page's Wish popover (page chrome, outside every scope) reads
the FOCUSED surface's entry (`getFocusedSurfaceId()` + `subscribeFocusedSurface`). The focused
surface is page-global (keyboard dispatch needs it), so once the user is in the embed it is the
embed's tab, and the page reads the demo's task id and resolves it with `useTaskCluster` through the
page's transport. b038c8c488 made it visible (a by-id read instead of the whole `taskRows` set), but
it was already wrong before: submitting the Wish would have related a real task to a demo id on the
real server.

The class: a value published from inside a scope, keyed by an ambient "where the user is" fact,
read by page chrome that resolves it through its own transport.

## Design

**An ambient surface signal is published and read with the scope of where the code renders, and
neither side can name a scope.** New primitive next to the focused surface it is keyed by
(`primitives/shortcuts/web`, which owns `focusedSurfaceId`):

```ts
const relateSignal = defineSurfaceSignal<string>("tasks.relate-task");
useSurfaceSignal(relateSignal, conversation?.taskId ?? null); // publisher: in a surface
useFocusedSurfaceSignal(relateSignal);                         // reader: page chrome → string | null
```

- The publisher's key is `(useSurfaceTabId(), usePluginScopeId())`, from context. An owner token
  per publisher keeps today's rule (a background pane closing clears only its own entry).
- The reader answers the focused surface's entry only when it was published from the reader's own
  scope (`usePluginScopeId()` of the reader). Page chrome while the user is in the demo reads
  `null`; a reader inside the demo (were Wish ever mounted there) would read the demo's value
  through the demo's transport.
- The old spellings go away: `setActiveRelateContext` / the module Map are deleted, and the
  shortcuts barrel stops exporting `subscribeFocusedSurface` and `useFocusedSurfaceId` (their only
  reactive consumer was the relate context). The focused surface stays readable out of React with
  `getFocusedSurfaceId()` for keyboard dispatch and window commands (tab ids, no data). So a React
  surface reading "what the focused surface says" has one spelling, and it is scope-checked
  (rung 1: no unscoped spelling exists).

**Wish while the user is in the demo relates to nothing**: no ambient related task, the popover
files an unrelated top-level task on the real app, as from any page with no conversation focused.
The demo's task does not exist on the real server, so there is nothing true to relate to.

## Inventory of ambient signals that cross a scope

Every page-global store a scoped subtree can write and page chrome reads (the
`scoped-store/no-module-mutable-store` exemptions, install sinks, module maps):

| Signal | Crosses? | Outcome |
| --- | --- | --- |
| Relate context (`task-draft-form`), keyed by focused surface | yes: demo task id read and related to through the page's transport | **closed**: a surface signal (above) |
| Hint moments (`hints` engine store → the page's `HintHost`) | yes: a moment in the demo shows the page's tip, and `markSeen` writes the page user's hint-seen row on the real server | **closed**: `useHintMoment` inside a `PluginScope` asks nothing (the one host is the page's) |
| Focused surface id | yes, by design (keyboard dispatch) | tab ids only; no reactive read left except through a surface signal |
| Focused app, focused tab title, navigator, live store, route prefix | no: published only by the page's tab set (`if (page)`) | — |
| Active tab set, dynamic shortcuts, hint anchors | yes | tab-set / tab ids, DOM elements: no data, no transport |
| App usage | no: reads the page's focused app | — |
| Wish URL, element picker, screenshot, Ask equin outline | page chrome reading the page DOM / `window.location` (the /demo URL) | user-initiated text and pixels, no id resolved through a transport |
| Toasts raised inside a scope | the body (a `NotificationView`, its `Notifications.Action` hooks) renders in the page's Toaster, under the page's transport, registry and tabs | **not closed here**: an imperative render hand-off, not an ambient signal; needs a context bridge — follow-up task |

## Verification

- Unit test of the primitive (vitest, web/__tests__): a publisher in a `PluginScope` is invisible to
  a page reader focused on its surface, visible to a reader in the same scope; owner-scoped clear.
- `./equin build`; demo e2e: no-leak, app-switch (fully green), desktop-in-demo, prototypes-in-demo,
  sonata-in-demo, persistence.
- Real app: open a conversation, open Wish — relates to the conversation's task (browser_*).
