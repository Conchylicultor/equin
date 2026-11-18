import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { insetClass } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  runsOf,
  runsLength,
  type Block,
  type BlockTextVariant,
} from "../../core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useBlockEditor } from "../block-editor-context";
import { BLOCK_INSET } from "../internal/page-column";
import {
  BLOCK_TEXT_ATTR,
  EMPTY_LINE_ATTR,
  staticDomRange,
  staticOffsetAtPoint,
  staticOffsetOfDomPoint,
  staticTextLength,
} from "../internal/static-text-geometry";
import { RunsRenderer, TOKEN_LENGTH_ATTR } from "./runs-renderer";
import { selectableText } from "./selectable-text";
import { TEXT_VARIANT_CLASS } from "./text-variant-class";

/**
 * Lexical's own styling of an editor root (`LexicalEditor.setRootElement`),
 * restated so the static line wraps and keeps spaces exactly as the live one.
 */
const ROOT_STYLE = { whiteSpace: "pre-wrap", wordBreak: "break-word" } as const;

/**
 * A DORMANT text block: its text as static DOM, in place of a live Lexical
 * editor (`internal/live-text-editors.ts` decides which blocks are live).
 *
 * The element tree mirrors what the live editor renders — the editable root's
 * box and classes, one `<p>`, the runs — so a line looks the same either way and
 * the swap moves nothing. The text is the row's (`data.text`): the content doc's
 * projection, the same text history and search read, and what another writer's
 * edit reaches this client through.
 *
 * It registers a DORMANT handle: the read half of a text block (its runs, where
 * a point or a span falls in it — the geometry of `static-text-geometry.ts`), so
 * a drag can anchor a span here and a span can be painted across it, plus
 * `wake`, which a caret landing calls through the caret authority's claim.
 *
 * Its own press: the text is selectable (`selectableText`), so a press here is
 * the browser's, as in a live editor; a drag that leaves the row becomes the
 * editor's span. A click — or a drag that stayed in the line — is the intent to
 * edit: the line wakes and the caret (or the selection) lands where the user
 * put it, once the editor's text is on screen.
 */
export function StaticBlockText({
  block,
  contentClassName,
  textVariant,
}: {
  block: Block;
  contentClassName?: ClassName;
  textVariant: BlockTextVariant;
}) {
  const { registerFocusHandle, liveTextEditors, selectText } = useBlockEditor();
  const rootRef = useRef<HTMLParagraphElement>(null);
  const runs = runsOf((block.data as Record<string, unknown> | null)?.text);
  const runsRef = useLatestRef(runs);
  const listeners = useRef(new Set<() => void>());

  // A painted span over this line follows its text: every committed change of
  // the runs is an update, as a live editor's commit is.
  useLayoutEffect(() => {
    listeners.current.forEach((l) => l());
  }, [runs]);

  useEffect(() => {
    const id = block.id;
    const root = () => rootRef.current;
    return registerFocusHandle(id, {
      wake: () => liveTextEditors.wake(id),
      readRuns: () => runsRef.current,
      offsetAtPoint: (x, y) => {
        const el = root();
        return el ? staticOffsetAtPoint(el, x, y) : null;
      },
      domRangeOf: (from, to) => {
        const el = root();
        return el ? staticDomRange(el, from, to) : null;
      },
      handOverAnchor: () => {
        const el = root();
        const sel = el?.ownerDocument.defaultView?.getSelection();
        if (!el || !sel || sel.rangeCount === 0 || !sel.anchorNode) return null;
        const offset = staticOffsetOfDomPoint(
          el,
          sel.anchorNode,
          sel.anchorOffset,
        );
        if (offset === null) return null;
        sel.removeAllRanges();
        return offset;
      },
      onTextUpdate: (listener) => {
        const set = listeners.current;
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      },
    });
  }, [block.id, registerFocusHandle, liveTextEditors, runsRef]);

  const onClick = (e: ReactMouseEvent) => {
    if (e.button !== 0 || e.defaultPrevented) return;
    const root = rootRef.current;
    if (!root) return;
    const target = e.target as Element;
    // A link opens and a chip acts on its own click, as they do in a live line.
    if (target.closest(`a, button, [${TOKEN_LENGTH_ATTR}]`)) return;
    const sel = root.ownerDocument.defaultView?.getSelection();
    const inLine =
      sel &&
      sel.rangeCount > 0 &&
      sel.anchorNode &&
      sel.focusNode &&
      root.contains(sel.anchorNode) &&
      root.contains(sel.focusNode);
    const anchor = inLine
      ? staticOffsetOfDomPoint(root, sel.anchorNode!, sel.anchorOffset)
      : null;
    const focus = inLine
      ? staticOffsetOfDomPoint(root, sel.focusNode!, sel.focusOffset)
      : null;
    const at =
      focus ??
      staticOffsetAtPoint(root, e.clientX, e.clientY) ??
      staticTextLength(root);
    selectText(block.id, anchor ?? at, at);
  };

  return (
    <div
      {...selectableText}
      data-static-text=""
      {...{ [BLOCK_TEXT_ATTR]: "" }}
      onClick={onClick}
      style={ROOT_STYLE}
      className={cn(
        "outline-none py-xs",
        insetClass({ r: BLOCK_INSET }),
        TEXT_VARIANT_CLASS[textVariant],
        contentClassName,
      )}
    >
      <p ref={rootRef}>
        {runsLength(runs) > 0 ? (
          <RunsRenderer value={runs} />
        ) : (
          <br {...{ [EMPTY_LINE_ATTR]: "" }} />
        )}
      </p>
    </div>
  );
}
