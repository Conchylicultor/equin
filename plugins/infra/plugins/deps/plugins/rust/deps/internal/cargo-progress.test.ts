import { expect, test } from "bun:test";
import type { DepProgress } from "@plugins/infra/plugins/deps/deps";
import { cargoProgressReader } from "./cargo";

test("cargo's forced progress bar becomes crate counts, the last frame of each chunk", () => {
  const seen: DepProgress[] = [];
  const read = cargoProgressReader((p) => seen.push(p));
  read(
    "   Compiling libc v0.2.1\r    Building [                ] 0/312: libc\r" +
      "    Building [=====>          ] 137/312: syn, serde\r",
  );
  read("warning: unused\n");
  read("    Building [===============>] 311/312: equin-helper(bin)    \r");
  expect(seen).toEqual([
    { done: 137, total: 312, unit: "crates" },
    { done: 311, total: 312, unit: "crates" },
  ]);
});
