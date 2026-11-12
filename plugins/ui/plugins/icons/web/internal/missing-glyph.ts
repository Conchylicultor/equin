import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { SpriteKey } from "../../core";

/**
 * An icon whose sprite is held but has no symbol for it: the build's icon
 * manifest missed a name the code draws (a generator bug the
 * `icons:manifest-covers-uses` check exists to catch before it ships).
 * `<Icon>` draws {@link MISSING_GLYPH_BODY} instead of an empty box.
 */
export interface IconMissingGlyph {
  /** The held sprite that lacks it. */
  sprite: SpriteKey;
  /** The `<symbol id>` asked for (`ms-<styleKey>-<name>`, `si-<name>`, …). */
  id: string;
}

/**
 * Where `<Icon>` reports an {@link IconMissingGlyph}. This plugin is a leaf
 * below the ui-kit and must not import `reports`, so a reports sub-plugin
 * (`reports/icon-missing-glyph`) registers the mapping to a report.
 */
export const iconMissingGlyphReportSink = defineReportSink<IconMissingGlyph>();

/** (sprite, id) pairs already reported on this page. */
const reported = new Set<string>();

/** Report `missing`, once per (sprite, id) per page. */
export function reportIconMissingGlyph(missing: IconMissingGlyph): void {
  const key = `${missing.sprite}\0${missing.id}`;
  if (reported.has(key)) return;
  reported.add(key);
  iconMissingGlyphReportSink.emit(missing);
}

/**
 * The missing-glyph marker, drawn inline in a 24-unit box: a dashed rounded
 * square crossed out — visibly broken, never mistaken for a loading box.
 */
export const MISSING_GLYPH_BODY =
  '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="2 2.5"/><path d="M9 9l6 6M15 9l-6 6"/></g>';
