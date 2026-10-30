// The deployed global stylesheet against what the old scan-based pass would
// compile on the SAME tree: Tailwind's own scan of app.css's `@source` dirs,
// compiled and optimized. Prints the classes only the old pass emits, and the
// ones only the deployed sheet has.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/css-scope-diff.ts <deployed.css>

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { globalCssSource } from "../core/internal/global-css";

const root = join(import.meta.dir, "../../../../../../..");
const appCssFile = globalCssSource(join(root, "plugins"));
const compiler = await compile(readFileSync(appCssFile, "utf8"), {
  base: dirname(appCssFile),
  onDependency: () => {},
});
const scanned = new Scanner({ sources: compiler.sources }).scan();
const old = optimize(compiler.build(scanned), { minify: true }).code;
const deployed = readFileSync(process.argv[2]!, "utf8");
const classes = (css: string) =>
  new Set(
    [...css.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)].map((m) =>
      m[1]!.replace(/\\(.)/g, "$1"),
    ),
  );
const a = classes(old);
const b = classes(deployed);
const onlyOld = [...a].filter((c) => !b.has(c)).sort();
const onlyNew = [...b].filter((c) => !a.has(c)).sort();
console.log(`old pass: ${a.size} classes; deployed: ${b.size}`);
console.log(`only in old (${onlyOld.length}): ${onlyOld.join(" ")}`);
console.log(`only in deployed (${onlyNew.length}): ${onlyNew.join(" ")}`);
