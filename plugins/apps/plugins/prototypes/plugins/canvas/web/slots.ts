import type { ReactNode } from "react";
import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import {
  defineDispatchSlot,
  defineWrapperSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import type {
  PrototypeMeta,
  PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { CanvasFrame } from "./internal/canvas-model";
import { UnknownFrameSource } from "./components/unknown-frame-source";

/**
 * What a frame source answers with. Every arm is a state the frame RENDERS —
 * `loading` included, so there is no "nothing yet" a source could fill with
 * what "nothing to show" looks like.
 */
export type FrameResolution =
  | { status: "loading"; label?: string }
  | { status: "unresolved"; title: ReactNode; detail: ReactNode }
  | {
      status: "found";
      /** The frame's tag in its header, e.g. "/agents · App screen". */
      tag: string;
      /**
       * A URL that opens what the frame shows on its own — for a source that is
       * a page (present's Open in a new tab). Absent for one that is not.
       */
      href?: string;
      /**
       * Paint it at the canvas's logical size. Called inside an error boundary,
       * so a crashing source costs its own frame, not the canvas.
       */
      render: (width: number, height: number) => ReactNode;
    };

/**
 * What a frame source is handed. A real component (it may run hooks), whose
 * only output is `children(resolution)`: it paints no layout of its own, so the
 * frame's size stays the canvas's.
 */
export interface FrameSourceProps {
  /** The contribution's id — the dispatch key. */
  source: string;
  meta: PrototypeMeta;
  children: (resolution: FrameResolution) => ReactNode;
}

/** The non-render fields a frame source declares. */
export interface FrameSourceMeta {
  /** The header's add button reads "+ <addLabel>", e.g. "Real app". */
  addLabel: string;
}

/**
 * Frames that are NOT the prototype: an open set. The canvas renders one
 * "+ <addLabel>" header button per contribution (disabled while that source is
 * on the canvas) and dispatches a source frame on its id — and names none of
 * them. The `compare` plugin contributes the real app a prototype mocks.
 */
export const FrameSource = defineDispatchSlot<
  FrameSourceProps,
  string,
  FrameSourceMeta
>({
  key: (p) => p.source,
  fallback: UnknownFrameSource,
  docLabel: (c) => c.addLabel,
});

/** One frame's actions are handed the frame and the prototype. */
export interface FrameActionRow {
  frame: CanvasFrame;
  meta: PrototypeMeta;
}

/**
 * The hover actions in a frame's header (keep only, close…). The
 * canvas ships those two; the `present` plugin adds Present.
 */
export const PrototypeFrameActions = defineItemActions<FrameActionRow>();

/**
 * Per-row actions on the version list (the popover behind a frame's version
 * label). The canvas ships one — open the conversation whose turn recorded the
 * version.
 */
export const PrototypeVersionActions = defineItemActions<PrototypeVersion>();

/**
 * Wrappers folded around everything under a `PrototypeDetailProvider` — the
 * pane's header and canvas, or a page's own canvas — inside the provider, so
 * they read the canvas. For state that must outlive one frame's subtree, which
 * a layout change remounts: the `present` plugin holds the open presentation
 * here, so adding a frame from it keeps it open.
 */
export const PrototypeDetailWrap = defineWrapperSlot();
