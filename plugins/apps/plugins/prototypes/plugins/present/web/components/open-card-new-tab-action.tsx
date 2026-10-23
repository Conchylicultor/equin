import type { ReactElement } from "react";
import { embedUrl } from "@plugins/primitives/plugins/embed/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import type { PrototypeGalleryRow } from "@plugins/apps/plugins/prototypes/plugins/gallery/web";
import { presentPath } from "../internal/routes";

/**
 * "Open in a new tab" on a gallery card (a revealed card action): the
 * prototype's live folder as its chromeless present page at the Responsive
 * size — what the canvas's frame A opens with the same action — so the card
 * opens straight into the page, filling the tab at its own width. The shared
 * picks record applies, as on frame A.
 */
export function OpenCardNewTabAction({
  row,
}: ItemActionProps<PrototypeGalleryRow>): ReactElement {
  const href = embedUrl(
    presentPath({
      name: row.name,
      sha: undefined,
      picks: undefined,
      size: { kind: "responsive" },
    }),
    "chromeless",
  );
  return (
    <ControlSizeProvider size="sm">
      <NewTabButton href={href} label="Open in a new tab" />
    </ControlSizeProvider>
  );
}
