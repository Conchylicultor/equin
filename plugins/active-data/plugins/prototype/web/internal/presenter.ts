import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  paneTarget,
  type PaneTarget,
} from "@plugins/primitives/plugins/pane/web";
import {
  humanizeToken,
  parseVariantQuery,
  prototypesList,
  variantParam,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { prototypeDetailPane } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import type { IdReferentState } from "@plugins/ids/web";

/**
 * The prototype presenter's referent read. Free: `prototypesList` is a live,
 * app-wide list re-broadcast on every file change under the prototypes dir, so
 * a transcript full of ids costs no requests and a label follows a `<title>`
 * edit live.
 */
export function usePrototypeReferent(id: string): IdReferentState {
  return foldResource(useLive(prototypesList), {
    loading: (): IdReferentState => ({ status: "loading" }),
    error: (error): IdReferentState => ({ status: "failed", error }),
    ready: (prototypes): IdReferentState => {
      const meta = prototypes.find((p) => p.name === id);
      return meta
        ? { status: "found", title: meta.title }
        : { status: "missing" };
    },
  });
}

/**
 * The mock's pane: a column to the RIGHT of the surface holding the id, so the
 * conversation stays beside it: `/agents/c/<convId>/proto/proto-…`.
 */
export function usePrototypePane(id: string): PaneTarget {
  return paneTarget(prototypeDetailPane, { name: id });
}

/**
 * The pane of a chip that names a variant after the id
 * (`proto-…?pane=floating`): the mock opened on that variant — frame A shows
 * it, and the user's own picks are left as they are. Written with no variant,
 * the plain {@link usePrototypePane}.
 */
export function usePrototypeVariantPane(
  id: string,
  written: string,
): PaneTarget {
  return paneTarget(
    prototypeDetailPane,
    written === ""
      ? { name: id }
      : { name: id, variant: variantParam(parseVariantQuery(written)) },
  );
}

/** A written variant as a chip adds it to the title: its values, humanized ("Floating · #10b981"). */
export function prototypeVariantLabel(written: string): string {
  return Object.values(parseVariantQuery(written))
    .map((v) => (v.startsWith("#") ? v : humanizeToken(v)))
    .join(" · ");
}
