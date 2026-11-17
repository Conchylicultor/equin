import type { Check } from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { BUILD_SUB_STEP_IDS } from "@plugins/installer/core";

/**
 * Every build sub-step of the install (installer/core `BUILD_SUB_STEP_IDS`)
 * is begun by at least one profiler span of `./equin build`
 * (`installStep: "<id>"` in its span options). The tag is typed, so a typo is
 * a tsc error; this catches the other way to lose one: the span carrying it
 * deleted or its options dropped — the install would then show the sub-step
 * as skipped on every build.
 */
const check: Check = {
  id: "build-sub-steps-declared",
  inputKeyed: true,
  description:
    "Every install sub-step of the build is declared by a span of `./equin build` (installStep in its span options)",
  async run() {
    const root = await getWorktreeRoot();
    const matches = await grepCode({
      root,
      pattern: /installStep: "(build\.[a-z]+)"/,
      grepArg: 'installStep: "build.',
      fixed: true,
      // The id is the string literal itself.
      maskStrings: false,
    });
    const declared = new Set(
      matches.map((m) => /installStep: "(build\.[a-z]+)"/.exec(m.text)?.[1]),
    );
    const missing = BUILD_SUB_STEP_IDS.filter((id) => !declared.has(id));
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message: `no span of \`./equin build\` begins the install sub-step(s) ${missing.join(", ")}`,
      hint: "Tag the span that begins it: `buildProfilerStart(id, phase, label, { installStep: \"<id>\" })` (or the `hooks.span` options). A sub-step the build no longer has is removed from installer/core's BUILD_SUB_STEP_IDS, install.sh's plan and estimates.json together.",
    };
  },
};

export default check;
