import {
  useManifestActions,
  useManifestItems,
} from "@plugins/plugin-meta/plugins/composition/web";
import { isServed } from "@plugins/plugin-meta/plugins/composition/core";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { serveCompositionEndpoint } from "@plugins/build/core";
import { showToast } from "@plugins/shell/plugins/toast/web";

/**
 * The serve capability for a composition: persist the `serve` mode, and run the
 * builds that make it true.
 *
 * Both actions POST the same endpoint, which runs
 * `./singularity build --composition <id>` in the checkout this backend belongs
 * to — so the live URL is `<id>.<checkout>.localhost:9000` and it is ready when
 * that build ends. `useEndpointMutation` auto-toasts endpoint errors (e.g. the
 * server's 400 for a composition that can never be served), so there is no
 * `onError`.
 */
export function useServeComposition(): {
  setMode: (id: string, mode: string) => void;
  rebuildNow: (id: string) => void;
} {
  const items = useManifestItems();
  const { setServeMode } = useManifestActions();
  const build = useEndpointMutation(serveCompositionEndpoint);

  /**
   * Start a serve build of `id`; `false` when this host cannot build at all.
   *
   * The endpoint is desktop-only (a build spawns `./singularity build` in this
   * checkout), so under a transport with no computer behind it the mutation is
   * unavailable — said in a toast, never a silent no-op behind a "Building…"
   * one.
   */
  const startBuild = (id: string): boolean => {
    if (build.kind === "unavailable") {
      showToast({
        title: `Can't build “${id}”`,
        description: build.message,
        variant: "error",
      });
      return false;
    }
    build.mutate({ body: { composition: id } });
    return true;
  };

  /**
   * Write the mode, and build only on the edge that mints the namespace.
   *
   * Coming off `"off"` is the FIRST claim of the namespace: nothing is there
   * yet, so the mode alone would leave a serve intent pointing at an address
   * that 502s. Moving between two served modes writes config only — the
   * namespace is already live, and the mode says nothing about the dist it is
   * serving, only about when it may be refreshed. Building there would rebuild
   * on every click of the picker.
   *
   * Turning it OFF stops nothing by itself: it records that the composition is
   * no longer meant to be live, and the namespace keeps serving its last dist —
   * deliberately, since deactivation is never a reclaim trigger. Deleting the
   * composition is what reclaims it (`useDeleteComposition`).
   */
  const setMode = (id: string, mode: string): void => {
    const item = items.find((it) => it.id === id);
    if (item === undefined) {
      // A mode written for a row that is not in the manifest is a broken
      // invariant, not an input: every caller holds the item it is acting on.
      throw new Error(`No composition "${id}" in the manifest.`);
    }
    const claimsNamespace = !isServed(item.serve) && isServed(mode);
    setServeMode(id, mode);
    if (!claimsNamespace) return;
    if (!startBuild(id)) return;
    showToast({
      title: `Building & serving “${id}”…`,
      description:
        "Running a build of this checkout; the live URL will be ready shortly.",
      variant: "info",
    });
  };

  /**
   * Build this composition now, whatever the mode says — including `push` and
   * the cadences.
   *
   * The automatic gate compares this checkout's HEAD against the commit the
   * namespace was built from, so it is blind to an edit of the composition's OWN
   * manifest row: changing its contributors, entry points or `extends` changes
   * what should be served without moving HEAD. This button is the escape hatch
   * for exactly that, which is why no mode hides it.
   */
  const rebuildNow = (id: string): void => {
    if (!startBuild(id)) return;
    showToast({
      title: `Rebuilding “${id}”…`,
      description:
        "Running a build of this checkout; the live URL updates when it ends.",
      variant: "info",
    });
  };

  return { setMode, rebuildNow };
}
