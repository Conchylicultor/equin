import rule from "./no-depth-counted-path";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

/** Two folders below its plugin's root (`core/internal/`). */
const DEEP = "/repo/plugins/a/plugins/b/core/internal/x.ts";
/** One folder below (`scripts/`). */
const SHALLOW = "/repo/plugins/a/plugins/b/scripts/x.ts";

const ok = (code: string, filename = DEEP) => ({ code, filename });
const bad = (code: string, levels: number, filename = DEEP) => ({
  code,
  filename,
  errors: [{ messageId: "escapes" as const, data: { levels: String(levels) } }],
});

ruleTester.run("no-depth-counted-path", rule, {
  valid: [
    // Inside the plugin: the plugin moves as a whole.
    ok(`join(import.meta.dir, "../../bin/x.ts");`),
    ok(`resolve(import.meta.dir, "..", "..");`),
    ok(`new URL("../stall.worker.ts", import.meta.url);`),
    ok(`new URL("../../shared/worker.ts", import.meta.url);`),
    ok(`join(__dirname, "../shared/catalog.json");`, SHALLOW),
    ok(`resolve(import.meta.dir, "..");`, SHALLOW),
    // Up and back down within the plugin.
    ok(`join(import.meta.dir, "../../core/../core");`),
    // Not the file's own location.
    ok(`new URL("../../../host/routes", location.href);`),
    ok(`join(root, "../../../..");`),
    ok(`join(import.meta.dir, name, "../../../..");`),
    // Outside the plugin tree.
    ok(`join(import.meta.dir, "../../..");`, "/repo/cli/x.ts"),
  ],
  invalid: [
    bad(`join(import.meta.dir, "../../../../../..");`, 4),
    bad(`resolve(import.meta.dir, "..", "..", "..");`, 1),
    bad(`join(import.meta.dir, "../".repeat(8));`, 6),
    bad(`new URL("../../../", import.meta.url);`, 1),
    bad(`fileURLToPath(new URL("../../../../", import.meta.url));`, 2),
    bad(`new URL("../../../../", import.meta.url).href;`, 2),
    bad(`join(dirname(fileURLToPath(import.meta.url)), "../..", "..");`, 1),
    bad(`resolve(__dirname, "../..");`, 1, SHALLOW),
    bad(`path.join(import.meta.dirname, "../../other/core");`, 1, SHALLOW),
    bad(`join(__filename, "../../../../x");`, 1),
    // A bound root that escapes is reported where it is made, not again.
    bad(`const ROOT = join(import.meta.dir, "../../.."); join(ROOT, "x");`, 1),
    // Through a const anchor.
    bad(
      `const HERE = dirname(fileURLToPath(import.meta.url)); resolve(HERE, "../../..");`,
      1,
    ),
    bad(
      `const HERE = import.meta.dir; const UP = join(HERE, ".."); join(UP, "../..");`,
      1,
    ),
  ],
});
