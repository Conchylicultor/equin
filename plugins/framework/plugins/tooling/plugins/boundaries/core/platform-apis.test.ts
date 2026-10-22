import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import ts from "typescript";
import {
  isPlatformApi,
  NODE_BUILTIN_ROOTS,
  platformValueUsesIn,
} from "./platform-apis";

describe("isPlatformApi", () => {
  test("NODE_BUILTIN_ROOTS is the runtime's own bare builtin set", () => {
    // Bun's list also carries its own modules (`bun`, `bun:*`, matched
    // separately) and two npm names it ships natively, which Node's
    // `isBuiltin` does not count.
    const bunOnly = new Set(["bun", "undici", "ws"]);
    const roots = new Set(
      builtinModules
        .filter((m) => !m.includes(":") && !bunOnly.has(m))
        .map((m) => m.split("/")[0]!),
    );
    expect([...NODE_BUILTIN_ROOTS].sort() as string[]).toEqual(
      [...roots].sort(),
    );
  });

  test.each([
    "node:fs",
    "node:fs/promises",
    "fs",
    "fs/promises",
    "path",
    "child_process",
    "bun",
    "bun:ffi",
    "bun:sqlite",
    "bun-pty",
    "pg",
    "pg/lib/utils",
    "pg-protocol",
    "graphile-worker",
    "graphile-worker/dist/x",
    "@parcel/watcher",
    "drizzle-orm/node-postgres",
    "drizzle-orm/node-postgres/session",
  ])("%s is a platform API", (spec) => {
    expect(isPlatformApi(spec)).toBe(true);
  });

  test.each([
    "drizzle-orm",
    "drizzle-orm/pg-core",
    "drizzle-orm/pglite",
    "zod",
    "react",
    "pglite",
    "@electric-sql/pglite",
    "pathe",
    "events-x",
    "@plugins/database/server",
    "./internal/x",
  ])("%s is portable", (spec) => {
    expect(isPlatformApi(spec)).toBe(false);
  });
});

const usesIn = (src: string, fileName = "x.ts"): string[] =>
  platformValueUsesIn(ts, fileName, src);

describe("platformValueUsesIn", () => {
  test.each([
    ["Buffer.byteLength(s)", ["global Buffer"]],
    ["Buffer.from(bytes)", ["global Buffer"]],
    ["const m = process.memoryUsage();", ["global process"]],
    ["Bun.hash(json)", ["global Bun"]],
    ["join(__dirname, 'x')", ["global __dirname"]],
    ["setImmediate(fn)", ["global setImmediate"]],
    ["const x = require('fs');", ["global require"]],
    // Read as a value, not called: burst.ts's default `defer`.
    ["const defer = opts.defer ?? setImmediate;", ["global setImmediate"]],
    ["run({ setImmediate });", ["global setImmediate"]],
    // Used in an expression: route-layout.ts's bytea column.
    [
      "const s = z.object({ tgargs: z.instanceof(Buffer) });",
      ["global Buffer"],
    ],
    ["const ok = b instanceof Buffer;", ["global Buffer"]],
    ["class Bytes extends Buffer {}", ["global Buffer"]],
    // An unguarded unref: a browser timer is a number.
    ["const t = setTimeout(fn, 5);\nt.unref();", ["unguarded .unref()"]],
    ["timer?.unref();", ["unguarded .unref()"]],
    // A shadow in another scope does not hide the global here.
    [
      "function f(process: P) { return process.x; }\nprocess.exit(1);",
      ["global process"],
    ],
    [
      "const a = Buffer.from(s);\nsetImmediate(f);\nh.unref();",
      ["global Buffer", "global setImmediate", "unguarded .unref()"],
    ],
  ])("%s uses %p", (src, expected) => {
    expect(usesIn(src)).toEqual(expected);
  });

  test.each([
    "const dev = process.env.NODE_ENV === 'test';",
    "function f(msg: string | Buffer) {}",
    "const m = new Map<string, Buffer>();",
    "interface Buffer { pending: number }\nconst m = new Map<string, Buffer>();",
    "interface G { setImmediate?: (cb: () => void) => unknown }",
    "type T = typeof setImmediate;",
    "const x = y as Buffer;",
    "class C implements Buffer {}",
    "opts.process.run()",
    "const { process } = deps;",
    "const { setImmediate: immediate } = globalThis as G;",
    "const o = { setImmediate: immediate, Buffer: 1 };",
    "if (typeof setImmediate === 'function') go();",
    "function f(Buffer: B) { return Buffer.from(x); }",
    "import { Buffer } from './buffer';\nBuffer.from(x);",
    "const setImmediate = (f: () => void) => setTimeout(f, 0);\nsetImmediate(g);",
    "(timer as { unref?: () => void }).unref?.();",
    "// Buffer.from(x); setImmediate(f); t.unref()",
    "const s = 'Buffer.from(x) setImmediate(f) process.exit()';",
    "new TextEncoder().encode(s).byteLength",
  ])("%s uses none", (src) => {
    expect(usesIn(src)).toEqual([]);
  });

  test("a type-only import binds no value", () => {
    expect(
      usesIn('import type { Buffer } from "./b";\nBuffer.from(x);'),
    ).toEqual(["global Buffer"]);
  });

  test("a .tsx module parses as TSX", () => {
    expect(
      usesIn("const e = <div onClick={() => setImmediate(f)} />;", "x.tsx"),
    ).toEqual(["global setImmediate"]);
  });

  // Real modules that use these names safely: they must stay clean.
  const REPO = join(import.meta.dir, "../../../../../../..");
  test("macrotask-yield reads setImmediate off globalThis, cleanly", () => {
    const path =
      "plugins/packages/plugins/macrotask-yield/core/internal/yield.ts";
    expect(usesIn(readFileSync(join(REPO, path), "utf8"), path)).toEqual([]);
  });

  test("change-feed's producer names its own `interface Buffer` only as a type", () => {
    const path =
      "plugins/database/plugins/change-feed/server/internal/producer.ts";
    expect(usesIn(readFileSync(join(REPO, path), "utf8"), path)).not.toContain(
      "global Buffer",
    );
  });

  test("resource-runtime's guarded timer unref is clean", () => {
    const path = "plugins/framework/plugins/resource-runtime/core/runtime.ts";
    expect(usesIn(readFileSync(join(REPO, path), "utf8"), path)).toEqual([]);
  });
});
