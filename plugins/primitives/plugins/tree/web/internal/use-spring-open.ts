import { useEffect, useMemo, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import type { ExpandChange } from "../../core";

/** How long a drag must rest on a closed folder before it springs open —
 *  Finder's and VS Code's range. */
export const SPRING_OPEN_MS = 700;

/** The spring-open controls a renderer's drop handlers call. Stable identity. */
export interface SpringOpen {
  /**
   * A drag is over row `id` (or over no row: `null`). Starts that row's timer
   * when `springable` (closed, and it has or may have children) and it is a
   * new row; a different row, or `null`, cancels the running one. Called on
   * every `dragover` — the same row again is a no-op.
   */
  hover: (id: string | null, springable: boolean) => void;
  /**
   * The drag ended: dropped on row `id`, or anywhere else (`null`). Every row
   * this drag sprang open closes again — except those the drop landed in (the
   * row itself or one of its ancestors that sprang). A drag that ends with no
   * drop of ours (cancelled, dropped outside) closes them through the
   * document's `dragend`.
   */
  end: (droppedOn: string | null) => void;
}

/**
 * Spring-loaded folders for a drag over a tree: rest on a closed folder for
 * `delayMs` and it opens (one `setExpanded` write, which lists a lazy folder
 * as any open does); when the drag ends, the folders it opened close again
 * unless the drop landed inside them — as Finder and VS Code do.
 *
 * Timer based, not polling: one `setTimeout` per hovered row, cleared by the
 * first `dragenter` / `dragover` anywhere outside that row (a capture listener, held only
 * while the timer runs). The end of a drag that dropped nowhere
 * of ours is the document's `dragend` (listened for only while a folder this
 * drag opened is waiting to close).
 */
export function useSpringOpen(args: {
  delayMs?: number;
  setExpanded: (changes: readonly ExpandChange[]) => void | Promise<void>;
  /** Is `id` the row `ancestorId` or below it? */
  isWithin: (id: string, ancestorId: string) => boolean;
}): SpringOpen {
  const latest = useLatestRef(args);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<string | null>(null);
  const sprung = useRef<string[]>([]);
  const onDocumentEnd = useRef<(() => void) | null>(null);
  const onDocumentOver = useRef<((e: DragEvent) => void) | null>(null);

  const spring = useMemo<SpringOpen>(() => {
    const cancel = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (onDocumentOver.current) {
        document.removeEventListener("dragenter", onDocumentOver.current, true);
        document.removeEventListener("dragover", onDocumentOver.current, true);
        onDocumentOver.current = null;
      }
    };
    const end = (droppedOn: string | null) => {
      cancel();
      current.current = null;
      if (onDocumentEnd.current) {
        document.removeEventListener("dragend", onDocumentEnd.current);
        onDocumentEnd.current = null;
      }
      const opened = sprung.current;
      sprung.current = [];
      const close = opened.filter(
        (id) => droppedOn === null || !latest.current.isWithin(droppedOn, id),
      );
      if (close.length > 0) {
        void latest.current.setExpanded(
          close.map((id) => ({ id, expanded: false })),
        );
      }
    };
    const hover = (id: string | null, springable: boolean) => {
      if (id === current.current) return;
      cancel();
      current.current = id;
      if (id === null || !springable) return;
      // The hover ends when the drag enters or is over anything that is not this row.
      // Not `dragleave`: it also fires crossing the row's own children (with
      // no `relatedTarget` in Chromium), and a drag resting there sends no
      // further `dragover` to restart the timer it cancelled.
      const onOver = (e: DragEvent) => {
        const over =
          e.target instanceof Element
            ? e.target.closest("[data-tree-row]")?.getAttribute("data-tree-id")
            : undefined;
        if (over === id) return;
        cancel();
        current.current = null;
      };
      onDocumentOver.current = onOver;
      document.addEventListener("dragenter", onOver, true);
      document.addEventListener("dragover", onOver, true);
      timer.current = setTimeout(() => {
        cancel();
        sprung.current = [...sprung.current, id];
        if (onDocumentEnd.current === null) {
          const onEnd = () => end(null);
          onDocumentEnd.current = onEnd;
          document.addEventListener("dragend", onEnd);
        }
        void latest.current.setExpanded([{ id, expanded: true }]);
      }, latest.current.delayMs ?? SPRING_OPEN_MS);
    };
    return { hover, end };
  }, [latest]);

  // An unmounted tree leaves no timer or listener behind.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (onDocumentOver.current) {
        document.removeEventListener("dragenter", onDocumentOver.current, true);
        document.removeEventListener("dragover", onDocumentOver.current, true);
      }
      if (onDocumentEnd.current) {
        document.removeEventListener("dragend", onDocumentEnd.current);
      }
    },
    [],
  );

  return spring;
}
