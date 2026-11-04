# An embedded app's keyboard shortcuts

Task: task-1793823660-fyv0q1 — "Space does not play/pause a song in Sonata inside the demo".

## Finding

Not a Sonata bug: **every surface-scoped shortcut of every app was dead inside an `AppEmbed`**.

- Every app shortcut is surface-scoped (`useSurfaceShortcuts` / `usePlayPauseShortcut`):
  eligible only while `shortcut.surfaceId === getFocusedSurfaceId()`. The only static
  (`defineShortcut`) shortcuts are host chrome — solo Esc, hints, the desktop's window keys.
- The focused surface was set only by the page's tab model (its focused tab id), while
  `AppEmbed` mounted its app under a surface id of its own (`embed:<useId>`), never the
  focused one. The key reached the one window listener, matched, and was skipped as
  "another surface". The same held for raw listeners gated on focus (Sonata's hold-to-scrub,
  `useSurfaceFocused`).

Reproduced on main (2026-11-04, before 38ca62a11b): in `/demo`, Space in Sonata and mod+B in
the Agent Manager did nothing; on the desktop (`/agents`, `/sonata`) both work.

## Fix: landed with desktop mode in the demo (38ca62a11b)

A first fix here made the focused surface a path (the tab, then the nested surface focused in
it), joined by `PaneSurfaceProvider` for any nested surface. Before it landed, main's
desktop-in-demo work (task-1793813710-5fkaew) restructured `AppEmbed` so that **an embed is a
tab set of its own** (`TabsProvider embedded`): its app runs in a real tab, and the set publishes
its focused tab to the shortcuts' focused surface on a focus change, and claims it on a press in
its surface body. That fixes the same class by construction — every app inside an embed is in a
tab, whatever its shortcuts — so the path layer was dropped and this task keeps only the
verification.

Design choice of that model, kept: mounting an embed does not move the keys into it; the user's
first press inside it does (as entering an iframe). The demo's flows always start with one.

## Verification

- `apps/demo/e2e/sonata-in-demo.ts` step 3 — Space plays, Space pauses.
- `apps/demo/e2e/app-switch.ts` step 0 — a press in the embed, then mod+B collapses / expands the
  embedded Agent Manager's sidebar.
