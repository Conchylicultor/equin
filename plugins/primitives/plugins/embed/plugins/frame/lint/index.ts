import noRawFrame from "./no-raw-frame";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

/**
 * Lint barrel for the framing primitive: every frame goes through it, so
 * untrusted content cannot be framed on an app origin by hand. `noDebt`: a
 * raw frame is migrated, never tracked — the primitive's own file is the one
 * sanctioned exemption.
 */
export default {
  name: "frame",
  rules: {
    "no-raw-frame": noRawFrame,
  },
  noDebt: ["no-raw-frame"],
} satisfies LintContribution;
