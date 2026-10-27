import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { visitFiles } from "./files";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function put(root: string, rel: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

test("rewrites state, leaves history, drops caches, re-points links; the scan then reads clean", () => {
  const root = mkdtempSync(join(tmpdir(), "root-migration-"));
  dirs.push(root);
  const old = "/home/u/.old";
  const moves = [{ from: old, to: root }];

  put(
    root,
    "state/db-config/database.json",
    `{"host":"${old}/postgres/socket"}`,
  );
  put(root, "logs/gateway/x.log", `started in ${old}/state`);
  put(root, "state/sdk-agents/ns/c/events.jsonl", `{"cwd":"${old}/w"}\n`);
  put(root, "cache/deps/py/abc/env/pyvenv.cfg", `home = ${old}/cache/uv`);
  put(root, "cache/check/keep.json", "{}");
  put(
    root,
    "state/releases/r/server",
    new Uint8Array([0, 1, ...Buffer.from(`${old}/build`), 0]),
  );
  put(root, "postgres/data/postgresql.conf", `x = '${old}/y'`);
  mkdirSync(join(root, "apps"), { recursive: true });
  symlinkSync(`${old}/state/attachments`, join(root, "apps/attachments"));

  const found = visitFiles(root, moves, true);
  expect(found).toEqual({
    text: ["state/db-config/database.json"],
    links: ["apps/attachments"],
    cacheEntries: ["cache/deps/py"],
    binaries: ["state/releases/r/server"],
  });

  expect(
    readFileSync(join(root, "state/db-config/database.json"), "utf8"),
  ).toBe(`{"host":"${root}/postgres/socket"}`);
  expect(readlinkSync(join(root, "apps/attachments"))).toBe(
    `${root}/state/attachments`,
  );
  expect(readFileSync(join(root, "logs/gateway/x.log"), "utf8")).toContain(old);
  expect(existsSync(join(root, "cache/deps/py"))).toBe(false);
  expect(existsSync(join(root, "cache/check/keep.json"))).toBe(true);

  expect(visitFiles(root, moves, false)).toEqual({
    text: [],
    links: [],
    cacheEntries: [],
    binaries: ["state/releases/r/server"],
  });
});
