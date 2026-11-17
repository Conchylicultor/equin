import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { bundleDaemon, type DaemonBundleSpec } from "./bundle";

/**
 * A throwaway "checkout": an entry that imports repo code (relative), a
 * pure-JS package (inlined), an external package with a dependency of its own
 * laid out like bun's isolated store, and runs a script by path through the
 * REAL repo-root's `scriptPath` (imported by absolute path, so the bundle
 * carries it and it finds the bundle's root).
 */
let base: string;
let root: AppPath;
let home: AppPath;

function write(rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const REPO_ROOT_INDEX = join(
  REPO_ROOT,
  "plugins/infra/plugins/paths/plugins/repo-root/core/index.ts",
);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "daemon-bundle-"));
  root = asAppPath(join(base, "repo"));
  home = asAppPath(join(base, "bundles"));
  write(
    "pkgs/x/bin/entry.ts",
    `import { REPO_ROOT, scriptPath } from ${JSON.stringify(REPO_ROOT_INDEX)};
import { greet } from "../core/lib";
import inlined from "inl-pkg";
import ext from "ext-pkg";
const child = Bun.spawnSync([process.execPath, scriptPath("pkgs/x/scripts/child.ts")]);
console.log(JSON.stringify({ greet: greet(), inlined, ext, child: child.stdout.toString().trim(), root: REPO_ROOT }));
`,
  );
  write("pkgs/x/core/lib.ts", `export const greet = (): string => "lib-v1";\n`);
  write(
    "pkgs/x/scripts/child.ts",
    `import { greet } from "../core/lib";\nconsole.log("child:" + greet());\n`,
  );
  write(
    "node_modules/inl-pkg/package.json",
    `{"name":"inl-pkg","version":"1.0.0","main":"index.js"}`,
  );
  write("node_modules/inl-pkg/index.js", `module.exports = "inlined-ok";\n`);
  // bun's isolated layout: the package in the store, its dependency beside it.
  const store = "node_modules/.bun/ext-pkg@1.0.0/node_modules";
  write(
    `${store}/ext-pkg/package.json`,
    `{"name":"ext-pkg","version":"1.0.0","main":"index.js","dependencies":{"ext-dep":"2.0.0"},"optionalDependencies":{"not-installed":"1"}}`,
  );
  write(
    `${store}/ext-pkg/index.js`,
    `module.exports = "ext:" + require("ext-dep") + ":" + require("fs").existsSync(__dirname + "/package.json");\n`,
  );
  write(
    "node_modules/.bun/ext-dep@2.0.0/node_modules/ext-dep/package.json",
    `{"name":"ext-dep","version":"2.0.0","main":"index.js"}`,
  );
  write(
    "node_modules/.bun/ext-dep@2.0.0/node_modules/ext-dep/index.js",
    `module.exports = "dep2";\n`,
  );
  symlinkSync(
    join(root, "node_modules/.bun/ext-dep@2.0.0/node_modules/ext-dep"),
    join(root, store, "ext-dep"),
  );
  symlinkSync(join(root, store, "ext-pkg"), join(root, "node_modules/ext-pkg"));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function spec(over: Partial<DaemonBundleSpec> = {}): DaemonBundleSpec {
  return {
    root,
    entry: "pkgs/x/bin/entry.ts",
    external: { "ext-pkg": "reads its own files by path (the fixture)" },
    dir: home,
    ...over,
  };
}

/** Bun names each section relative to the bundler's working directory. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

async function runBundle(entry: AppPath): Promise<Record<string, string>> {
  const res = await spawnCaptured([process.execPath, entry], {
    cwd: base,
    timeoutMs: 30_000,
  });
  if (res.exitCode !== 0) {
    throw new Error(`bundle exited ${res.exitCode}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout) as Record<string, string>;
}

function bundles(): string[] {
  return readdirSync(home).filter((n) => n.endsWith(".bundle"));
}

describe("bundleDaemon", () => {
  test("runs with the checkout gone: repo code and pure-JS packages inlined, scripts bundled beside it, externals cloned", async () => {
    const b = await bundleDaemon(spec());
    b.inUse.close();
    expect(b.made).toBe(true);
    expect(b.dir).toBe(joinAppPath(home, `${b.hash}.bundle`));
    expect(b.entry).toBe(joinAppPath(b.dir, "pkgs/x/bin/entry.js"));
    // The source tree goes away: nothing in the bundle may need it.
    rmSync(root, { recursive: true, force: true });
    expect(await runBundle(b.entry)).toEqual({
      greet: "lib-v1",
      inlined: "inlined-ok",
      ext: "ext:dep2:true",
      child: "child:lib-v1",
      root: realpathSync(b.dir),
    });
    expect(existsSync(join(b.dir, "node_modules/ext-dep/index.js"))).toBe(true);
    expect(existsSync(join(b.dir, "node_modules/inl-pkg"))).toBe(false);
  });

  test("content-addressed: the same content is reused, other content is a new bundle", async () => {
    const first = await bundleDaemon(spec());
    first.inUse.close();
    const again = await bundleDaemon(spec());
    again.inUse.close();
    expect(again.made).toBe(false);
    expect(again.dir).toBe(first.dir);

    write(
      "pkgs/x/core/lib.ts",
      `export const greet = (): string => "lib-v2";\n`,
    );
    const changed = await bundleDaemon(spec());
    changed.inUse.close();
    expect(changed.hash).not.toBe(first.hash);
    expect((await runBundle(changed.entry)).child).toBe("child:lib-v2");
  });

  test("a copied (non-TypeScript) script's bytes are part of the content address", async () => {
    write(
      "pkgs/x/bin/sh-entry.ts",
      `import { scriptPath } from ${JSON.stringify(REPO_ROOT_INDEX)};\nconsole.log(scriptPath("pkgs/x/scripts/run.sh"));\n`,
    );
    write("pkgs/x/scripts/run.sh", "#!/bin/sh\necho one\n");
    const shSpec = spec({ entry: "pkgs/x/bin/sh-entry.ts", external: {} });
    const first = await bundleDaemon(shSpec);
    first.inUse.close();
    expect(readFileSync(join(first.dir, "pkgs/x/scripts/run.sh"), "utf8")).toBe(
      "#!/bin/sh\necho one\n",
    );
    write("pkgs/x/scripts/run.sh", "#!/bin/sh\necho two\n");
    const changed = await bundleDaemon(shSpec);
    changed.inUse.close();
    expect(changed.made).toBe(true);
    expect(changed.hash).not.toBe(first.hash);
    expect(
      readFileSync(join(changed.dir, "pkgs/x/scripts/run.sh"), "utf8"),
    ).toBe("#!/bin/sh\necho two\n");
  });

  test("concurrent makers of the same content both hold the one bundle", async () => {
    const [a, b] = await Promise.all([
      bundleDaemon(spec()),
      bundleDaemon(spec()),
    ]);
    a.inUse.close();
    b.inUse.close();
    expect(a.dir).toBe(b.dir);
    expect(bundles()).toEqual([`${a.hash}.bundle`]);
    expect(readdirSync(home).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("a later bundle reclaims the ones nothing holds, never a held one", async () => {
    const held = await bundleDaemon(spec());
    write(
      "pkgs/x/core/lib.ts",
      `export const greet = (): string => "lib-v2";\n`,
    );
    const loose = await bundleDaemon(spec());
    loose.inUse.close();
    expect(loose.reclaimed).toEqual([]);
    expect(bundles().sort()).toEqual(
      [`${held.hash}.bundle`, `${loose.hash}.bundle`].sort(),
    );

    write(
      "pkgs/x/core/lib.ts",
      `export const greet = (): string => "lib-v3";\n`,
    );
    const latest = await bundleDaemon(spec());
    latest.inUse.close();
    // `loose` was let go; `held` is still held.
    expect(latest.reclaimed).toEqual([`${loose.hash}.bundle`]);
    expect(bundles().sort()).toEqual(
      [`${held.hash}.bundle`, `${latest.hash}.bundle`].sort(),
    );

    held.inUse.close();
    write(
      "pkgs/x/core/lib.ts",
      `export const greet = (): string => "lib-v1";\n`,
    );
    const back = await bundleDaemon(spec());
    back.inUse.close();
    // Same content as `held`: reused, and the unheld `latest` reclaimed.
    expect(back.dir).toBe(held.dir);
    expect(back.reclaimed).toEqual([`${latest.hash}.bundle`]);
  });

  test("bundles the same from any working directory (a backend's is not its checkout)", async () => {
    // Inside repo-root's own plugin dir: its section is named
    // `repo-root/core/internal/repo-root.ts`, not by its repo-relative path.
    const b = await inDir(
      join(REPO_ROOT, "plugins/infra/plugins/paths/plugins"),
      () => bundleDaemon(spec()),
    );
    b.inUse.close();
    expect((await runBundle(b.entry)).child).toBe("child:lib-v1");
  });

  test("refuses code that reads its own location", async () => {
    write(
      "pkgs/x/bin/entry.ts",
      `import { join } from "node:path";\nconsole.log(join(import.meta.dir, "data.txt"));\n`,
    );
    expect(bundleDaemon(spec())).rejects.toThrow(
      /would read a module's own location/,
    );
  });

  test("refuses a scriptPath call it cannot read", async () => {
    write(
      "pkgs/x/bin/entry.ts",
      `import { scriptPath } from ${JSON.stringify(REPO_ROOT_INDEX)};\nconst name = "child.ts";\nconsole.log(scriptPath("pkgs/x/scripts/" + name));\n`,
    );
    expect(bundleDaemon(spec())).rejects.toThrow(/not a string literal/);
  });

  test("an inlined package that reads its own location is refused: it must stay external", async () => {
    expect(bundleDaemon(spec({ external: {} }))).rejects.toThrow(
      /ext-pkg\/index\.js/,
    );
  });

  test("an external that does not resolve is an error, not a smaller bundle", async () => {
    expect(
      bundleDaemon(
        spec({ external: { "ext-pkg": "the fixture", missing: "test" } }),
      ),
    ).rejects.toThrow(/cannot resolve the external package missing/);
  });
});
