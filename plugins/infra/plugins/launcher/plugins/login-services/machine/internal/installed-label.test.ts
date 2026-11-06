import { afterEach, expect, test } from "bun:test";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindInstalledLabel } from "./installed-label";

const dirs: string[] = [];
async function definitions(
  installed: string[],
): Promise<(label: string) => AppPath> {
  const dir = await mkdtemp(join(tmpdir(), "installed-label-"));
  dirs.push(dir);
  for (const label of installed) await writeFile(join(dir, label), "");
  return (label) => asAppPath(join(dir, label));
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

const ID = {
  label: "dev.new.svc",
  session: "background",
  installedAs: ["dev.old.svc"],
} as const;

test("nothing installed → its own label", async () => {
  expect((await bindInstalledLabel(ID, await definitions([]))).label).toBe(
    "dev.new.svc",
  );
});

test("the old label still installed → bound to it", async () => {
  expect(
    await bindInstalledLabel(ID, await definitions(["dev.old.svc"])),
  ).toEqual({ label: "dev.old.svc", session: "background" });
});

test("only the new label installed → its own label", async () => {
  expect(
    (await bindInstalledLabel(ID, await definitions(["dev.new.svc"]))).label,
  ).toBe("dev.new.svc");
});

test("the old label removed → the binding moves to the new one on the next ask", async () => {
  const pathOf = await definitions(["dev.old.svc"]);
  expect((await bindInstalledLabel(ID, pathOf)).label).toBe("dev.old.svc");
  await rm(pathOf("dev.old.svc"));
  expect((await bindInstalledLabel(ID, pathOf)).label).toBe("dev.new.svc");
});

test("an id without installedAs binds to itself", async () => {
  const id = { label: "dev.plain.svc", session: "graphical" } as const;
  expect(
    await bindInstalledLabel(id, () => {
      throw new Error("no definition is looked up");
    }),
  ).toBe(id);
});
