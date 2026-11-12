import noTransitionAll from "./no-transition-all";
import noUnanimatedSurfaceExit from "./no-unanimated-surface-exit";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the motion primitive. The root `eslint.config.ts`
 * auto-discovers this default export and registers each rule repo-wide as
 * `error`.
 *
 * `no-unanimated-surface-exit` rejects a floating surface mounted by a bare
 * conditional (`{open && <Pin layer="float">…}`), which vanishes in one frame
 * — the conditional belongs inside `<Presence>`. A genuine exception is
 * declared by the owning plugin in its `exempt/index.ts`.
 *
 * `no-transition-all` rejects a `transition-all` class: it animates layout
 * properties, so a box its host measures is read mid-transition and
 * re-decided every frame — name the properties that move.
 */
export default {
  name: "motion",
  rules: {
    "no-transition-all": noTransitionAll,
    "no-unanimated-surface-exit": noUnanimatedSurfaceExit,
  },
} satisfies LintContribution;
