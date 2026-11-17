import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  defineDep,
  ensureDep,
  readyNow,
} from "@plugins/infra/plugins/deps/deps";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import {
  npmPackageCopy,
  packageCopyDir,
  packageCopyVersion,
} from "./package-copy";

const PKG = "@demo/native-thing";
const WORKSPACE = "workspaces/demo";

let base: string;
let root: AppPath;
let store: { cacheRoot: AppPath; locksRoot: AppPath };
const exec = execContextForTests();

/** bun.lock naming `version` (and an unrelated package at `other`). */
function writeLock(version: string, other = "1.0.0"): void {
  const lock = {
    lockfileVersion: 1,
    workspaces: { "": { name: "root" }, [WORKSPACE]: { name: "demo" } },
    packages: {
      [PKG]: [`${PKG}@${version}`, "", {}, `sha512-${version}`],
      unrelated: [`unrelated@${other}`, "", {}, `sha512-${other}`],
    },
  };
  writeFileSync(join(root, "bun.lock"), JSON.stringify(lock, null, 2));
}

/**
 * The package as bun lays it out: a store dir holding `version`, linked from
 * the workspace's node_modules.
 */
function installPackage(version: string): void {
  const storeDir = join(base, "bun-store", `${PKG}@${version}`);
  mkdirSync(join(storeDir, "native", "bin"), { recursive: true });
  writeFileSync(
    join(storeDir, "package.json"),
    JSON.stringify({ name: PKG, version }),
  );
  writeFileSync(join(storeDir, "native", "bin", "daemon"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  symlinkSync("daemon", join(storeDir, "native", "bin", "daemon-alias"));
  const link = join(root, WORKSPACE, "node_modules", PKG);
  rmSync(link, { force: true });
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(storeDir, link);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "deps-package-copy-test-"));
  root = joinAppPath(asAppPath(base), "repo");
  store = {
    cacheRoot: joinAppPath(asAppPath(base), "cache"),
    locksRoot: joinAppPath(asAppPath(base), "locks"),
  };
  mkdirSync(join(root, WORKSPACE), { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const dep = defineDep({
  id: "package-copy-test",
  owner: "infra/deps/package-copy",
  description: "",
  sizeHint: "",
  source: npmPackageCopy({ workspace: WORKSPACE, package: () => PKG }),
});

describe("npmPackageCopy", () => {
  test("copies the package out of node_modules, links and modes kept", async () => {
    writeLock("1.2.3");
    installPackage("1.2.3");
    const ready = await ensureDep(dep, exec, { store, root });
    const dir = packageCopyDir(ready);
    expect(dir.startsWith(store.cacheRoot)).toBe(true);
    expect(await packageCopyVersion(ready)).toBe("1.2.3");
    expect(
      lstatSync(join(dir, "native/bin/daemon-alias")).isSymbolicLink(),
    ).toBe(true);
    expect(lstatSync(join(dir, "native/bin/daemon")).mode & 0o111).not.toBe(0);

    // The copy is independent of the checkout: a new install there leaves it.
    installPackage("9.9.9");
    expect(
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version,
    ).toBe("1.2.3");
  });

  test("the identity moves with the package's lock entry, not with another package's", async () => {
    writeLock("1.2.3", "1.0.0");
    const a = await dep.source.identityInputs(root);
    writeLock("1.2.3", "2.0.0");
    expect(await dep.source.identityInputs(root)).toEqual(a);
    writeLock("1.2.4", "2.0.0");
    expect(await dep.source.identityInputs(root)).not.toEqual(a);
  });

  test("refuses node_modules that disagree with the lock", async () => {
    writeLock("1.2.4");
    installPackage("1.2.3");
    expect(ensureDep(dep, exec, { store, root })).rejects.toThrow(
      /holds @demo\/native-thing@1\.2\.3, but bun\.lock names 1\.2\.4/,
    );
  });

  test("a package the lock does not name is a failed dependency, not an absent one", async () => {
    writeFileSync(
      join(root, "bun.lock"),
      JSON.stringify({ lockfileVersion: 1, workspaces: {}, packages: {} }),
    );
    expect((await readyNow(dep, { store, root })).kind).toBe("failed");
  });

  test("a package that declares dependencies is refused: the copy would lack them", async () => {
    writeFileSync(
      join(root, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {},
        packages: {
          [PKG]: [
            `${PKG}@1.0.0`,
            "",
            { dependencies: { lib: "^1" } },
            "sha512-x",
          ],
        },
      }),
    );
    const now = await readyNow(dep, { store, root });
    expect(now.kind === "failed" && now.message).toMatch(/depends on lib/);
  });

  test("losing the copy reads as absent", async () => {
    writeLock("1.2.3");
    installPackage("1.2.3");
    const ready = await ensureDep(dep, exec, { store, root });
    rmSync(packageCopyDir(ready), { recursive: true });
    expect((await readyNow(dep, { store, root })).kind).toBe("absent");
  });
});
