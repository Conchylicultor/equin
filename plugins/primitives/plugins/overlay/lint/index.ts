import publishesPopup from "./publishes-popup";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for overlays: every popup publishes its open state to
 * `popup-open`, so the page knows one is open (hover chrome, hints, and the
 * reload policy's engagement signal).
 */
export default {
  name: "overlay",
  rules: {
    "publishes-popup": publishesPopup,
  },
} satisfies LintContribution;
