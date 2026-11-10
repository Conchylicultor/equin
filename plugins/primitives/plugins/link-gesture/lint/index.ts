import noClickNavigate from "./no-click-navigate";
import noDiscardedLink from "./no-discarded-link";
import noDroppedGesture from "./no-dropped-gesture";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the link-gesture rules. The root `eslint.config.ts`
 * auto-discovers this default export and registers each rule repo-wide as
 * `error`.
 *
 * `no-click-navigate` is closed (no exemption is accepted): it fires only on a
 * callback whose WHOLE job is one navigating call, so a genuine non-link
 * escapes per site via
 * `// eslint-disable-next-line link-gesture/no-click-navigate -- reason`.
 *
 * `no-discarded-link` is closed too: a `LinkTarget` built and thrown away (a
 * statement, or the return of a `() => void` callback) never does anything.
 *
 * `no-dropped-gesture` is closed too: `PLAIN_GESTURE` in a clickable `on*`
 * handler is a link run through a callback, whatever the prop is called; a
 * genuine no-gesture handler escapes per site with a reason.
 */
export default {
  name: "link-gesture",
  rules: {
    "no-click-navigate": noClickNavigate,
    "no-discarded-link": noDiscardedLink,
    "no-dropped-gesture": noDroppedGesture,
  },
  closed: ["no-click-navigate", "no-discarded-link", "no-dropped-gesture"],
} satisfies LintContribution;
