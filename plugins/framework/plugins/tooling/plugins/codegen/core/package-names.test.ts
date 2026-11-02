/**
 * Unit tests for `withPackageName` — the pure rewrite of a plugin
 * `package.json`'s top-level `"name"` — and for `packageNameFor`, the
 * derivation it writes.
 */

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { packageNameFor } from "@plugins/framework/plugins/plugin-id/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { syncPluginPackageNames, withPackageName } from "./package-names";

const NAME = "@equin/plugin-a-b";

describe("packageNameFor", () => {
  test("joins every non-`plugins` segment with -", () => {
    expect(packageNameFor("tasks")).toBe("@equin/plugin-tasks");
    expect(packageNameFor("stats/plugins/tasks")).toBe(
      "@equin/plugin-stats-tasks",
    );
  });
});

describe("withPackageName", () => {
  test("already right: returns the very same text", () => {
    const text = `{\n  "name": "${NAME}",\n  "private": true\n}\n`;
    expect(withPackageName(text, NAME)).toBe(text);
  });

  test("wrong name: only the value changes, key order and bytes kept", () => {
    const text =
      '{\n  "version": "0.0.1",\n  "name": "@equin/plugin-old",\n' +
      '  "private": true,\n  "dependencies": { "x": "1.0.0" }\n}\n';
    expect(withPackageName(text, NAME)).toBe(
      '{\n  "version": "0.0.1",\n  "name": "@equin/plugin-a-b",\n' +
        '  "private": true,\n  "dependencies": { "x": "1.0.0" }\n}\n',
    );
  });

  test("a nested `name` key is never touched", () => {
    const text = '{\n  "other": { "name": "keep" },\n  "name": "old"\n}\n';
    expect(withPackageName(text, NAME)).toBe(
      `{\n  "other": { "name": "keep" },\n  "name": "${NAME}"\n}\n`,
    );
  });

  test("a `name` string VALUE elsewhere is not mistaken for the key", () => {
    const text = '{\n  "description": "name",\n  "name": "old"\n}';
    expect(withPackageName(text, NAME)).toBe(
      `{\n  "description": "name",\n  "name": "${NAME}"\n}`,
    );
  });

  test("escaped quotes in the old value are replaced whole", () => {
    const text = '{ "name": "a\\"b", "private": true }';
    expect(withPackageName(text, NAME)).toBe(
      `{ "name": "${NAME}", "private": true }`,
    );
  });

  test("tab indentation is preserved", () => {
    const text = '{\n\t"name": "old",\n\t"private": true\n}\n';
    expect(withPackageName(text, NAME)).toBe(
      `{\n\t"name": "${NAME}",\n\t"private": true\n}\n`,
    );
  });

  test("missing name: inserted first, indented like its sibling", () => {
    const text = '{\n    "private": true,\n    "version": "0.0.1"\n}\n';
    expect(withPackageName(text, NAME)).toBe(
      `{\n    "name": "${NAME}",\n    "private": true,\n    "version": "0.0.1"\n}\n`,
    );
  });

  test("missing name in an empty object", () => {
    expect(withPackageName("{}\n", NAME)).toBe(`{\n  "name": "${NAME}"\n}\n`);
  });

  test("idempotent", () => {
    const once = withPackageName('{\n  "private": true\n}\n', NAME);
    expect(withPackageName(once, NAME)).toBe(once);
  });

  test("throws on invalid JSON, a non-object, and a non-string name", () => {
    expect(() => withPackageName("{ nope", NAME, "p/package.json")).toThrow(
      /p\/package\.json: not valid JSON/,
    );
    expect(() => withPackageName("[]", NAME)).toThrow(/expected a JSON object/);
    expect(() => withPackageName('{ "name": 3 }', NAME)).toThrow(
      /"name" is not a string/,
    );
  });
});

describe("syncPluginPackageNames", () => {
  // Fixture plugin paths, built so no literal reads as a real plugin reference.
  const GUEST = ["a", "plugins", "guest"].join("/");
  const SHELL = ["a", "plugins", "shell"].join("/");
  // A checkout of two plugin folders with no package.json: GUEST holds a
  // barrel (a host provider is just `server/index.ts`), SHELL only a stray file
  // a moved plugin left behind.
  function checkout(): {
    root: string;
    tree: Parameters<typeof syncPluginPackageNames>[0]["tree"];
  } {
    const root = mkdtempSync(join(tmpdir(), "package-names-"));
    const node = (path: string) => ({
      dir: asAppPath(join(root, "plugins", path)),
      path,
      compositionRoot: false,
    });
    const guest = node(GUEST);
    const shell = node(SHELL);
    mkdirSync(join(guest.dir, "server"), { recursive: true });
    writeFileSync(
      join(guest.dir, "server", "index.ts"),
      "export default {};\n",
    );
    mkdirSync(shell.dir, { recursive: true });
    writeFileSync(join(shell.dir, ".DS_Store"), "");
    return {
      root,
      tree: { byDir: new Map([guest, shell].map((n) => [n.dir, n])) },
    };
  }

  test("creates the package.json of a plugin with a barrel, never of a shell", async () => {
    const { root, tree } = checkout();
    try {
      const written = await syncPluginPackageNames({
        root: asAppPath(root),
        tree,
      });
      expect(written).toEqual([`plugins/${GUEST}/package.json`]);
      expect(
        JSON.parse(
          readFileSync(join(root, "plugins", GUEST, "package.json"), "utf8"),
        ),
      ).toEqual({
        name: packageNameFor(GUEST),
        private: true,
        version: "0.0.1",
      });
      // Idempotent: the second run writes nothing.
      expect(
        await syncPluginPackageNames({ root: asAppPath(root), tree }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
