import {
  useImperativeHandle,
  useRef,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import type { EditableField } from "@plugins/primitives/plugins/editable-field/web";
import type {
  BlockEditorHandle,
  CaretSurface,
} from "@plugins/page/plugins/editor/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/** Any modifier turns an arrow into a selection/word move, never a surface crossing. */
function isModified(event: KeyboardEvent<HTMLInputElement>): boolean {
  return event.shiftKey || event.metaKey || event.ctrlKey || event.altKey;
}

/**
 * The page's big in-body title.
 *
 * It is one of the two caret surfaces of a page — the block list below it is the
 * other — and it implements the editor's own `CaretSurface` contract so the caret
 * can cross between them exactly as it crosses between two blocks. The traffic
 * runs both ways through that contract:
 *
 * - Downward (here): Enter, ArrowDown, and ArrowRight-at-the-end hand the caret to
 *   `body`, which is a `CaretSurface` too.
 * - Upward (there): ArrowUp, ArrowLeft-at-the-start, and Backspace-at-the-start of
 *   the first block resolve to a backwards `nav`, which the editor lands on this
 *   component via the `ref` the host passes as `<BlockEditor caretBefore>`.
 *
 * A title is a single line, so it exposes only the boundary landing: entering from
 * below always parks the caret at its end. Nothing here knows about blocks.
 */
export function PageTitle({
  field,
  body,
  ref,
}: {
  field: EditableField<string>;
  /** The caret surface below — the page body. Absent while the editor mounts. */
  body?: RefObject<BlockEditorHandle | null>;
  ref?: Ref<CaretSurface>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(
    ref,
    (): CaretSurface => ({
      focus: (opts) =>
        focusElement(inputRef.current, { reveal: opts?.scroll ?? false }),
      focusBoundary: (edge, opts) => {
        const el = inputRef.current;
        if (!el) return;
        focusElement(el, { reveal: opts?.scroll ?? false });
        const at = edge === "start" ? 0 : el.value.length;
        el.setSelectionRange(at, at);
      },
    }),
    [],
  );

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    const el = event.currentTarget;
    const atEnd =
      el.selectionStart === el.value.length &&
      el.selectionEnd === el.value.length;

    switch (event.key) {
      // Enter opens the top of the body for typing (creating a block if the page
      // has none) rather than inserting a newline into a one-line title. The
      // ensuing blur flushes the title's debounced save, so no keystroke is lost.
      case "Enter":
        event.preventDefault();
        body?.current?.insertFirstBlock();
        return;
      // Down always leaves a one-line surface; Right only once there is nothing
      // left of the title to walk past. A modified arrow is never a crossing —
      // shift extends the selection, meta/alt jump within the line.
      case "ArrowDown":
        if (isModified(event)) return;
        event.preventDefault();
        body?.current?.focusBoundary?.("start");
        return;
      case "ArrowRight":
        if (isModified(event) || !atEnd) return;
        event.preventDefault();
        body?.current?.focusBoundary?.("start");
        return;
    }
  }

  return (
    <input
      ref={inputRef}
      value={field.value}
      onChange={(e) => field.onChange(e.target.value)}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
      onKeyDown={onKeyDown}
      placeholder="Untitled"
      // Without this the field's accessible NAME is its placeholder, so every
      // page's title reads as "Untitled" no matter what it is called. The name
      // says which field this is; the value says what the page is called.
      aria-label="Page title"
      className="page-doc-title w-full truncate bg-transparent outline-none"
    />
  );
}
