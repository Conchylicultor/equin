import type { CheckContext } from "@plugins/framework/plugins/tooling/core";
import { relative } from "path";
import {
  renderServerContributors,
  renderWebListEntries,
  renderWebLists,
  formatGenerated,
  codegenPassOver,
  webListEntriesPath,
  webListsPath,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(ctx: CheckContext): Promise<CheckResult>;
};

// One declared-web-list row as `renderWebLists` writes it (one JSON object a
// line). Parsing the two strings the check already holds is what makes the
// newly-reorderable report free — no second scan, no barrel import.
interface ListRow {
  id: string;
  plugin: string;
  key: string;
  meta: { reorderable: boolean };
}

function parseLists(file: string): ListRow[] {
  return file
    .split("\n")
    .filter((l) => l.startsWith('  {"id":'))
    .map((l) => JSON.parse(l.trim().replace(/,$/, "")) as ListRow);
}

// The override a reorderable list owes, at the path config_v2 derives for it:
// the DECLARING plugin's path joined with the list's declaration key.
// `./equin build` SEEDS it — naming it here is the zero-build heads-up.
function overridePathFor(row: ListRow): string {
  return `config/${asPath(asPluginId(row.plugin))}/${row.key}.jsonc`;
}

const check: Check = {
  id: "list-catalog-in-sync",
  description:
    "The list catalog's files match the code: every declared web list (list-catalog web-lists.generated.ts) and every web list entry's fact (server-core web-list-entries.generated.json); who contributes to which server list (contributors.generated.ts), every server data list's entries (list-entries.generated.ts) and the lists each supervised job reads (job-reads.generated.ts)",
  async run(ctx) {
    const repo = await ctx.repo();
    const pass = codegenPassOver(repo);
    const root = pass.root;
    const files = [
      { file: webListsPath(root), content: await renderWebLists(pass) },
      {
        file: webListEntriesPath(root),
        content: await renderWebListEntries(pass),
      },
      ...(await renderServerContributors(pass)),
    ];
    for (const { file, content } of files) {
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
      if (written === expected) continue;
      // A list newly reorderable owes an authored config override: name it.
      const owedBy =
        file === webListsPath(root)
          ? (() => {
              const had = new Set(
                parseLists(written)
                  .filter((r) => r.meta.reorderable)
                  .map((r) => r.id),
              );
              return parseLists(expected).filter(
                (r) => r.meta.reorderable && !had.has(r.id),
              );
            })()
          : [];
      return {
        ok: false,
        message:
          `${rel} is out of sync with the plugins' declarations` +
          (owedBy.length === 0
            ? ""
            : `\n\n${owedBy.length} newly reorderable list(s) will each owe an authored config override:\n` +
              owedBy.map((r) => `    ${overridePathFor(r)}`).join("\n")),
        hint:
          "Run `./equin build` and commit the regenerated file." +
          (owedBy.length > 0
            ? " The build also SEEDS each override listed above with a `// @review` marker: arrange its `items` for how" +
              " the list renders, then delete that marker line (`config:overrides-authored` fails until you do). If a" +
              " listed slot's order should never be user-curated, it is headless — declare it with `defineMountSlot`."
            : ""),
      };
    }
    return { ok: true };
  },
};

export default check;
