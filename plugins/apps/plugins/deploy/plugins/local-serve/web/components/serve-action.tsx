import type { ReactElement } from "react";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useManifestItemByName } from "@plugins/plugin-meta/plugins/composition/web";
import type { CompositionManifestItem } from "@plugins/plugin-meta/plugins/composition/core";
import {
  useServeComposition,
  useServeStatus,
} from "@plugins/build/plugins/serve-composition/web";
import type { Deployment } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import {
  isServableCompositionId,
  isServed,
} from "@plugins/plugin-meta/plugins/composition/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";

const boltIcon = symbol("bolt");

/**
 * The **serve** shortcut on a deployments row: one button that opens the
 * composition's local namespace when it is live, and starts serving it when it
 * is not.
 *
 * One button rather than two, because from the row there is exactly one thing
 * anyone wants — *look at this app locally* — and whether that costs a build is
 * a fact the row already knows. It never links to a namespace that is not
 * actually served: the state comes from the `composition.json` marker, not from
 * the `serve` mode, which is intent.
 */
export function ServeAction({
  row,
}: ItemActionProps<Deployment>): ReactElement {
  // Name → item, because deploy is name-keyed and the serve namespace is the
  // item's id (they diverge for UI-created compositions).
  const item = useManifestItemByName(row.compositionId);

  if (!item) {
    return (
      <IconButton
        icon={boltIcon}
        label="Serve locally"
        tooltip={`No composition named "${row.compositionId}" in the compositions config.`}
        disabled
      />
    );
  }
  return <ServeRowAction item={item} />;
}

/**
 * Split out so the liveness read happens only once there is a composition to
 * read it for — a hook cannot be called after an early return.
 */
function ServeRowAction({
  item,
}: {
  item: CompositionManifestItem;
}): ReactElement {
  const status = useServeStatus(item.id);
  const { setMode, rebuildNow } = useServeComposition();

  if (status.kind === "pending") {
    return (
      <IconButton
        icon={boltIcon}
        label="Serve locally"
        tooltip="Checking what is served locally…"
        disabled
      />
    );
  }
  if (status.kind === "error") {
    return (
      <IconButton
        icon={boltIcon}
        label="Serve locally"
        tooltip={`Could not read the serve state: ${status.message}`}
        disabled
      />
    );
  }

  if (status.live.served) {
    // The url is a property of the STATUS, not of the liveness arm: the server
    // resolves it from its own checkout whether anything is served there or not.
    const { url } = status;
    return (
      <NewTabButton
        href={url}
        label="Open the local serve"
        tooltip={`Open ${url}`}
      />
    );
  }
  // The only composition that can never be served: main's, whose namespace is
  // where this checkout's own `./singularity build` deploys. Every other one is
  // servable from wherever you are — a serve is an ordinary build of THIS
  // checkout now, not a stage inside main's, so there is no backend-shaped
  // refusal left to render.
  const canServe = isServableCompositionId(item.id);
  return (
    <IconButton
      icon={boltIcon}
      label="Serve locally"
      tooltip={
        canServe
          ? // `status.url` is server-resolved: a composition served from a
            // worktree lives at `<id>.<checkout>.localhost:9000`.
            `Build & serve ${item.name} at ${status.url}`
          : "The main app is built by ./singularity build — it is not served as a composition."
      }
      disabled={!canServe}
      onClick={(e) => {
        e.stopPropagation();
        // Two ways to reach the same wanted end state — the app live locally —
        // and which one applies is whether the serve mode is already on. Off:
        // `setMode` records the intent and runs the build that claims the
        // namespace. Already on with nothing served (the enabling build failed,
        // or its namespace was reclaimed): the mode is already what it should
        // be, so writing it again would build nothing — this is exactly the
        // case `rebuildNow` exists for. Both toast the running build, so the row
        // adds no toast of its own.
        if (isServed(item.serve)) rebuildNow(item.id);
        else setMode(item.id, "manual");
      }}
    />
  );
}
