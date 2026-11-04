import type { ReactNode } from "react";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";

/**
 * What a kind answers with.
 *
 * Every arm is a state the frame RENDERS — including `loading`, which is why
 * there is no "resolved to nothing yet" hole a kind could fill with what "no
 * counterpart" would look like.
 */
export type CounterpartResolution =
  | { status: "loading"; label?: string }
  | { status: "unresolved"; title: ReactNode; detail: ReactNode }
  | {
      status: "found";
      /** What it is (an exhibit's label / "App screen"). */
      title: string;
      /** Caption beside it (an exhibit's description / the owning app). */
      subtitle?: string;
      /** Identifier for the frame's tag (the ref, as declared). */
      badge?: string;
      /**
       * A URL that opens the counterpart on its own (an app screen's in-app
       * path, the page itself with its chrome, to navigate from) — absent for
       * one that is not a page.
       */
      href?: string;
      /**
       * Paint the counterpart at the canvas's logical `width` × `height`.
       * Called inside an error boundary.
       */
      render: (width: number, height: number) => ReactNode;
    };

/**
 * What a kind is handed. A kind is a real component — it may run hooks (load a
 * catalog, read the app registry) and it mounts inside the dispatch middleware's
 * error boundary — but its only output is `children(resolution)`: it paints no
 * layout of its own, so the frame's size stays the canvas's.
 */
export interface CounterpartKindProps {
  /** The tag before the colon — the dispatch key. */
  kind: string;
  /**
   * Everything after the first colon, trimmed, non-empty. (Not `ref`: that
   * name collides with React's `RefAttributes` on a `ComponentType`.)
   */
  target: string;
  meta: PrototypeMeta;
  /** Hand the frame the resolution. */
  children: (resolution: CounterpartResolution) => ReactNode;
}

/** The non-render fields every kind declares about itself. */
export interface CounterpartKindMeta {
  /** Heading for this kind of counterpart, e.g. "App exhibit". */
  label: string;
  /**
   * A COMPLETE example `content` value, e.g.
   * `exhibit:task-draft/composer`. The "declares nothing" copy lists
   * every kind's, so the syntax the reader is shown is the registry's, never a
   * hardcoded pair.
   */
  example: string;
}
