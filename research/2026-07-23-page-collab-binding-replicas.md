# Per-binding replica docs for the block collab registry

## Context

Inline nested-page expansion (see `2026-07-23-page-inline-nested-page-expansion.md`) made it possible for the same page's blocks to be mounted in two `BlockEditor`s in one JS context (expanded link in surface A + the page's own detail pane). That exposed a latent defect in the per-block collab-doc registry (`editor/web/internal/use-collab-block-doc.ts`):

- The registry shares ONE `Y.Doc` + provider per blockId ("two docs for one block would fork the CRDT").
- Lexical's `CollaborationPlugin` hydrates Yjs→Lexical **only** through `observeDeep` update events — there is no initial replay of pre-existing doc content (verified in `@lexical/react` 0.44 source; `shouldBootstrap` is correctly `false` here and initializes empty state anyway).
- A second binding therefore attaches to an already-populated doc, no event ever fires (the provider's re-delivered server state merges idempotently — a no-op), and its editor renders **empty text**. Worse, typing there computes Lexical→Yjs deltas against a wrong (empty) baseline — duplication/corruption risk.

Hydration today is a timing accident: it works only when the doc is empty at attach and filled after. The fix makes hydration a construction invariant.

## Design

Keep the registry entry as the **canonical** per-block state — one canonical `Y.Doc`, ONE transport provider (`LiveStateYjsProvider`/`LocalYjsProvider`), the `Y.UndoManager`, flush/teardown lifecycle — all unchanged. Add a **per-binding replica** layer:

- Each mounted `CollabTextPlugin` gets its own fresh **replica `Y.Doc`** plus a thin per-binding provider handed to `CollaborationPlugin` (docMap gets the replica).
- **Bidirectional synchronous relay** between canonical and each replica:
  - canonical `update` → `Y.applyUpdate(replica, update, origin)` (origin passed through verbatim);
  - replica `update` → `Y.applyUpdate(canonical, update, origin)` likewise.
  - Loop prevention by a synchronous **re-entrancy latch** per relay pair (Yjs `applyUpdate`/events are synchronous), NOT by origin rewriting — origin passthrough preserves existing semantics everywhere: the binding's own `origin !== binding` check, `isFromUndoManger` (`origin instanceof UndoManager`) selection handling, the canonical UndoManager's dynamic tracked-origin learning (a replica's binding origin is "not provider, not UndoManager" → tracked, exactly as before), and the transport provider's flush trigger (`origin !== provider`). Residual echoes are idempotent no-ops.
- The per-binding provider's `connect()` applies `encodeStateAsUpdate(canonical)` into the replica. `CollaborationPlugin` attaches `observeDeep` in an effect declared before its `connect` effect, so the initial state lands **after** attach → events fire → the binding hydrates, always. (The current transport already relies on this same ordering.)
- CRDT-fork safety: replicas + canonical are ordinary Yjs replicas of one CRDT converging via update exchange — the same model as cross-client sync, just in-process. Seeding determinism, doc-init first-writer-wins, and flush all stay on the canonical/transport side, untouched.
- Replica lifecycle rides the existing hook hold (`useCollabDocHold`): created with the hold, destroyed on release; the entry's deferred-destroy/teardown-retention semantics are unchanged. `appendRunsToBlockDoc`/`truncateBlockDocFrom` (offscreen, doc-level) and `captureBlockDocEdit` keep operating on the canonical doc; relays fan results out synchronously.

Why this eliminates the class: every binding now attaches to a doc that is empty by construction and receives ALL content as post-attach updates. "Pre-populated at bind time" cannot exist, regardless of concurrent editor count, mount order, retained entries, keep-alive tabs, or future same-page transclusion.

## Files

- `plugins/page/plugins/editor/web/internal/use-collab-block-doc.ts` — replica acquisition on the hold; per-binding provider; providerFactory hands out replica doc/provider.
- NEW `plugins/page/plugins/editor/web/internal/binding-replica.ts` — replica doc + relay (latch) + per-binding provider implementation. Pure enough for bun:test.
- `plugins/page/plugins/editor/web/components/collab-text-plugin.tsx` — only if the CollabBinding wiring needs the new hold surface (expected: none or minimal; saveState still reads the canonical provider).
- Tests: `binding-replica.test.ts` + extend the existing registry lifecycle tests.

## Verification

- bun:test: second replica created against a populated canonical hydrates fully post-attach; edits on replica A appear on replica B and canonical; canonical undo reflected in replicas; relay terminates (latch) and echoes are no-ops; teardown destroys replicas without touching canonical retention semantics.
- e2e (Playwright): expand a page-link inline, click through to the page detail pane, assert the detail pane's block text is NON-empty (the regression), and type in the detail pane then confirm the inline copy updates live (two-binding relay).
- `./equin build` + manual pass.
