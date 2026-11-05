import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";

interface Offender {
  file: string;
  dep: string;
  range: string;
}

const check: Check = {
  id: "no-plugin-workspace-deps",
  description:
    "Plugin package.jsons must not declare `workspace:*` deps — cross-plugin imports go through `@plugins/*` path aliases, not npm workspaces",
  async run(ctx: CheckContext) {
    const repo = await ctx.repo();
    const fileList = repo
      .glob("plugins/**/package.json")
      .filter((p) => p.endsWith("/package.json"));

    const offenders: Offender[] = [];
    for (const file of fileList) {
      const text = await repo.read(file);
      if (text === null) continue; // removed since the set was taken
      let json: {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      try {
        json = JSON.parse(text);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        continue;
      }
      for (const section of ["dependencies", "devDependencies"] as const) {
        const deps = json[section];
        if (!deps) continue;
        for (const [dep, range] of Object.entries(deps)) {
          if (typeof range === "string" && range.startsWith("workspace:")) {
            offenders.push({ file, dep, range });
          }
        }
      }
    }

    if (offenders.length === 0) return { ok: true };

    const lines = offenders.map((o) => `${o.file}: "${o.dep}": "${o.range}"`);
    return {
      ok: false,
      message: `workspace:* dep declared in ${offenders.length} plugin package.json(s):\n    ${lines.join("\n    ")}`,
      hint: "Remove the workspace dep. Plugins import each other via the `@plugins/*` tsconfig path alias — no package.json wiring needed. Adding a workspace dep also forces every umbrella to be listed in the root `workspaces` glob, which is brittle.",
    };
  },
};

export default check;
