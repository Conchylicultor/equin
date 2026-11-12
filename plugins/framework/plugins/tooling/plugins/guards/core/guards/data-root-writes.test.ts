import { describe, expect, test } from "bun:test";
import { dataRootLayout } from "@plugins/infra/plugins/paths/core";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { dataRootWritesGuard } from "./data-root-writes";

const WT = "/r/repo/.claude/worktrees/att-123-abcd";
const ROOT = dataRootLayout().root;

type Input = { file_path?: string; notebook_path?: string; command?: string };

function verdict(input: Input): Verdict {
  const ctx = createContext(
    WT,
    "615f223d-ac72-45b2-9bb8-6f7d361d78da",
    [],
    undefined,
    null,
    null,
    WT,
    "/tmp/equin-scratch/conv-1-abc",
  );
  return (dataRootWritesGuard.check(input, ctx) ?? {
    kind: "allow",
  }) as Verdict;
}
const blocks = (input: Input) => verdict(input).kind === "deny";
const cmd = (command: string) => blocks({ command });

describe("data-root-writes guard", () => {
  test("the 2026-11-10 incidents: screenshots at the data root are refused", () => {
    // A variable-held destination (the demo audit's own spelling).
    expect(
      cmd(
        `D=/x/tool-results; O=${ROOT}/demo-audit-2026-11-10; mkdir -p $O; cp $D/a.png $O/site-home.png`,
      ),
    ).toBe(true);
    // The probe's hard-coded output, by Write and by an unmodelled command.
    expect(blocks({ file_path: `${ROOT}/tmp-probe-8b6a96-d8cdc3.png` })).toBe(
      true,
    );
    expect(cmd(`./equin run x.ts --out ${ROOT}/shots`)).toBe(true);
    expect(cmd(`echo x > ${ROOT}/notes.txt`)).toBe(true);
    expect(cmd(`bash -c 'touch ${ROOT}/x'`)).toBe(true);
  });

  test("a new data dir minted by hand under a kind is refused", () => {
    expect(cmd(`mkdir -p ${ROOT}/cache/my-shots-zz9`)).toBe(true);
    expect(blocks({ file_path: `${ROOT}/state/not-declared-zz9/a.json` })).toBe(
      true,
    );
  });

  test("open kinds, reads and removals pass", () => {
    expect(cmd(`mkdir -p ${ROOT}/deprecated/old-thing`)).toBe(false);
    expect(cmd(`echo x > ${ROOT}/worktrees/att-1/notes`)).toBe(false);
    expect(cmd(`ls ${ROOT}/demo-audit-2026-11-10; cat ${ROOT}/x.png`)).toBe(
      false,
    );
    expect(
      cmd(`rm -rf ${ROOT}/demo-audit-2026-11-10 ${ROOT}/tmp-probe-a.png`),
    ).toBe(false);
    expect(cmd(`cp ${ROOT}/x.png "$${envName("SCRATCH")}/x.png"`)).toBe(false);
    expect(blocks({ file_path: `${WT}/plugins/x/web/index.ts` })).toBe(false);
  });

  test("a value set by running something is not guessed", () => {
    expect(cmd('O=$(mktemp -d); mkdir -p "$O/x"')).toBe(false);
  });
});
