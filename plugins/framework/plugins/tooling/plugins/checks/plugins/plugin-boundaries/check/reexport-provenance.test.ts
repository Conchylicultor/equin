import { describe, it, expect } from "bun:test";
import {
  collectForeignReexports,
  summarizeExports,
  type Violation,
} from "./reexport-provenance";

// Synthetic plugin universe (no real files). Plugin relpaths only.
const PLUGIN_SET: ReadonlySet<string> = new Set([
  "tasks",
  "tasks/plugins/tasks-core",
  "other",
  "conversations/plugins/conversation-category",
]);

/** Build a collectForeignReexports invocation over an in-memory file map. */
function run(opts: {
  files: Record<string, string>;
  barrelRel: string;
  ownPlugin: string;
  runtime: string;
}): Violation[] {
  return collectForeignReexports({
    barrelRel: opts.barrelRel,
    ownPlugin: opts.ownPlugin,
    pluginSet: PLUGIN_SET,
    exportsOf: (relPath) =>
      Object.hasOwn(opts.files, relPath)
        ? (summarizeExports(opts.files[relPath]!) ?? undefined)
        : undefined,
    exists: (relPath) => Object.hasOwn(opts.files, relPath),
  });
}

describe("collectForeignReexports", () => {
  it("1. flags a direct from-reexport from another plugin", () => {
    const vs = run({
      files: {
        "plugins/tasks/core/index.ts": `export { X } from "@plugins/other/core";`,
      },
      barrelRel: "plugins/tasks/core/index.ts",
      ownPlugin: "tasks",
      runtime: "core",
    });
    expect(vs).toHaveLength(1);
    expect(vs[0]!.rule).toBe("cross-plugin-reexport");
    expect(vs[0]!.message).toContain("X");
    expect(vs[0]!.message).toContain("@plugins/other/core");
  });

  it("2. flags an indirect chain through an internal file", () => {
    const vs = run({
      files: {
        "plugins/tasks/core/index.ts": `export { X } from "./types";`,
        "plugins/tasks/core/types.ts": `export { X } from "@plugins/other/core";`,
      },
      barrelRel: "plugins/tasks/core/index.ts",
      ownPlugin: "tasks",
      runtime: "core",
    });
    expect(vs).toHaveLength(1);
    expect(vs[0]!.message).toContain("X");
    expect(vs[0]!.message).toContain("@plugins/other/core");
    // mentions the intermediate hop
    expect(vs[0]!.message).toContain("./types");
  });

  it("3. flags import-then-bare-reexport directly in a barrel", () => {
    const vs = run({
      files: {
        "plugins/tasks/core/index.ts": `import { X } from "@plugins/other/core";\nexport { X };`,
      },
      barrelRel: "plugins/tasks/core/index.ts",
      ownPlugin: "tasks",
      runtime: "core",
    });
    expect(vs).toHaveLength(1);
    expect(vs[0]!.message).toContain("@plugins/other/core");
  });

  it("4. flags import-then-bare-reexport via an internal file the barrel surfaces", () => {
    const vs = run({
      files: {
        "plugins/tasks/core/index.ts": `export { X } from "./reexporter";`,
        "plugins/tasks/core/reexporter.ts": `import { X } from "@plugins/other/core";\nexport { X };`,
      },
      barrelRel: "plugins/tasks/core/index.ts",
      ownPlugin: "tasks",
      runtime: "core",
    });
    expect(vs).toHaveLength(1);
    expect(vs[0]!.message).toContain("@plugins/other/core");
  });

  it("5. does NOT flag a foreign name an internal file re-exports but the barrel never surfaces", () => {
    // Mirrors the conversation-category/use-category-avatars case: the internal
    // file re-exports AvatarSpec (foreign), but the barrel only surfaces the
    // local useCategoryAvatars.
    const vs = run({
      files: {
        "plugins/conversations/plugins/conversation-category/web/index.ts": `export { useCategoryAvatars } from "./internal/use-category-avatars";`,
        "plugins/conversations/plugins/conversation-category/web/internal/use-category-avatars.ts": `export { AvatarSpec } from "@plugins/other/core";\nexport function useCategoryAvatars() {}`,
      },
      barrelRel:
        "plugins/conversations/plugins/conversation-category/web/index.ts",
      ownPlugin: "conversations/plugins/conversation-category",
      runtime: "web",
    });
    expect(vs).toHaveLength(0);
  });

  it("6. does NOT flag a relative export-from of a locally-declared symbol", () => {
    const vs = run({
      files: {
        "plugins/tasks/core/index.ts": `export { localThing } from "./impl";`,
        "plugins/tasks/core/impl.ts": `export const localThing = 1;`,
      },
      barrelRel: "plugins/tasks/core/index.ts",
      ownPlugin: "tasks",
      runtime: "core",
    });
    expect(vs).toHaveLength(0);
  });

  it("7. flags a parent→descendant proxy (no umbrella carve-out)", () => {
    const vs = run({
      files: {
        "plugins/tasks/core/index.ts": `export { Task } from "@plugins/tasks/plugins/tasks-core/core";`,
      },
      barrelRel: "plugins/tasks/core/index.ts",
      ownPlugin: "tasks",
      runtime: "core",
    });
    expect(vs).toHaveLength(1);
    expect(vs[0]!.message).toContain("tasks/plugins/tasks-core");
  });

  it("9. flags an aliased from-reexport on the surfaced (aliased) name", () => {
    const vs = run({
      files: {
        "plugins/tasks/core/index.ts": `export { X as Y } from "@plugins/other/core";`,
      },
      barrelRel: "plugins/tasks/core/index.ts",
      ownPlugin: "tasks",
      runtime: "core",
    });
    expect(vs).toHaveLength(1);
    // surfaced name is the alias Y, not X
    expect(vs[0]!.message).toContain("`Y`");
  });

  it("flags type-only foreign re-exports too", () => {
    const vs = run({
      files: {
        "plugins/tasks/core/index.ts": `export type { Foo } from "@plugins/other/core";`,
      },
      barrelRel: "plugins/tasks/core/index.ts",
      ownPlugin: "tasks",
      runtime: "core",
    });
    expect(vs).toHaveLength(1);
    expect(vs[0]!.message).toContain("Foo");
  });

  it("does NOT flag when the indirect chain stays within the own plugin", () => {
    const vs = run({
      files: {
        "plugins/tasks/core/index.ts": `export { Helper } from "./util";`,
        "plugins/tasks/core/util.ts": `export { Helper } from "./deep/impl";`,
        "plugins/tasks/core/deep/impl.ts": `export const Helper = 1;`,
      },
      barrelRel: "plugins/tasks/core/index.ts",
      ownPlugin: "tasks",
      runtime: "core",
    });
    expect(vs).toHaveLength(0);
  });
});
