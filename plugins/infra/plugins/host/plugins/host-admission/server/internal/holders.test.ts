import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { listCpuHolders, publishCpuHolder } from "./holders";

const dirs: string[] = [];
function scratch(): AppPath {
  const d = mkdtempSync(join(tmpdir(), "cpu-holders-"));
  dirs.push(d);
  return d as AppPath;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a published holder is listed while held, and gone once released", async () => {
  const dir = scratch();
  const held = await publishCpuHolder(
    { work: "check", units: 3, lane: "background", since: 1 },
    dir,
  );
  const live = await listCpuHolders(dir);
  expect(live).toEqual([
    {
      v: 1,
      pid: process.pid,
      work: "check",
      units: 3,
      lane: "background",
      since: 1,
    },
  ]);
  await held.release();
  expect(await listCpuHolders(dir)).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

test("a marker nobody holds the lock of is a dead holder: reaped, not listed", async () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "999999-0.json"),
    JSON.stringify({
      v: 1,
      pid: 999999,
      work: "build",
      units: 5,
      lane: "background",
      since: 1,
    }),
  );
  expect(await listCpuHolders(dir)).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

test("a missing directory lists no holder", async () => {
  expect(await listCpuHolders(join(scratch(), "absent") as AppPath)).toEqual(
    [],
  );
});
