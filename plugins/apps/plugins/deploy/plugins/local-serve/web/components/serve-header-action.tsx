import type { ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useManifestItemByName } from "@plugins/plugin-meta/plugins/composition/web";
import type { CompositionManifestItem } from "@plugins/plugin-meta/plugins/composition/core";
import {
  isServableCompositionId,
  isServed,
} from "@plugins/plugin-meta/plugins/composition/core";
import {
  useServeComposition,
  useServeStatus,
} from "@plugins/build/plugins/serve-composition/web";
import type { SiteProps } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const laptopIcon = symbol("laptop-mac");
const LABEL = "Test locally";

/**
 * **Test locally** in the site page's header: the composition served on this
 * checkout's gateway — opened when it is live, built and served when it is not.
 * The same decision as the list row's {@link ServeAction}, worded for a page.
 */
export function ServeHeaderAction({ deployment }: SiteProps): ReactElement {
  // Name → item: deploy is name-keyed, the serve namespace is the item's id.
  const item = useManifestItemByName(deployment.compositionId);
  if (!item) {
    return (
      <Button
        variant="ghost"
        disabled
        tooltip={`No composition named "${deployment.compositionId}" in the compositions config.`}
      >
        <Icon icon={laptopIcon} />
        {LABEL}
      </Button>
    );
  }
  return <ServeHeaderButton item={item} />;
}

function ServeHeaderButton({
  item,
}: {
  item: CompositionManifestItem;
}): ReactElement {
  const status = useServeStatus(item.id);
  const { setMode, rebuildNow } = useServeComposition();

  if (status.kind === "pending" || status.kind === "error") {
    return (
      <Button
        variant="ghost"
        disabled
        tooltip={
          status.kind === "pending"
            ? "Checking what is served locally…"
            : `Could not read the serve state: ${status.message}`
        }
      >
        <Icon icon={laptopIcon} />
        {LABEL}
      </Button>
    );
  }
  if (status.live.served) {
    return (
      <Button
        variant="ghost"
        tooltip={`Open ${status.url}`}
        render={
          <a href={status.url} target="_blank" rel="noopener noreferrer" />
        }
      >
        <Icon icon={laptopIcon} />
        {LABEL}
      </Button>
    );
  }
  // Main's composition is the one that can never be served: its namespace is
  // where this checkout's own `./equin build` deploys.
  const canServe = isServableCompositionId(item.id);
  return (
    <Button
      variant="ghost"
      disabled={!canServe}
      tooltip={
        canServe
          ? `Build & serve ${item.name} at ${status.url}`
          : "The main app is built by ./equin build — it is not served as a composition."
      }
      onClick={() => {
        // Already on with nothing served (the enabling build failed, or its
        // namespace was reclaimed): rebuild; off: record the intent and build.
        if (isServed(item.serve)) rebuildNow(item.id);
        else setMode(item.id, "manual");
      }}
    >
      <Icon icon={laptopIcon} />
      {LABEL}
    </Button>
  );
}
