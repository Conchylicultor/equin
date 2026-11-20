import type { CheckContext } from "@plugins/framework/plugins/tooling/core";
import { relative } from "path";
import {
  renderServerContributors,
  formatGenerated,
  codegenPassOver,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(ctx: CheckContext): Promise<CheckResult>;
};

const check: Check = {
  id: "server-contributors-in-sync",
  description:
    "The build's server-list files match the code: who contributes to which list (server-core contributors.generated.ts), every data list's entries (server-core list-entries.generated.ts) and the lists each supervised job reads (supervised-job job-reads.generated.ts)",
  async run(ctx) {
    const repo = await ctx.repo();
    const pass = codegenPassOver(repo);
    const root = pass.root;
    for (const { file, content } of await renderServerContributors(pass)) {
      const rel = relative(root, file);
      const written = await repo.read(rel);
      if (written === null) {
        return {
          ok: false,
          message: `${rel} is missing`,
          hint: "Run `./equin build` to generate it.",
        };
      }
      const expected = await formatGenerated({ file, content });
      if (written !== expected) {
        return {
          ok: false,
          message: `${rel} is out of sync with the server barrels and supervised jobs`,
          hint: "Run `./equin build` and commit the regenerated file.",
        };
      }
    }
    return { ok: true };
  },
};

export default check;
