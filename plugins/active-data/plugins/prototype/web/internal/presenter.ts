import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { prototypesList } from "@plugins/apps/plugins/prototypes/plugins/files/core";
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
 * The link to the mock: a column to the RIGHT of the surface holding the id
 * (`push`), so the conversation stays beside it: `/agents/c/<convId>/proto/proto-…`.
 */
export function usePrototypeTarget(): (id: string) => LinkTarget {
  const openPane = useOpenPane();
  return (id) =>
    openPane.to(prototypeDetailPane, { name: id }, { mode: "push" });
}
