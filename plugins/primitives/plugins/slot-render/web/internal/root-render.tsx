import { Fragment } from "react";
import {
  Core,
  useRawContributions,
  type RootSlot,
} from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "./render-slot";

/**
 * The render path of `Core.Root` — what `.Render` is to a render slot, for the
 * framework's own root slot.
 *
 * `Core.Root` is declared by web-sdk, which sits below this plugin and so
 * cannot carry a `.Render` of its own; the page root (`web-core`'s `App.tsx`, a
 * composition root) mounts this instead. Every root mount then goes through
 * the SAME per-contribution path as every other slot: the contributed item
 * middlewares (error-boundary isolation, the element picker's portal-lineage
 * forwarding) and the contribution's box with its stamped attributes.
 *
 * What it deliberately is NOT:
 *
 * - **No list middleware → never reorderable.** Root mounts are hosts and
 *   observers (toasters, dialogs, the floating action bar), not a row the
 *   user curates; `renderIsolated` mounts no reorder area, so reorder's item
 *   middleware passes them through.
 * - **No layout cell.** The box is `display: contents`, and drawn only when
 *   something is stamped on it — so a root mount keeps whatever layout role it
 *   had when it was a bare child of the root.
 *
 * A `Core.Root({ slot })` entry mounts its capability's {@link RootSlot}
 * contributions the same way, each attributed to THAT slot (and its
 * contributing companion), so a pick names the capability that owns the mount.
 */
export function RenderCoreRoot() {
  const roots = useRawContributions(Core.Root);
  return (
    <>
      {roots.map((root, i) => {
        const slot = (root as { slot?: RootSlot }).slot;
        return (
          // Index keys: root mounts carry no id, and the list only grows (the
          // deferred tier appends), as before this went through slot-render.
          <Fragment key={i}>
            {slot ? (
              <RootSlotMounts slot={slot} />
            ) : (
              renderIsolated(Core.Root, root)
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function RootSlotMounts({ slot }: { slot: RootSlot }) {
  const mounts = useRawContributions(slot);
  return (
    <>
      {mounts.map((mount, i) => (
        <Fragment key={i}>{renderIsolated(slot, mount)}</Fragment>
      ))}
    </>
  );
}
