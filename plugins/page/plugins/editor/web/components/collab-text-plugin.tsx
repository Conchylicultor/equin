import { useEffect } from "react";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { LexicalCollaboration } from "@lexical/react/LexicalCollaborationContext";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  COLLABORATION_TAG,
  COMMAND_PRIORITY_CRITICAL,
  KEY_DOWN_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
} from "lexical";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import { useReportSync } from "@plugins/primitives/plugins/sync-status/web";
import {
  runsLength,
  runsOf,
  type Block,
  type BlockTextVariant,
} from "../../core";
import { useBlockEditor } from "../block-editor-context";
import {
  $xmlBasisContentLength,
  serializeBlockRuns,
} from "../internal/block-text-extensions";
import {
  collabHydrationReportSink,
  type CollabHydrationReason,
} from "../internal/hydration-report";
import {
  useCollabBlockDoc,
  useLocalCollabBlockDoc,
  type CollabBlockDoc,
} from "../internal/use-collab-block-doc";
import { HydrationPlaceholder } from "./hydration-placeholder";

/**
 * How long a burst of content-doc updates settles before the blind-binding
 * check reads the editor. The same window the seam's projection uses, for the
 * same reason (one check per typing run, not one per keystroke) — and it must
 * not be zero: `syncYjsChangesToLexical` commits on a microtask, so a same-turn
 * check would read an editor exactly one microtask stale and call every
 * keystroke a blind binding.
 */
const BLIND_BINDING_SETTLE_MS = 1000;

/**
 * How long after the transport SYNCED a block's doc may stay empty while its
 * ROW says otherwise before that counts as starvation.
 *
 * The window used to start at mount and run 5 s, which made it a bet on how
 * fast the subscription would be — and it lost that bet constantly (measured
 * `sub:page-block-doc` latency reaches 907 s under load, so healthy cold opens
 * tripped it: 572 reported false positives, including 68 in 4 s). The clock now
 * starts at the thing that was actually slow. Once `isSynced` is true the
 * authoritative answer HAS arrived, so what is left is a short grace for the
 * apply and its commit to settle — not a guess at network latency. One shot per
 * piece of evidence, re-armed on the sync edge and on a row change; never a
 * poll.
 */
const STARVATION_SETTLE_MS = 2000;

/**
 * Recover a block whose rendered text no longer agrees with its content doc or
 * with the server, and report it. Two independent triggers, because either side
 * can be the one that fell behind and each is observable from a different place:
 *
 * - **blind binding** — driven by a content-doc update (the doc is the thing
 *   that moved), settled and then compared against what THIS editor renders;
 * - **starved doc** — driven by the ROW, the other independent witness of the
 *   block's content: a `data.text` push carrying text while this client's doc
 *   is empty, the transport has ALREADY ANSWERED, and nothing here ever typed
 *   into it. Row-driven precisely because a starved doc receives no doc updates
 *   at all, so the doc-side trigger can never fire for it.
 *
 * Two things keep the second trigger honest, and each closes a whole class of
 * false positive:
 *
 * - **`isSynced`** — the transport's own witness that an authoritative answer
 *   landed. Before it, an empty doc proves NOTHING: the push is simply still on
 *   its way, and "still coming" is indistinguishable from "never arriving"
 *   except by asking the transport. Calling slow "broken" is what made this arm
 *   fire on healthy cold opens.
 * - **`hasLocalEdits`** — a doc the user just emptied legitimately trails its
 *   own ~1 s row projection.
 *
 * **The repair differs per arm, and that is the point.** `rehydrate()` ends the
 * session and mints a fresh EMPTY replica, so the text genuinely leaves the DOM
 * until the re-read lands. That is the ONLY cure for a binding that missed its
 * post-attach `observeDeep` set (`blind-binding`) — and pure damage for a doc
 * that is merely behind the server, whose binding is working perfectly. So:
 *
 * - `blind-binding` → `rehydrate()` (re-attach: the defect is the binding);
 * - `starved-doc` → `refetch()` (re-read into the live doc, nothing on screen
 *   moves — see {@link CollabBlockDoc.refetch});
 * - the user-pressed `stalled` Retry → `rehydrate()` (they asked for the big
 *   hammer, and `stalled` IS a binding defect).
 *
 * The guard is purely a DETECTOR: it does not stand in front of the projection
 * write, because the projection reads the doc rather than this editor and so
 * can no longer persist a blind binding's emptiness (R1 of
 * `research/2026-08-03-page-block-content-session-one-owner.md`). What is left
 * is a real, recoverable RENDER defect — reported and healed in place, retired
 * in the stage that makes hydration a proven request/response.
 */
function useHydrationGuard(block: Block, doc: CollabBlockDoc): void {
  const [editor] = useLexicalComposerContext();
  const blockRef = useLatestRef(block);
  const {
    docContentLength,
    hasLocalEdits,
    isSynced,
    refetch,
    rehydrate,
    subscribeDocUpdates,
    subscribeSync,
  } = doc;

  const recover = useEventCallback(
    (reason: CollabHydrationReason, shownLength: number) => {
      const b = blockRef.current;
      collabHydrationReportSink.emit({
        reason,
        blockId: b.id,
        shownLength,
        docLength: docContentLength(),
        rowLength: runsLength(
          runsOf((b.data as Record<string, unknown> | null)?.text),
        ),
      });
      // One verb per defect (see the doc comment above). Never the destructive
      // one for a binding that is working.
      if (reason === "starved-doc") refetch();
      else rehydrate();
    },
  );

  // Blind binding: the doc holds content this editor renders NOTHING of.
  // `@lexical/yjs` ingests a doc solely through the `observeDeep` events fired
  // AFTER its binding attaches, so a binding that missed them renders empty
  // FOREVER (see `binding-replica.ts`) while the doc and the server keep every
  // character. Comparing against ZERO is what makes this basis-independent —
  // the two counts disagree on any non-empty block (see `$xmlBasisContentLength`).
  const checkBlindBinding = useEventCallback(() => {
    if (docContentLength() === 0) return;
    if (runsLength(serializeBlockRuns(editor)) > 0) return;
    recover("blind-binding", 0);
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeDocUpdates(() => {
      // ONE trailing window per burst, not reset per update — the same shape
      // (and reason) as the seam's projection debounce.
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        checkBlindBinding();
      }, BLIND_BINDING_SETTLE_MS);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribeDocUpdates, checkBlindBinding]);

  const rowLength = runsLength(
    runsOf((block.data as Record<string, unknown> | null)?.text),
  );
  useEffect(() => {
    if (rowLength === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The window opens on the SYNC edge, never on mount: until the transport
    // says it answered, an empty doc is a request in flight and there is
    // nothing to time. Armed once — a re-announced sync (a reconnect) while a
    // window is already open must not restart the clock.
    const arm = (): void => {
      if (timer !== null) return;
      if (!isSynced()) return;
      if (hasLocalEdits() || docContentLength() > 0) return;
      timer = setTimeout(() => {
        timer = null;
        // Re-read all three witnesses at fire time: the settle window exists
        // precisely because any of them can resolve inside it.
        if (!isSynced() || hasLocalEdits() || docContentLength() > 0) return;
        recover("starved-doc", 0);
      }, STARVATION_SETTLE_MS);
    };
    const unsubscribe = subscribeSync(arm);
    // Already synced when this row's evidence appeared — no edge is coming.
    arm();
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
    // Re-armed only when the row's length changes (a new piece of evidence) or
    // the transport re-syncs — never on a timer, and never a retry loop.
  }, [
    rowLength,
    docContentLength,
    hasLocalEdits,
    isSynced,
    subscribeSync,
    recover,
  ]);
}

/**
 * PROVE that this binding renders what its replica holds — the read half of the
 * session's hydration state (stage 4; the machine itself lives in
 * `collab-session.ts`, read its module comment first).
 *
 * The check runs on the first `COLLABORATION_TAG` commit after the
 * authoritative apply, and it MUST: `syncYjsChangesToLexical` commits WITHOUT
 * `discrete` while yjs emits `doc.on('update')` at the tail of the same
 * `applyUpdate`, so inside any of our own handlers the editor is exactly one
 * microtask stale — a same-turn comparison would call every keystroke a blind
 * binding. Verified against the installed packages, not assumed.
 *
 * The tag filter is not decoration. Two other commits arrive on this editor and
 * neither says anything about hydration: Lexical's own initial commit for a
 * freshly-created editor state (untagged), and `$ensureEditorNotEmpty`'s
 * follow-up, which `@lexical/yjs` fires from `onUpdate` OUTSIDE its tagged
 * block.
 *
 * The mount-time probe is `promoteOnly`: this listener registers in an effect,
 * and `CollaborationPlugin` is a CHILD, so its `connect()` has already run —
 * ordinarily still inside the same synchronous effect flush (so the commit is
 * yet to come), but a probe that could conclude DISAGREEMENT there would read a
 * merely-pending commit as a stalled binding. It may therefore only confirm.
 */
function useHydrationVerification(doc: CollabBlockDoc): void {
  const [editor] = useLexicalComposerContext();
  const { verifyRendered } = doc;
  useEffect(() => {
    verifyRendered(editor.getEditorState().read($xmlBasisContentLength), true);
    return editor.registerUpdateListener(({ tags, editorState }) => {
      if (!tags.has(COLLABORATION_TAG)) return;
      verifyRendered(editorState.read($xmlBasisContentLength));
    });
  }, [editor, verifyRendered]);
}

/** Server-synced content-doc binding: the CRDT transport (subscription + FK gate). */
function ServerCollabTextPlugin({ block, textVariant }: CollabTextPluginProps) {
  // Text history: each closed local editing run in this block's content doc —
  // the owner's run tracker groups them (a 500 ms idle window) and keeps
  // remote applies, replays and `untracked` surgeries out — arrives as DATA
  // (the block's runs before and after it) and is recorded as one entry on the
  // app's single document-level undo stack. The entry holds no pointer into
  // this block's doc or editor (not even a caret: replay derives it from the
  // runs), so it replays whether or not this editor still exists. Stable, so
  // the doc observers never resubscribe on a context re-render.
  const { projectText, rowTruthOf, recordTextEdit } = useBlockEditor();
  const onRunsEdit = useEventCallback(recordTextEdit);
  // What this client knows about the block id in server truth
  // (`internal/row-truth.ts`). `"present"` lifts the doc-init FK gate (Stage
  // 4a): a freshly created / split block renders from the optimistic overlay
  // before its `_blocks` row exists server-side, and seeding then would
  // FK-violate — the same blocks push that commits the row flips this and
  // unlatches the seed. `"unseen"` (client-minted, nothing stored) pre-seeds
  // instantly; `"removed"` (a re-created row whose doc survived its trash)
  // waits for the subscription like any existing block.
  const rowTruth = rowTruthOf(block.id);
  const doc = useCollabBlockDoc(
    block.id,
    (block.data as Record<string, unknown> | null)?.text,
    rowTruth,
    projectText,
    onRunsEdit,
  );
  useHydrationGuard(block, doc);
  useHydrationVerification(doc);
  return <CollabBinding block={block} doc={doc} textVariant={textVariant} />;
}

/** In-memory content-doc binding (`persist={false}`): a purely local `Y.Doc`, no network. */
function LocalCollabTextPlugin({ block, textVariant }: CollabTextPluginProps) {
  const { projectText, recordTextEdit } = useBlockEditor();
  const onRunsEdit = useEventCallback(recordTextEdit);
  const doc = useLocalCollabBlockDoc(
    block.id,
    (block.data as Record<string, unknown> | null)?.text,
    projectText,
    onRunsEdit,
  );
  // The blind-binding arm applies here too (a local doc can outrun its binding
  // the same way); the starved-doc arm self-disables — a local provider reports
  // `hasLocalEdits` unconditionally, since there is no server to be behind.
  useHydrationGuard(block, doc);
  // Shares the machine rather than forking it. A local session is locally
  // authoritative for its whole life, so it is already `hydrated` by the time
  // any commit arrives and this listener is a no-op — which is exactly what
  // makes `stalled` structurally unreachable on this transport.
  useHydrationVerification(doc);
  return <CollabBinding block={block} doc={doc} textVariant={textVariant} />;
}

/**
 * The keys Lexical's `$handleKeyDown` treats as undo/redo (⌘/Ctrl+Z,
 * ⌘/Ctrl+⇧Z, Ctrl+Y) plus ⌘Y — the surface binding's own redo spelling. A
 * superset of Lexical's platform-exact `isUndo`/`isRedo` is safe: a claimed key
 * is only kept from Lexical, never prevented, so whatever else it meant still
 * happens.
 */
function isUndoRedoKey(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  return key === "z" || (key === "y" && !event.shiftKey);
}

/**
 * The shared `CollaborationPlugin` mount + Lexical UNDO/REDO swallow, given the
 * {@link CollabBlockDoc} from either transport. `shouldBootstrap={false}`: the
 * doc is seeded through the provider (server first-writer-wins doc-init, or the
 * local seed), never bootstrapped by Lexical (bootstrapping locally would race
 * a concurrent seeder into duplicated content).
 *
 * Each block gets its own `LexicalCollaboration` context so per-block doc maps
 * never share a global registry (and `useCollaborationContext` — which throws
 * without a provider — is satisfied). Cursors never render: awareness is real
 * but never broadcast, and each binding's awareness is minted over the very doc
 * that binding attached to (`BindingReplica`), so the only state that exists is
 * the one `syncCursorPositions` skips as local. That second half is load-bearing
 * — awareness over ANY other doc carries a clientID the binding reads as a
 * remote peer, and the local user grows a labelled cursor of their own.
 *
 * Mounted exactly once per block, this is also where the block's prose reports
 * into the surface's sync-status cloud: the `doc-update` pipeline is what makes
 * text durable, so "Saved" must mean the provider's queue drained — not that
 * the (~1 s, derived) `data.text` projection happened to settle. The in-memory
 * transport reports a permanently idle state (nothing to save), which the
 * cloud aggregates to silence.
 */
function CollabBinding({
  block,
  doc,
  textVariant,
}: CollabTextPluginProps & { doc: CollabBlockDoc }) {
  const { providerFactory, saveState, retrySave } = doc;
  const [editor] = useLexicalComposerContext();

  // One reporter per block; the surface's store aggregates them
  // (error > syncing > saved > idle), so a single dirty block keeps the cloud
  // spinning and a single durably-rejected one turns it red. Offline reports
  // `syncing`, not `error` — the bytes are queued and retry push-based.
  useReportSync({
    phase: saveState.phase,
    label: "text",
    retry: saveState.phase === "error" ? retrySave : undefined,
    savedAt: saveState.lastFlushedAt,
  });

  // CollaborationPlugin force-installs its OWN per-block undo manager (over
  // the binding's replica) on Lexical's UNDO/REDO commands. This app
  // deliberately has NO per-block history — undo is the single document-level
  // stack routed through window-level shortcuts (see editor/CLAUDE.md), which
  // drives text through the data entries recorded above. Swallow the commands
  // at CRITICAL priority so CollaborationPlugin's manager never fires.
  //
  // Swallowing the COMMAND is not enough to hand the KEY over: Lexical's
  // built-in `KEY_DOWN_COMMAND` listener (`$handleKeyDown`, priority EDITOR)
  // calls `event.preventDefault()` on ⌘Z / ⌘⇧Z BEFORE dispatching
  // UNDO/REDO_COMMAND (`lexical@0.44.0 Lexical.dev.mjs:2949-2954`), and the
  // window-level `ShortcutManager` yields every `defaultPrevented` key to the
  // element that "handled" it — so the document stack never saw ⌘Z typed in a
  // block. Claiming the undo/redo keys at `KEY_DOWN_COMMAND` (consumed, NOT
  // prevented) preempts that whole branch, so the native keydown reaches the
  // surface binding untouched. Spec: `e2e/paste-undo-verify.ts`.
  useEffect(() => {
    const unregisterKeys = editor.registerCommand(
      KEY_DOWN_COMMAND,
      isUndoRedoKey,
      COMMAND_PRIORITY_CRITICAL,
    );
    const unregisterUndo = editor.registerCommand(
      UNDO_COMMAND,
      () => true,
      COMMAND_PRIORITY_CRITICAL,
    );
    const unregisterRedo = editor.registerCommand(
      REDO_COMMAND,
      () => true,
      COMMAND_PRIORITY_CRITICAL,
    );
    return () => {
      unregisterKeys();
      unregisterUndo();
      unregisterRedo();
    };
  }, [editor]);

  // `key` is the re-attach: `CollaborationPlugin` builds its binding exactly
  // once per mount (behind its own ref), so a binding that lost hydration can
  // only be rebuilt by remounting it. The seam drops its replica in the same
  // act, so the rebuilt binding attaches to an EMPTY doc and takes the content
  // as post-attach events — the construction invariant it depends on. The
  // generation only ever changes when `rehydrate()` runs.
  return (
    <>
      <LexicalCollaboration>
        <CollaborationPlugin
          key={doc.attachGeneration}
          id={block.id}
          providerFactory={providerFactory}
          shouldBootstrap={false}
        />
      </LexicalCollaboration>
      {/* The only thing this plugin renders. `LexicalComposer` emits no DOM, so
          it lands in `TextBlockLayout`'s `relative` leaf cell — the same
          positioned ancestor Lexical's own placeholder resolves against. */}
      <HydrationPlaceholder block={block} doc={doc} textVariant={textVariant} />
    </>
  );
}

/** What a text block hands its content-doc binding. */
interface CollabTextPluginProps {
  block: Block;
  /** The block type's typography, so the hydration skeleton matches its line. */
  textVariant: BlockTextVariant;
}

/**
 * CRDT text binding for one block (per-block CRDT plan, Stage 2). Picks the
 * content-doc transport by the editor's persistence mode (stable per mount, so
 * the branch is not a hooks-order hazard): the server path binds through
 * `LiveStateYjsProvider` (subscription + doc-init/doc-update); the in-memory
 * (`persist={false}`) path binds a purely local `Y.Doc` that never networks.
 */
export function CollabTextPlugin({
  block,
  textVariant,
}: CollabTextPluginProps) {
  const { serverSync } = useBlockEditor();
  return serverSync ? (
    <ServerCollabTextPlugin block={block} textVariant={textVariant} />
  ) : (
    <LocalCollabTextPlugin block={block} textVariant={textVariant} />
  );
}
