import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { bundleWorkerTree, workerBundleEntry } from "./worker-bundle";

// A tree as the worker link lays it out: one dir per linked artifact, every
// import a relative URL into the tree; `_vendor/` and a `.snapshot` link stay
// external.
const root = mkdtempSync(join(tmpdir(), "worker-bundle-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, code: string): void {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, code);
}

// Every module logs when its body runs, so the test sees evaluation order.
const LOG = "globalThis.__wbLog ??= []; globalThis.__wbLog.push";
write("_vendor/lib.js", `${LOG}("vendor"); export const v = 1;`);
write("demo.snapshot/index.js", `export default { version: "s" };`);
write(
  "demo.bin/index.js",
  `import "../ns.core/index.js";
import snapshot from "../demo.snapshot/index.js";
${LOG}("entry");
export const loaders = [() => import("../a.server/index.js"), () => import("../b.server/index.js")];
export const snap = snapshot.version;
export const lazy = () => import("data:text/javascript,throw new Error('never')");`,
);
write("ns.core/index.js", `${LOG}("ns"); export const ns = "demo";`);
write(
  "a.server/index.js",
  `import { v } from "../_vendor/lib.js"; import { shared } from "../c.core/index.js";
${LOG}("a"); export default { id: "a", v, shared };
export const later = () => import("./lazy.js");`,
);
write("a.server/lazy.js", `${LOG}("a-lazy"); export const lazy = true;`);
write(
  "b.server/index.js",
  `import { shared } from "../c.core/index.js"; ${LOG}("b");
export default { id: "b", shared, url: new URL("./asset.txt", import.meta.url).pathname };`,
);
write("b.server/asset.txt", "asset");
write("c.core/index.js", `${LOG}("c"); export const shared = "c";`);

describe("bundleWorkerTree", () => {
  test("bundles the boot set, requests it with the entry, and keeps evaluation order", async () => {
    const lines: string[] = [];
    const out = await bundleWorkerTree({
      treeDir: asAppPath(root),
      entries: ["demo.bin"],
      vendorLink: "_vendor",
      log: (l) => lines.push(l),
    });
    expect(out.modules).toBe(6);
    const entry = readFileSync(
      join(root, workerBundleEntry("demo.bin")),
      "utf8",
    );
    // External files keep their place in the tree, one level up.
    const files = readdirSync(join(root, "_bundle")).filter((f) =>
      f.endsWith(".js"),
    );
    const all = files
      .map((f) => readFileSync(join(root, "_bundle", f), "utf8"))
      .join("\n");
    expect(all).toMatch(/["`]\.\.\/_vendor\/lib\.js["`]/);
    expect(all).toMatch(/["`]\.\.\/demo\.snapshot\/index\.js["`]/);
    expect(all).toMatch(/["`]\.\.\/b\.server\/asset\.txt["`]/);
    // Every plugin-graph chunk is requested by the entry as soon as it runs.
    const bootChunks = files.filter(
      (f) =>
        f !== "demo.bin.js" &&
        /"(?:a|b)"/.test(readFileSync(join(root, "_bundle", f), "utf8")),
    );
    for (const f of bootChunks) expect(entry).toContain(`"./${f}"`);

    const g = globalThis as { __wbLog?: string[] };
    g.__wbLog = [];
    const mod = (await import(join(root, workerBundleEntry("demo.bin")))) as {
      loaders: Array<
        () => Promise<{ default: { id: string; shared: string; url?: string } }>
      >;
      snap: string;
    };
    // Loading the entry runs its own imports first, then its body — no plugin
    // body runs before its loader asks for it.
    expect(g.__wbLog.filter((x) => x !== "vendor")).toEqual(["ns", "entry"]);
    expect(mod.snap).toBe("s");
    const a = await mod.loaders[0]!();
    expect(a.default).toMatchObject({ id: "a", shared: "c" });
    expect(g.__wbLog.filter((x) => x !== "vendor")).toEqual([
      "ns",
      "entry",
      "c",
      "a",
    ]);
    const b = await mod.loaders[1]!();
    expect(b.default.url).toEndWith(
      `${root.split("/").pop()}/b.server/asset.txt`,
    );
    // The lazy module is not in the boot set and runs only when imported.
    expect(g.__wbLog).not.toContain("a-lazy");
  });
});
