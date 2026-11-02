import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { pathToFileURL } from "node:url";
import {
  defineDep,
  depState,
  ensureDep,
  readyNow,
} from "@plugins/infra/plugins/deps/deps";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import { download, downloadedFile } from "./download";

let base: AppPath;
let store: { cacheRoot: AppPath; locksRoot: AppPath };
let url: string;
const BODY = "a,b\n1,2\n";
const SHA = createHash("sha256").update(BODY).digest("hex");
const exec = execContextForTests();

beforeEach(() => {
  base = asAppPath(mkdtempSync(join(tmpdir(), "deps-download-test-")));
  store = {
    cacheRoot: joinAppPath(base, "cache"),
    locksRoot: joinAppPath(base, "locks"),
  };
  const src = join(base, "upstream.csv");
  writeFileSync(src, BODY);
  // curl reads file:// URLs, so the kind's real fetch runs with no network.
  url = pathToFileURL(src).href;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function dep(source: ReturnType<typeof download>) {
  return defineDep({
    id: "download-test",
    owner: "infra/deps/download",
    description: "",
    sizeHint: "",
    source,
    updates: { none: "a test fixture" },
  });
}

describe("download", () => {
  test("fetches the pinned file into env/ under its name", async () => {
    const d = dep(
      download({ files: [{ name: "data.csv", url, sha256: SHA }] }),
    );
    const ready = await ensureDep(d, exec, { store, root: base });
    expect(readFileSync(downloadedFile(ready, "data.csv"), "utf8")).toBe(BODY);
    expect(readdirSync(ready.dir)).toEqual(["data.csv"]);
    expect(() => downloadedFile(ready, "other.csv")).toThrow("has no file");
  });

  test("a sha256 mismatch throws and leaves the dependency not installed", async () => {
    const wrong = "0".repeat(64);
    const d = dep(
      download({ files: [{ name: "data.csv", url, sha256: wrong }] }),
    );
    const err = await ensureDep(d, exec, { store, root: base }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain(`expected the pinned ${wrong}`);
    const now = await readyNow(d, { store, root: base });
    expect(now.kind).toBe("failed");
    expect((await depState(d, { store, root: base })).kind).toBe("failed");
    // Neither the wrong bytes nor a partial file is left under any name.
    const envs = join(store.cacheRoot, "download-test");
    for (const identity of readdirSync(envs)) {
      const env = join(envs, identity, "env");
      expect(existsSync(env) ? readdirSync(env) : []).toEqual([]);
      expect(existsSync(join(envs, identity, "ready.json"))).toBe(false);
    }
  });

  test("derive post-processes in env/, and only its outputs make the install", async () => {
    const d = dep(
      download({
        files: [{ name: "data.csv", url, sha256: SHA }],
        derive: {
          version: "1",
          outputs: ["rows.txt"],
          async run(ctx) {
            const csv = join(ctx.dir, "data.csv");
            const rows =
              readFileSync(csv, "utf8").trim().split("\n").length - 1;
            writeFileSync(join(ctx.dir, "rows.txt"), String(rows));
            unlinkSync(csv);
          },
        },
      }),
    );
    const ready = await ensureDep(d, exec, { store, root: base });
    expect(readdirSync(ready.dir)).toEqual(["rows.txt"]);
    expect(readFileSync(downloadedFile(ready, "rows.txt"), "utf8")).toBe("1");

    // The declared outputs are what "intact" means: losing one reads as absent.
    rmSync(join(ready.dir, "rows.txt"));
    expect((await readyNow(d, { store, root: base })).kind).toBe("absent");
  });

  test("a derive that does not produce its declared outputs fails", async () => {
    const d = dep(
      download({
        files: [{ name: "data.csv", url, sha256: SHA }],
        derive: { version: "1", outputs: ["rows.txt"], run: async () => {} },
      }),
    );
    const err = await ensureDep(d, exec, { store, root: base }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("without producing rows.txt");
  });

  test("identity follows every url, sha256 and the derive version", async () => {
    const inputs = (source: ReturnType<typeof download>) =>
      source.identityInputs(base);
    const plain = await inputs(
      download({ files: [{ name: "data.csv", url, sha256: SHA }] }),
    );
    const derived = (version: string) =>
      inputs(
        download({
          files: [{ name: "data.csv", url, sha256: SHA }],
          derive: { version, outputs: ["x"], run: async () => {} },
        }),
      );
    expect(plain).toEqual({ "file:data.csv": `${url} ${SHA}` });
    expect(await derived("1")).not.toEqual(await derived("2"));
  });

  test("rejects a malformed declaration at definition time", () => {
    expect(() => download({ files: [] })).toThrow("at least one file");
    expect(() =>
      download({ files: [{ name: "a/b", url, sha256: SHA }] }),
    ).toThrow("must match");
    expect(() =>
      download({ files: [{ name: "a", url, sha256: "abc" }] }),
    ).toThrow("64 lowercase hex");
  });
});
