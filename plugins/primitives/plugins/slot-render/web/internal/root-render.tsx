import { Fragment } from "react";
import {
  Core,
  useRawContributions,
  type RootContribution,
  type RootScope,
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
  return <RootMounts inScope={false} />;
}

/**
 * The root hosts a `<PluginScope>` mounts inside itself: only the
 * `scope: "each"` ones (`RootScope`), each read through the scope's registry —
 * so a scope is served by hosts of its own, reading its contributions, its
 * transport and its id. The page root hands it to `PluginProvider`'s
 * `scopeRoots`; the scope renders it.
 */
export function RenderScopeRoot() {
  return <RootMounts inScope />;
}

// Whether a mount runs here: at the page root every one does; inside a scope
// only those declared `"each"`.
function mountsHere(scope: RootScope, inScope: boolean): boolean {
  return !inScope || scope === "each";
}

function RootMounts({ inScope }: { inScope: boolean }) {
  const roots = useRawContributions(Core.Root);
  return (
    <>
      {roots.map((root, i) => {
        const { slot, scope } = root as Partial<RootContribution>;
        // Index keys: root mounts carry no id, and the list only grows (the
        // deferred tier appends), as before this went through slot-render.
        if (slot) {
          return (
            <Fragment key={i}>
              <RootSlotMounts slot={slot} inScope={inScope} />
            </Fragment>
          );
        }
        return (
          <Fragment key={i}>
            {mountsHere(scope!, inScope) && renderIsolated(Core.Root, root)}
          </Fragment>
        );
      })}
    </>
  );
}

function RootSlotMounts({
  slot,
  inScope,
}: {
  slot: RootSlot;
  inScope: boolean;
}) {
  const mounts = useRawContributions(slot);
  return (
    <>
      {mounts.map((mount, i) => (
        <Fragment key={i}>
          {mountsHere(
            (mount as Partial<{ scope: RootScope }>).scope!,
            inScope,
          ) && renderIsolated(slot, mount)}
        </Fragment>
      ))}
    </>
  );
}
