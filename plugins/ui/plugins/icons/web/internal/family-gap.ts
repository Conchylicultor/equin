import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { IconFamilyId, SymbolName } from "../../core";

/**
 * A symbol drawn in the scope of a strict family that does not map it: the
 * scope shows the family's gap glyph instead. Every one is a name the family
 * still has to draw.
 */
export interface IconFamilyGap {
  family: IconFamilyId;
  name: SymbolName;
}

/**
 * Where `<Icon>` reports an {@link IconFamilyGap}. This plugin is a leaf below
 * the ui-kit and must not import `reports`, so a reports sub-plugin registers
 * the mapping to a report (the same inversion the theme painter uses).
 */
export const iconFamilyGapReportSink = defineReportSink<IconFamilyGap>();

/** (family, name) pairs already reported on this page. */
const reported = new Set<string>();

/** Report `gap`, once per (family, name) per page. */
export function reportIconFamilyGap(gap: IconFamilyGap): void {
  const key = `${gap.family}\0${gap.name}`;
  if (reported.has(key)) return;
  reported.add(key);
  iconFamilyGapReportSink.emit(gap);
}
