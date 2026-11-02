import type { ComponentType } from "react";
import type {
  Contribution,
  Slot,
} from "@plugins/framework/plugins/web-sdk/core";
import { useConfig } from "@plugins/config_v2/web";
import { useAppSettingsScope } from "@plugins/apps-core/plugins/theme-scope/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { VariantRegionCore } from "../../core";
import type { VariantContribution } from "../slots";

/**
 * What a surface may say to a region it hosts: `variant` pins the variant (its
 * `match` id) for this one surface, whatever the scope's config picked — for a
 * surface whose design names one look while the rest of its app follows the
 * theme. An id no installed variant matches throws: a pin that silently fell
 * back to the configured look would be indistinguishable from no pin.
 */
export interface VariantRegionPin {
  variant?: string;
}

/**
 * The live chrome host. Reads the active variant from config scoped to the app
 * whose theme the region wears (`useAppSettingsScope`: a pane's home app, not
 * the app hosting it), falling back transparently to base when that app is not
 * forked — unless the surface pins one (`VariantRegionPin`) — then dispatches
 * to the matching variant via `renderIsolated`.
 */
export function createRegion<Props>(
  core: VariantRegionCore<Props>,
  slot: Slot<VariantContribution<Props>>,
): ComponentType<Props & VariantRegionPin> {
  function Region({ variant: pinned, ...props }: Props & VariantRegionPin) {
    const contributions = slot.useContributions();
    const appScope = useAppSettingsScope();
    const scopeId = core.scope === "app" ? appScope : undefined;
    const { variant: configured } = useConfig(core.config, { scopeId });
    const activeId = pinned ?? configured;
    const active =
      contributions.find((c) => c.match === activeId) ??
      (pinned === undefined ? (contributions[0] ?? null) : null);
    if (pinned !== undefined && !active) {
      throw new Error(
        `${core.id}: the surface pins variant "${pinned}", but no installed variant matches it (have: ${contributions.map((c) => c.match).join(", ")})`,
      );
    }
    if (!active) return null;
    return renderIsolated(
      slot,
      active as unknown as Contribution,
      props as object,
    );
  }
  return Region;
}
