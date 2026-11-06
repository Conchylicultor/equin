import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { useScopedUndoRedo } from "@plugins/primitives/plugins/undo-redo/web";
import { useReportSync } from "@plugins/primitives/plugins/sync-status/web";
import { useBlockEditor } from "../block-editor-context";
import type { BlockEditorAPI, RowData } from "../types";
import { useVoidCaret } from "./void-caret";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/**
 * The ONE way a page block may own a plain-text editing surface.
 *
 * ## Why it exists
 *
 * A block whose content is source rather than prose — a code block, an
 * equation — cannot put its text in Lexical, so it renders a `<textarea>` and
 * has to re-derive by hand everything a text block gets from the editor. Two
 * types did that independently and produced the SAME bug, byte for byte:
 * pasting into a code block could not be undone.
 *
 * The chain is worth stating, because every rule below is one of its links:
 *
 * 1. The textarea declares no undo owner, so `resolveUndoOwner` walks up to the
 *    page body's `surfaceUndoProps` and `mod+z` resolves to the SURFACE. The
 *    shortcut manager then calls `preventDefault()`, killing the browser's own
 *    textarea history — the one that handles a paste correctly.
 * 2. Nothing took its place for up to 500 ms, because the only thing recording
 *    was `editor.update()`, called from a DEBOUNCED autosave. A Cmd+Z inside
 *    that window reversed an unrelated earlier document edit while the pasted
 *    text sat untouched.
 * 3. Even after the debounce, the undo was invisible: the autosave hook
 *    (`useEditableField`) dropped every external write while its field had
 *    focus, so the reverted value never reached the textarea — and the next
 *    blur flushed the stale draft back over it.
 *
 * So the fix is not "record from the block too". It is that **recording and
 * persisting are separated, and only this primitive can spell either**:
 * recording is SYNCHRONOUS, on the keystroke; persisting is debounced and puts
 * nothing on the stack. A block renderer no longer writes any of it, so a sixth
 * instance of the bug has nowhere to be written.
 *
 * **Link 3 has since been fixed at its own source** — `useEditableField` now
 * asks whether the draft holds unsaved edits rather than whether the field has
 * focus, adopting a clean draft's external write and reporting a `conflict`
 * otherwise. That does NOT make this primitive redundant, and link 2 is why: a
 * debounced autosave hook is the wrong SHAPE for a surface editing at input
 * frequency, whatever it does about external writes. Undo has to exist for the
 * keystroke you just typed, so recording must be synchronous with it — which
 * means recording and persisting cannot be the same call, which is the one
 * thing an autosave hook cannot offer.
 *
 * ## What it owns
 *
 * - **The draft**, rendered at input frequency. Deliberately not
 *   `useEditableField`: its debounce IS link 2 above — the half that still
 *   rules it out — and its mirror effect WAS link 3, since fixed on its own.
 * - **Synchronous undo recording** onto the document's own stack
 *   (`useScopedUndoRedo`). `recordEntry` pins the top entry's `undo` to the
 *   start of a run and adopts each new `redo`, so recording per keystroke does
 *   not grow the stack: a typing run is one step, and a pause past the coalesce
 *   window starts the next. SCOPED, because the thunks close over this mount's
 *   draft — after unmount there is nothing for them to set.
 *
 *   The coalesce key is `block-text:<blockId>`, not the bare `blockId` it looks
 *   like it should be. `BlockEditorAPI.update` → `commitRow` already records the
 *   block's ROW-DATA edits under that id, and the merge rule above keeps the
 *   first entry's `undo` while adopting the newest `redo` — so two owners
 *   sharing one key splice the undo of one action onto the redo of another (a
 *   language pick, then typing inside the window, gives one entry that undoes
 *   the language and redoes the text). One owner per key; namespace yours.
 * - **Undo/redo that set the draft AND the row**, plus the SELECTION. The
 *   editor's own `caretOffset` → `focusBlock` path only focuses a void block;
 *   it cannot restore a textarea's selection, so the primitive must.
 * - **Debounced persist**, through `commitRecordedRowData` — the row write that
 *   deliberately records nothing, because the entry already exists. A second
 *   entry from the timer would make one burst cost two Cmd+Z, the first of them
 *   reverting the row while this control kept rendering its own draft.
 * - **Void-caret registration.** `useVoidCaret` is called HERE, and its
 *   `onFocus` is already wired into the returned props — a block cannot forget
 *   it and be skipped by `navigate()`. Which is what the code block itself did
 *   before that hook existed: it pulled DOM focus on `isFocused` but registered
 *   no handle, so arrowing past it skipped it while a click could still focus
 *   it.
 * - **The boundary keys** — Backspace at empty, ↑ at offset 0, ↓ at the end —
 *   which both blocks duplicated verbatim.
 *
 * ## What it deliberately does NOT own
 *
 * Everything block-specific: the code block's shiki underlay and its shared
 * `METRICS` caret-alignment contract, its language picker, its Tab→two-spaces
 * and its copy button; the equation's KaTeX preview, its Enter-commits and its
 * display/edit toggle. A caller adds keys through `onKeyDown`, which runs
 * BEFORE the boundary handling so `preventDefault()` wins.
 */

/** A textarea selection, in character offsets. */
export interface BlockTextSelection {
  start: number;
  end: number;
}

/** The draft plus its selection — one undo step's worth of state. */
interface Snapshot {
  text: string;
  selection: BlockTextSelection;
}

/** What a caller's `onKeyDown` may do to the text, without a stale closure. */
export interface BlockPlainTextControl {
  /** The CURRENT draft — never a render closure's stale copy. */
  value: string;
  /**
   * Replace the text (the code block's Tab→two-spaces). Recorded and persisted
   * exactly like a keystroke; `selection` is where the caret should end up.
   */
  setValue: (next: string, selection?: BlockTextSelection) => void;
}

export interface BlockPlainTextOptions {
  /** The block's row id — the undo coalesce key and the focus-handle key. */
  blockId: string;
  /** Does the editor's focus model currently point at this block? */
  isFocused: boolean;
  editor: BlockEditorAPI;
  /** The PERSISTED text — the block's own field, read off its row. */
  value: string;
  /**
   * The row payload for a given text. Called when the persist timer fires, so
   * it may close over other live state (the code block's language); the latest
   * closure is always the one used.
   */
  rowData: (text: string) => RowData;
  /**
   * Human name of what is being edited ("code", "equation source"). Shown by
   * the universal sync-status indicator, and used for the history entry.
   */
  label: string;
  /**
   * The caller's own keys. Runs BEFORE the boundary handling, so a caller wins
   * a key by calling `preventDefault()` on it.
   */
  onKeyDown?: (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    text: BlockPlainTextControl,
  ) => void;
  /**
   * Persist debounce. Recording is synchronous and completely unaffected by
   * this — the two are separate on purpose.
   */
  persistMs?: number;
}

/** Everything a `<textarea>` needs; spread it, or hand the bag to {@link BlockTextArea}. */
export interface BlockPlainTextProps {
  ref: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onFocus: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onCut: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  spellCheck: false;
  autoCorrect: "off";
  autoCapitalize: "off";
}

export interface BlockPlainText extends BlockPlainTextControl {
  /** The textarea node, for a caller that must measure it. */
  ref: React.RefObject<HTMLTextAreaElement | null>;
  props: BlockPlainTextProps;
}

const DEFAULT_PERSIST_MS = 500;

function readSelection(ta: HTMLTextAreaElement): BlockTextSelection {
  return { start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 };
}

const NO_KEYS = () => {};

export function useBlockPlainText(opts: BlockPlainTextOptions): BlockPlainText {
  const { blockId, isFocused, editor, value, label } = opts;
  const { commitRecordedRowData } = useBlockEditor();
  const { record } = useScopedUndoRedo();

  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(draft);
  // The text the ROW currently holds, as far as this mount knows: what a
  // persist wrote, or what an external write handed us. The divergence test
  // `draft !== persisted` is what "the user has unsaved keystrokes" means.
  const persistedRef = useRef(value);
  // The selection as it was BEFORE the change now being applied. Kept current
  // by every event that fires ahead of the DOM mutation (keydown, paste, cut)
  // plus `select`/`focus` as the backstop for pointer and menu gestures.
  const selectionRef = useRef<BlockTextSelection>({
    start: value.length,
    end: value.length,
  });
  const pendingSelectionRef = useRef<BlockTextSelection | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  const rowData = useEventCallback(opts.rowData);
  const callerKeyDown = useEventCallback(opts.onKeyDown ?? NO_KEYS);

  const persist = useEventCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDirty(false);
    const next = draftRef.current;
    if (next === persistedRef.current) return;
    persistedRef.current = next;
    // Records NOTHING — the entry for this text is already on the stack, put
    // there synchronously by the keystroke that produced it.
    commitRecordedRowData(blockId, rowData(next));
    // The reporter owns "saved" explicitly (sync-status' rule): stamp it where
    // the write actually happened, never inferred from a `dirty` edge, which a
    // coalesced render can swallow whole. Durability past this point is the
    // optimistic pipeline's own report, which the aggregate takes precedence on.
    setSavedAt(Date.now());
  });

  const schedule = useEventCallback(() => {
    setDirty(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      persist();
    }, opts.persistMs ?? DEFAULT_PERSIST_MS);
  });

  /** One end of a recorded step: put the draft, the row and the caret back. */
  const restore = useEventCallback((snap: Snapshot) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDirty(false);
    draftRef.current = snap.text;
    setDraft(snap.text);
    // Applied in the layout effect below: the textarea still holds the OLD
    // value until React commits, so setting the range here would clamp it.
    pendingSelectionRef.current = snap.selection;
    if (snap.text !== persistedRef.current) {
      persistedRef.current = snap.text;
      commitRecordedRowData(blockId, rowData(snap.text));
      setSavedAt(Date.now());
    }
  });

  const applyChange = useEventCallback(
    (next: string, after: BlockTextSelection) => {
      const prev = draftRef.current;
      if (next === prev) {
        selectionRef.current = after;
        return;
      }
      const before: Snapshot = { text: prev, selection: selectionRef.current };
      const now: Snapshot = { text: next, selection: after };
      draftRef.current = next;
      setDraft(next);
      selectionRef.current = after;
      // Synchronous, on every keystroke. `recordEntry` keeps the top entry's
      // `undo` (this run's start) and adopts the newest `redo`, so a run
      // collapses to one step instead of growing the stack per character.
      //
      // The key is NAMESPACED, not the bare `blockId` it looks like it should
      // be: `BlockEditorAPI.update` records the block's own row-data edits
      // under exactly that id. Sharing it would let two DIFFERENT recorders
      // merge — a language pick, then typing within the window — into one entry
      // whose `undo` reverts the language and whose `redo` restores the text.
      // The merge rule assumes ONE owner per key, so each owner needs its own.
      record({
        label: `Edit ${label}`,
        coalesceKey: `block-text:${blockId}`,
        undo: () => restore(before),
        redo: () => restore(now),
      });
      schedule();
    },
  );

  const setValue = useEventCallback(
    (next: string, selection?: BlockTextSelection) => {
      const sel = selection ?? { start: next.length, end: next.length };
      applyChange(next, sel);
      pendingSelectionRef.current = sel;
    },
  );

  const control = useCallback(
    (): BlockPlainTextControl => ({ value: draftRef.current, setValue }),
    [setValue],
  );

  const voidCaret = useVoidCaret({
    blockId,
    isFocused,
    editor,
    focus: (opts) =>
      focusElement(ref.current, { reveal: opts?.scroll ?? false }),
  });

  const onChange = useEventCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      applyChange(e.target.value, readSelection(e.target));
    },
  );

  const onKeyDown = useEventCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget;
      // Keydown fires before the browser applies the key, so this IS the
      // pre-change selection an undo has to put back.
      selectionRef.current = readSelection(ta);
      callerKeyDown(e, control());
      if (e.defaultPrevented) return;

      const text = draftRef.current;
      if (e.key === "Backspace" && text === "") {
        // Empty source block → remove it, matching Notion.
        e.preventDefault();
        editor.remove();
        return;
      }
      if (
        e.key === "ArrowUp" &&
        ta.selectionStart === 0 &&
        ta.selectionEnd === 0
      ) {
        e.preventDefault();
        editor.navigate("up");
        return;
      }
      if (
        e.key === "ArrowDown" &&
        ta.selectionStart === text.length &&
        ta.selectionEnd === text.length
      ) {
        e.preventDefault();
        editor.navigate("down");
      }
    },
  );

  const onFocus = useEventCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      selectionRef.current = readSelection(e.currentTarget);
      voidCaret.onFocus();
    },
  );
  const onBlur = useEventCallback(() => persist());
  const onSelect = useEventCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      selectionRef.current = readSelection(e.currentTarget);
    },
  );
  const onClipboard = useEventCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // A paste/cut fires before the DOM mutates and reaches no keydown when it
      // comes from the context menu — so the pre-change selection is read here.
      selectionRef.current = readSelection(e.currentTarget);
    },
  );

  // Put back a selection an undo/redo (or `setValue`) asked for, once React has
  // committed the value it belongs to. No dep array: the question is "is one
  // pending", which nothing in props can answer, and the ref guards the cost.
  useLayoutEffect(() => {
    const sel = pendingSelectionRef.current;
    if (sel === null) return;
    pendingSelectionRef.current = null;
    const ta = ref.current;
    if (!ta) return;
    // Undo/redo REVEALS the block it acted on, the same promise `commitRow`'s
    // own thunks keep with `focusBlock`.
    focusElement(ta, { reveal: true });
    ta.setSelectionRange(sel.start, sel.end);
    selectionRef.current = sel;
  });

  // Adopt an external write — an agent, another tab, or the row half of a
  // structural undo. KNOWN BOUND: while the draft diverges (between a keystroke
  // and its persist) an external write is not adopted, because the user's
  // unsaved text is the thing they can actually see. The window is one debounce.
  useEffect(() => {
    if (value === draftRef.current) {
      persistedRef.current = value;
      return;
    }
    if (value === persistedRef.current) return;
    if (draftRef.current !== persistedRef.current) return;
    persistedRef.current = value;
    draftRef.current = value;
    setDraft(value);
  }, [value]);

  // The last keystrokes must reach the row even when the block unmounts inside
  // the debounce window (a conversion, a collapse, leaving the page).
  useEffect(() => () => persist(), [persist]);

  useReportSync({ phase: dirty ? "syncing" : "idle", label, savedAt });

  const props = useMemo<BlockPlainTextProps>(
    () => ({
      ref,
      value: draft,
      onChange,
      onFocus,
      onBlur,
      onKeyDown,
      onSelect,
      onPaste: onClipboard,
      onCut: onClipboard,
      spellCheck: false,
      autoCorrect: "off",
      autoCapitalize: "off",
    }),
    [draft, onChange, onFocus, onBlur, onKeyDown, onSelect, onClipboard],
  );

  return { value: draft, setValue, ref, props };
}

export interface BlockTextAreaProps {
  /** The bag from {@link useBlockPlainText} — the caller holds the hook, since
   * every block that owns source also RENDERS it (a highlighted underlay, a
   * KaTeX preview), so the draft has to be readable outside the control. */
  text: BlockPlainText;
  /** Paint and layout. The baseline caret/outline/placeholder contract is applied first. */
  className?: ClassName;
  placeholder?: string;
  rows?: number;
  "aria-label"?: string;
}

/**
 * The baseline textarea for {@link useBlockPlainText}: the styling contract
 * both source blocks were hand-copying (no spellcheck, no autocorrect, a
 * visible caret over transparent-or-plain text, a muted placeholder) applied in
 * ONE place, so a new source block cannot ship a subtly different one.
 *
 * It exposes no `ref` of its own: the hook already holds the node, and a second
 * handle on it is an invitation to move focus behind the editor's caret model.
 */
export function BlockTextArea({
  text,
  className,
  ...rest
}: BlockTextAreaProps) {
  return (
    <textarea
      {...text.props}
      {...rest}
      className={cn(
        "caret-foreground outline-none placeholder:text-muted-foreground",
        className,
      )}
    />
  );
}
