import { describe, expect, test } from "bun:test";
import {
  dedupeDynamicImportEdits,
  IMPORT_ONCE_HELPER,
  rewriteImportEdits,
} from "./dedupe-dynamic-imports";

const apply = (
  code: string,
  edits: Awaited<ReturnType<typeof dedupeDynamicImportEdits>>,
) => {
  let out = code;
  for (const e of [...edits].reverse())
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return edits.length === 0 ? out : IMPORT_ONCE_HELPER + out;
};

describe("dedupeDynamicImportEdits", () => {
  test("routes a target imported twice through the memo, keeping the literal import", async () => {
    const code =
      "const a=()=>import(`../chunk.ab/index.js`).then(n=>(n.A(),n.B));" +
      'const b=()=>import("../chunk.ab/index.js").then(n=>n.C);';
    const out = apply(code, await dedupeDynamicImportEdits(code));
    expect(out).toContain(
      '__equinImportOnce("../chunk.ab/index.js",()=>import(`../chunk.ab/index.js`)).then(n=>(n.A(),n.B))',
    );
    expect(out).toContain(
      '__equinImportOnce("../chunk.ab/index.js",()=>import("../chunk.ab/index.js")).then(n=>n.C)',
    );
  });

  test("respells static and dynamic specifiers, keying the memo by the new spelling", async () => {
    const rename = (s: string) =>
      s.startsWith("../c.") ? `@c/${s.slice(5, 7)}` : s;
    const code =
      'import{x}from"../c.ab/i.js";import"vendor";' +
      'const a=()=>import("../c.cd/i.js");' +
      'const b=()=>import("../c.ef/i.js"),c=()=>import(`../c.ef/i.js`);';
    const out = apply(code, await rewriteImportEdits(code, rename));
    expect(out).toContain('import{x}from"@c/ab";import"vendor";');
    expect(out).toContain('const a=()=>import("@c/cd");');
    expect(out).toContain(
      'const b=()=>__equinImportOnce("@c/ef",()=>import("@c/ef")),c=()=>__equinImportOnce("@c/ef",()=>import("@c/ef"));',
    );
    expect(out).not.toContain("../c.");
  });

  test("leaves single, computed and attributed imports alone", async () => {
    const code =
      "import{x}from'./s.js';const a=()=>import('./one.js');const b=()=>import(u);const c=()=>import(u);" +
      "const d=()=>import('./j.json',{with:{type:'json'}});const e=()=>import('./j.json',{with:{type:'json'}});";
    expect(await dedupeDynamicImportEdits(code)).toEqual([]);
  });

  test("the memo runs one import per key, shares its promise, and forgets a rejection", async () => {
    let calls = 0;
    let fail = true;
    const load = () => {
      calls++;
      return fail ? Promise.reject(new Error("boom")) : Promise.resolve(calls);
    };
    const once = new Function(
      "load",
      `${IMPORT_ONCE_HELPER};return (k)=>__equinImportOnce(k,load);`,
    )(load) as (k: string) => Promise<number>;
    const first = once("a");
    expect(once("a")).toBe(first);
    expect(first).rejects.toThrow("boom");
    await first.then(undefined, () => undefined);
    await Promise.resolve();
    fail = false;
    const retry = once("a");
    expect(retry).not.toBe(first);
    expect(await retry).toBe(2);
    expect(once("a")).toBe(retry);
    expect(calls).toBe(2);
  });
});
