import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  FOCUS_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import { findTrigger, type CanOpenCtx } from "./find-trigger";
import {
  isOpen,
  reduceTriggerState,
  triggerId,
  type MenuState,
} from "./trigger-state";
import { useCaretOwner } from "./arbiter";

/**
 * Why this is TWO hooks, not one. Every consumer derives its item count from the
 * OUTPUT `query` (page-link fetches options for the query; date builds a menu;
 * math has one item iff the query is non-empty; slash filters block types). A
 * single hook that took `itemCount` as an input forced every consumer into a
 * render-phase feedback loop (`setItemCount` from a value computed off `query`).
 * Splitting the seam makes the dependency one-way — `query → items → menu` — and
 * enforced by call order: `useCaretQuery` derives the trigger from the editor
 * alone; the consumer computes items FROM `caret.query`; `useCaretMenu` consumes
 * the handle + that item count. The feedback loop is now unrepresentable.
 */

export interface UseCaretQueryOpts {
  /** Unique per editor — the arbiter key that resolves at-most-one-owner. */
  id: string;
  /** The trigger string, e.g. "/", "[[", "@", "$$". */
  trigger: string;
  /** Gate on node position / text (e.g. `atWordBoundary`). */
  canOpen?: (ctx: CanOpenCtx) => boolean;
  /** Gate on the query string (e.g. `q => !/[\n ]/.test(q)`). */
  isQueryValid?: (query: string) => boolean;
}

/**
 * Opaque-ish handle from `useCaretQuery`, consumed by `useCaretMenu`. Consumers
 * read only `.query` (to compute their items) and `.dismiss` (outside-press).
 * The rest is the plumbing `useCaretMenu` reads.
 */
export interface CaretQuery {
  /** The arbiter key, mirrored onto the surface as `data-caret-trigger`. */
  id: string;
  /** The live text after the trigger — the seed the consumer computes items from. */
  query: string;
  /** `trigger !== null && !dismissed && focused && isCaretOwner` — the trigger/focus/arbiter slice. */
  open: boolean;
  /** Raw active-row index; reset to 0 by the update listener on every query change. */
  activeIndex: number;
  /** Raw setter (mouse hover + `useCaretMenu`'s wrap-around `move()`). */
  setActiveIndex: Dispatch<SetStateAction<number>>;
  /** Latch dismissal at the current trigger's identity (Esc / outside-press). */
  dismiss: () => void;
  /** The composer editor — `useCaretMenu` registers its keyboard commands here. */
  editor: LexicalEditor;
}

/**
 * Derives the trigger from the editor. Depends on NOTHING the consumer computes.
 * Owns the update listener (findTrigger + reduceTriggerState), the arbiter
 * candidacy, the `focused` dimension, and the `activeIndex` state — reset to 0
 * INSIDE the update listener when the query changes (co-located with the state
 * write, not a render effect, so the highlight starts at the top synchronously
 * with no render-behind flash).
 */
export function useCaretQuery(opts: UseCaretQueryOpts): CaretQuery {
  const [lexicalEditor] = useLexicalComposerContext();

  const [state, setState] = useState<MenuState>({
    trigger: null,
    dismissedId: null,
  });
  const [activeIndex, setActiveIndex] = useState(0);
  // Focus is a DIMENSION of the derived state, not a side effect: blur closes
  // but never latches, so returning to a block whose text still holds the
  // trigger re-derives `open` correctly. Initialize from whether the composer
  // root currently holds focus (an editor focused before this hook mounted).
  const [focused, setFocused] = useState(() => {
    const root = lexicalEditor.getRootElement();
    return !!root && root.contains(document.activeElement);
  });

  const { isCaretOwner, publish } = useCaretOwner(lexicalEditor, opts.id);

  const query = state.trigger?.query ?? "";
  const open = isOpen(state) && focused && isCaretOwner;

  // The last query reflected into state, so the update listener resets the
  // active row exactly when the query changes.
  const lastQueryRef = useRef<string | null>(null);

  const sync = useEventCallback(() => {
    const t = findTrigger(lexicalEditor.getEditorState(), {
      trigger: opts.trigger,
      canOpen: opts.canOpen,
      isQueryValid: opts.isQueryValid,
    });
    setState((prev) => reduceTriggerState(prev, t));
    const q = t?.query ?? null;
    if (q !== lastQueryRef.current) {
      lastQueryRef.current = q;
      setActiveIndex(0);
    }
    publish(opts.trigger, t ? t.triggerIndex : null);
  });

  useEffect(() => {
    sync();
    return lexicalEditor.registerUpdateListener(sync);
  }, [lexicalEditor, sync]);

  // FOCUS/BLUR flip the focus dimension. Non-consuming (`return false`) so they
  // never interfere with the editor's own focus handling; blur never latches.
  useEffect(() => {
    const unFocus = lexicalEditor.registerCommand(
      FOCUS_COMMAND,
      () => {
        setFocused(true);
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
    const unBlur = lexicalEditor.registerCommand(
      BLUR_COMMAND,
      () => {
        setFocused(false);
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
    return () => {
      unFocus();
      unBlur();
    };
  }, [lexicalEditor]);

  const dismiss = useEventCallback(() => {
    // Latch dismissal at the current trigger's identity; no-op with no trigger.
    setState((prev) =>
      prev.trigger ? { ...prev, dismissedId: triggerId(prev.trigger) } : prev,
    );
  });

  return {
    id: opts.id,
    query,
    open,
    activeIndex,
    setActiveIndex,
    dismiss,
    editor: lexicalEditor,
  };
}

export interface UseCaretMenuOpts {
  /** Number of committable items, computed by the consumer FROM `caret.query`. */
  itemCount: number;
  /** Commit the item at the (clamped) active index. */
  onCommit: (activeIndex: number) => void;
  /** Default `true`; `false` ⇒ arrow commands are NOT registered (caret moves freely). */
  navigate?: boolean;
  /** Which boolean drives the surface: `"open"` (default) or `"interactive"`. */
  surfaceWhen?: "open" | "interactive";
}

export interface UseCaretMenuResult {
  open: boolean;
  surfaceOpen: boolean;
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  /**
   * Commit the item at `index` from a POINTER press — the mouse/touch twin of
   * the keyboard Enter path. Every caret menu MUST route its item clicks through
   * this instead of calling `onCommit`/the item handler directly on
   * `onMouseDown`, because of two hazards a focus-less caret surface has and an
   * ordinary menu does not:
   *
   *  1. **Fire it on `onPointerDown`, never `onMouseDown`.** Pressing on the
   *     portaled surface perturbs the host editor's live selection (it extends
   *     into the menu text). A menu whose `open` is DERIVED from that selection
   *     (`/`, `[[`, `@`) therefore closes — and unmounts the pressed row —
   *     *between* `pointerdown` and `mousedown`, so a `mousedown`-time commit
   *     never runs at all. `pointerdown` fires while the row is still mounted and
   *     the caret still live.
   *  2. **It runs `onCommit` inside `editor.update()`.** The keyboard commit
   *     fires from inside `KEY_ENTER_COMMAND`, i.e. already within a Lexical
   *     update, so any nested `editor.update()` the consumer performs (e.g. the
   *     slash menu stripping the `/query` before a *store-level* `convertTo`) is
   *     DEFERRED and lands after the store write. A raw pointer handler runs
   *     outside any update, so that nested update would run synchronously in the
   *     wrong order and the commit silently no-ops. Wrapping here makes a pointer
   *     commit byte-for-byte the keyboard commit.
   */
  commit: (index: number) => void;
}

/**
 * Consumes the `useCaretQuery` handle plus the item count the consumer derived
 * from `caret.query`. Owns the `open`/`interactive`/`surfaceOpen` derivation,
 * the `activeIndex` clamp + wrap-around `move()`, and the three keyboard gates:
 *
 * - Arrows + Enter gate on `interactive` (`open && itemCount > 0`). Arrows are
 *   registered ONLY when `navigate !== false` — `$$` passes `navigate: false` so
 *   arrows still move the caret through LaTeX.
 * - Esc gates on `surfaceOpen` — dismisses a visible loading spinner / hint, but
 *   isn't swallowed by a no-match query showing nothing.
 * - Blur flips `focused` in `useCaretQuery` and never latches.
 */
export function useCaretMenu(
  caret: CaretQuery,
  opts: UseCaretMenuOpts,
): UseCaretMenuResult {
  const navigate = opts.navigate ?? true;
  const surfaceWhen = opts.surfaceWhen ?? "open";
  const lexicalEditor = caret.editor;
  const { setActiveIndex, dismiss } = caret;

  const open = caret.open;
  const interactive = open && opts.itemCount > 0;
  const surfaceOpen = surfaceWhen === "interactive" ? interactive : open;
  // Clamp reads to [0, itemCount) so an async list shrink can't index out of range.
  const activeIndex =
    opts.itemCount > 0 ? Math.min(caret.activeIndex, opts.itemCount - 1) : 0;

  // Stable reads for the (registered-once) Lexical command callbacks.
  const interactiveRef = useLatestRef(interactive);
  const surfaceOpenRef = useLatestRef(surfaceOpen);
  const itemCountRef = useLatestRef(opts.itemCount);
  const activeIndexRef = useLatestRef(activeIndex);
  const onCommitRef = useLatestRef(opts.onCommit);

  // Arrows: gate on `interactive`, and register ONLY when navigation is enabled
  // — `navigate: false` (math) must let arrows move the caret through LaTeX.
  useEffect(() => {
    if (!navigate) return;
    const move = (delta: number) =>
      setActiveIndex((i) => {
        const n = itemCountRef.current;
        return n === 0 ? i : (i + delta + n) % n;
      });
    // A consumed arrow must ALSO cancel the browser's default: returning `true`
    // only stops Lexical's other listeners, while the browser still moves the
    // caret. That move changes the text before the caret — the query — and a
    // query change resets the highlight to row 0, so the arrow the menu just
    // applied is undone. Invisible for `/` (its caret already sits at the line
    // end, where Down has nowhere to go); fatal for url-paste, whose caret sits
    // just past a link and slides into it.
    const unDown = lexicalEditor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (!interactiveRef.current) return false;
        event.preventDefault();
        move(1);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
    const unUp = lexicalEditor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (!interactiveRef.current) return false;
        event.preventDefault();
        move(-1);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
    return () => {
      unDown();
      unUp();
    };
  }, [lexicalEditor, navigate, setActiveIndex, interactiveRef, itemCountRef]);

  // Enter: gate on `interactive`. Esc: gate on `surfaceOpen` (so it dismisses a
  // visible loading spinner / hint, but doesn't get swallowed by a no-match
  // query showing nothing).
  useEffect(() => {
    const unEnter = lexicalEditor.registerCommand<KeyboardEvent | null>(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!interactiveRef.current) return false;
        event?.preventDefault();
        onCommitRef.current(activeIndexRef.current);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
    const unEscape = lexicalEditor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        if (!surfaceOpenRef.current) return false;
        dismiss();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
    return () => {
      unEnter();
      unEscape();
    };
  }, [
    lexicalEditor,
    dismiss,
    interactiveRef,
    surfaceOpenRef,
    activeIndexRef,
    onCommitRef,
  ]);

  // Pointer commit — see `UseCaretMenuResult.commit` for the two hazards this
  // guards. Running `onCommit` inside `editor.update()` puts it in the SAME
  // context the keyboard Enter handler runs in (inside a Lexical command, itself
  // an update), so a consumer's nested `editor.update()` defers identically.
  const commit = useEventCallback((index: number) => {
    lexicalEditor.update(() => onCommitRef.current(index));
  });

  return { open, surfaceOpen, activeIndex, setActiveIndex, commit };
}
