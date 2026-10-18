import { describe, expect, test } from "bun:test";
import { builtinModules } from "node:module";
import { isPlatformApi, NODE_BUILTIN_ROOTS } from "./platform-apis";

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
