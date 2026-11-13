import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";
import { readWorkspace } from "@plugins/infra/plugins/deps/plugins/npm/core";

const check: Check = {
  id: "no-plugin-workspace-deps",
  description:
    "Plugin package.jsons must not declare `workspace:*` deps — cross-plugin imports go through `@plugins/*` path aliases, not npm workspaces",
  async run(ctx: CheckContext) {
    // The workspace as the npm checks read it: every manifest a plugin record,
    // so a pass parses only the package.jsons it has not folded yet.
    const { declared } = await readWorkspace(await ctx.repo());
    const offenders = declared.filter(
      (d) =>
        d.manifest.startsWith("plugins/") &&
        d.section !== "optionalDependencies" &&
        d.raw.startsWith("workspace:"),
    );

    if (offenders.length === 0) return { ok: true };

    const lines = offenders.map(
      (o) => `${o.manifest}: "${o.name}": "${o.raw}"`,
    );
    return {
      ok: false,
      message: `workspace:* dep declared in ${offenders.length} plugin package.json(s):\n    ${lines.join("\n    ")}`,
      hint: "Remove the workspace dep. Plugins import each other via the `@plugins/*` tsconfig path alias — no package.json wiring needed. Adding a workspace dep also forces every umbrella to be listed in the root `workspaces` glob, which is brittle.",
    };
  },
};

export default check;
