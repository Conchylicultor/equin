import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  loadExemptions,
  type ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";

function groupBy<T>(
  items: readonly T[],
  key: (t: T) => string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  }
  return out;
}

const byText = (a: string, b: string): number => a.localeCompare(b);

/** `./singularity exempt list`: a pure read of the manifests, no op, no grant. */
const run: CliAction<
  [],
  { rule?: string; plugin?: string; debt?: boolean }
> = async (opts) => {
  const all = await loadExemptions(
    await loadRepoFiles(await getWorktreeRoot()),
  );
  const plugin = opts.plugin?.replace(/^plugins\//, "").replace(/\/$/, "");
  const selected = all.filter(
    (e) =>
      (opts.rule === undefined || e.rule === opts.rule) &&
      (plugin === undefined || e.plugin === plugin) &&
      (opts.debt !== true || e.kind === "debt"),
  );
  if (selected.length === 0) {
    console.log("No exemptions match.");
    return;
  }

  const rules = groupBy(selected, (e) => e.rule);
  for (const rule of [...rules.keys()].sort(byText)) {
    const entries = rules.get(rule)!;
    const debt = entries.filter((e) => e.kind === "debt").length;
    console.log(
      `${rule} — ${entries.length} exemption${entries.length === 1 ? "" : "s"}` +
        (debt > 0 ? ` (${debt} debt)` : ""),
    );
    const plugins = groupBy(entries, (e) => e.plugin);
    for (const p of [...plugins.keys()].sort(byText)) {
      console.log(`  ${p}`);
      const sorted: ResolvedExemption[] = [...plugins.get(p)!].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      for (const e of sorted) {
        const kind = e.kind === "debt" ? `debt, ${e.task}` : "sanctioned";
        console.log(`    ${e.path} [${kind}]`);
        console.log(`      ${e.reason}`);
      }
    }
    console.log("");
  }
  const totalDebt = selected.filter((e) => e.kind === "debt").length;
  console.log(
    `${selected.length} exemption${selected.length === 1 ? "" : "s"} across ${rules.size} rule${rules.size === 1 ? "" : "s"}` +
      ` (${totalDebt} debt, ${selected.length - totalDebt} sanctioned)`,
  );
};

export default run;
