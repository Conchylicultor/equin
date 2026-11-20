import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { ThemeId } from "../../core";

/**
 * Something the theme painter could not paint as stored — never silent, but
 * never fatal either: it paints what it can and says so here.
 *
 * - `missing-theme` — a scope selects a theme that does not exist (a
 *   hand-edited config file; the delete endpoint refuses to orphan a
 *   selection). The scope paints Default.
 * - `unregistered-group` / `unknown-tokens` — a stored theme carries values
 *   for a token group, or tokens, the code no longer declares. They are
 *   dropped and the rest of the theme paints.
 */
export type ThemeResolutionFault =
  | { kind: "missing-theme"; scopeId: string | undefined; themeId: ThemeId }
  | { kind: "unregistered-group"; themeId: ThemeId; groupId: string }
  | {
      kind: "unknown-tokens";
      themeId: ThemeId;
      groupId: string;
      tokens: string[];
    };

/**
 * Where the painter reports a `ThemeResolutionFault`. Theme-engine must not
 * import `reports`, so a reports sub-plugin registers the mapping to a report.
 */
export const themeResolutionReportSink = defineReportSink<ThemeResolutionFault>(
  "ui/plugins/theme-engine:themeResolutionReportSink",
);
