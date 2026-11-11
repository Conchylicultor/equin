import { useEffect, useRef, useState } from "react";
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  FOCUS_COMMAND,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import type { CaretQuery } from "./use-caret-trigger";

/**
 * The FORCED producer of a `CaretQuery`: open-state driven by an EXTERNAL
 * `active` flag rather than a trigger char, and the query is the FULL text
 * before the caret (so the block's own text filters the menu inline). Same
 * `CaretQuery` handle that `useCaretQuery` returns, so `useCaretMenu` +
 * `CaretTriggerMenu` consume it identically.
 *
 * This is the substrate for a BUTTON that opens a caret menu on the current
 * block — the page editor's gutter `+`: clicking it inserts an empty paragraph
 * below, focuses it, sets `active` on that block, and this hook force-opens the
 * shared caret menu inline-filtered by the block's own text. Unlike
 * `useCaretQuery` it does NOT participate in the single-owner arbiter — the
 * `active` flag is externally single-owner by construction.
 */
export interface UseForcedCaretQueryOpts {
  /** Unique per editor — mirrored onto the surface as `data-caret-trigger`. */
  id: string;
  /** Externally-driven open flag (the gutter `+` sets a draft on this block). */
  active: boolean;
  /** Gate on the query string (e.g. `q => !/[\n ]/.test(q)`); default: always valid. */
  isQueryValid?: (query: string) => boolean;
  /** Esc / outside-press — the caller clears `active`. */
  onDismiss?: () => void;
}

export function useForcedCaretQuery(opts: UseForcedCaretQueryOpts): CaretQuery {
  const [lexicalEditor] = useLexicalComposerContext();

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Focus is a DIMENSION of the derived state (mirrors `useCaretQuery`): blur
  // closes but never latches. Initialize from whether the composer root
  // currently holds focus (an editor focused before this hook mounted).
  const [focused, setFocused] = useState(() => {
    const root = lexicalEditor.getRootElement();
    return !!root && root.contains(root.ownerDocument.activeElement);
  });

  // The last reflected query, so the update listener resets the active row
  // exactly when the query changes (co-located with the state write).
  const lastQueryRef = useRef<string | null>(null);

  const sync = useEventCallback(() => {
    const q = lexicalEditor.getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return "";
      const node = sel.anchor.getNode();
      // Empty block ⇒ the anchor is a ParagraphNode, not a TextNode ⇒ no query.
      if (!$isTextNode(node)) return "";
      return node.getTextContent().slice(0, sel.anchor.offset);
    });
    setQuery(q);
    if (q !== lastQueryRef.current) {
      lastQueryRef.current = q;
      setActiveIndex(0);
    }
    // Re-derive focus from the DOM on every update, not just FOCUS/BLUR. The
    // forced flow focuses a FRESH block during mount (the gutter + arms a pending
    // focus), which can dispatch FOCUS_COMMAND before this hook's command
    // listener registers AND after the initial `focused` state was captured — a
    // race the trigger-char flow never hits (its block is already focused). The
    // caret-placement update that lands the focus fires this listener, so
    // recomputing here self-corrects the missed command.
    const root = lexicalEditor.getRootElement();
    setFocused(!!root && root.contains(document.activeElement));
  });

  useEffect(() => {
    sync();
    return lexicalEditor.registerUpdateListener(sync);
  }, [lexicalEditor, sync]);

  // Reset the active row on the CLOSE edge, so the next open always starts at
  // the top.
  //
  // `sync` resets only when the QUERY changes, which is the trigger-char flow's
  // reset: there, typing is what opens the menu, so a fresh open always brings a
  // fresh query. The forced flow breaks that coupling — `url-paste` force-opens
  // with the caret just past the link it inserted — never inside a text node
  // with text before it — so its query is `""` on every open and the reset
  // never fires: dismiss with row 3 highlighted, paste again, and the menu
  // reopens on row 3 with Enter committing it.
  //
  // Resetting on close rather than on open is what keeps this flash-free: while
  // `active` is false the surface is unmounted, so the write lands with nothing
  // rendered. Resetting on the open edge would paint one frame of the stale
  // highlight first, and hoisting it into render is the render-phase `setState`
  // this primitive exists to delete.
  const wasActive = useRef(opts.active);
  useEffect(() => {
    if (wasActive.current && !opts.active) {
      setActiveIndex(0);
      lastQueryRef.current = null;
    }
    wasActive.current = opts.active;
  }, [opts.active]);

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

  const valid = opts.isQueryValid ? opts.isQueryValid(query) : true;
  const open = opts.active && focused && valid;

  const dismiss = useEventCallback(() => opts.onDismiss?.());

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
