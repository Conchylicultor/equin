import type { ComponentType } from "react";
import type {
  Contribution,
  Slot,
} from "@plugins/framework/plugins/web-sdk/core";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { DynamicEnum } from "@plugins/fields/plugins/dynamic-enum/plugins/config/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import type { VariantRegionCore } from "../core";
import type { VariantContribution } from "./slots";
import {
  createRegion,
  type VariantRegionPin,
} from "./components/variant-region-host";
import { createPicker } from "./components/variant-region-picker";

export interface VariantRegionWeb<Props> {
  /** Slot each variant sub-plugin contributes to: `ui.variant-region.<id>.variant`. */
  readonly Variant: Slot<VariantContribution<Props>>;
  /** The live chrome host. Reads the per-app variant (or the surface's pin,
   *  `VariantRegionPin`) and dispatches to it. */
  readonly Region: ComponentType<Props & VariantRegionPin>;
  /** The settings picker rendered in the theme-customizer (scope-aware). */
  readonly Picker: ComponentType;
  /**
   * Spread into the consuming plugin's `contributions`:
   * config web-registration, dynamic-enum options, and the customizer picker.
   */
  readonly contributions: Contribution[];
}

export function defineVariantRegionWeb<Props>(
  core: VariantRegionCore<Props>,
): VariantRegionWeb<Props> {
  const Variant = defineSlot<VariantContribution<Props>>({
    docLabel: (p) => p.label,
  });

  const Region = createRegion(core, Variant);
  const Picker = createPicker(core, Variant);

  const contributions: Contribution[] = [
    ConfigV2.WebRegister({ descriptor: core.config }),
    DynamicEnum.Options({
      field: core.variantField,
      useOptions: () =>
        Variant.useContributions().map((v) => ({
          value: v.id,
          label: v.label,
        })),
    }),
    ThemeEngine.VariantGroup({
      id: core.id,
      componentLabel: core.label,
      component: Picker,
    }),
  ];

  return { Variant, Region, Picker, contributions };
}
