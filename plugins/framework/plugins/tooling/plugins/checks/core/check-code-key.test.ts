// The code side of an input-keyed check's key, driven the way the runner
// drives it: a read-set is recorded under the check's code key over one tree,
// and replayed under the key computed over the next tree.
//
// The regression this guards: the key used to be a hash of every file under a
// hand-listed set of prefixes (tooling/, parse-utils/, …), so an edit to a
// check living elsewhere — or to a helper it imports from elsewhere — left the
// key unchanged and the replay served the PASS the old logic recorded. Under
// that key the first two tests below HIT; under the closure key they MISS.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoSnapshotOver } from "@plugins/framework/plugins/tooling/core";
import { createReadSetRepo, type ReadSetRepo } from "./testing";
import { checkCodeKeys, type CheckCodeKey } from "./check-code-key";

// Fixture layout: a runner, a check outside tooling/ importing a helper of its
// own plugin, a second check, and a tooling/ file neither loads.
const RUNNER =
  "plugins/framework/plugins/tooling/plugins/checks/core/runner.ts";
const RUNNER_DEP =
  "plugins/framework/plugins/tooling/plugins/checks/core/read-set.ts";
const LIVE_CHECK = "plugins/network/plugins/live/check/index.ts";
const LIVE_HELPER = "plugins/network/plugins/live/core/rule.ts";
const OTHER_CHECK = "plugins/active-data/check/index.ts";
const UNLOADED_TOOLING = "plugins/framework/plugins/tooling/core/unrelated.ts";
// The shape that re-keyed every check: a barrel both checks import, which
// reached the registry's `import()` of every check. Only the reaching check
// below imports the registry; the two above import the barrel alone.
const CHECKS_BARREL =
  "plugins/framework/plugins/tooling/plugins/checks/core/index.ts";
const REGISTRY =
  "plugins/framework/plugins/tooling/plugins/checks/plugins/registry/core/check.generated.ts";
const REACHING_CHECK =
  "plugins/network/plugins/live/plugins/change-feed/check/index.ts";
const CHECK_MODULES = new Set([LIVE_CHECK, OTHER_CHECK, REACHING_CHECK]);

// The module graph keys its file facts by the real scan module, so the fixture
// carries it, as plugin-records' own graph tests do.
const SCAN_PATH =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const SCAN = readFileSync(
  join(
    dirname(
      Bun.resolveSync(
        "@plugins/plugin-meta/plugins/plugin-records/core",
        import.meta.dir,
      ),
    ),
    "internal/scan-imports.ts",
  ),
  "utf8",
);

const FILES: Record<string, string> = {
  [SCAN_PATH]: SCAN,
  [RUNNER]: `import { validate } from "./read-set";\nexport const run = validate;\n`,
  [RUNNER_DEP]: `export const validate = () => true;\n`,
  [CHECKS_BARREL]: `export const grepCode = () => [];\n`,
  [REGISTRY]: `export const entries = [() => import("@plugins/network/plugins/live/check"), () => import("@plugins/active-data/check")];\n`,
  [REACHING_CHECK]: `import { entries } from "@plugins/framework/plugins/tooling/plugins/checks/plugins/registry/core/check.generated";\nexport default { id: "reacher", run: () => entries.length > 0 };\n`,
  [LIVE_CHECK]: `import { rule } from "@plugins/network/plugins/live/core/rule";\nimport { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";\nexport default { id: "live", run: (s: string) => rule(s) && grepCode() };\n`,
  [LIVE_HELPER]: `export const rule = (s: string) => s.includes("x");\n`,
  [OTHER_CHECK]: `import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";\nexport default { id: "active-data", run: () => grepCode() };\n`,
  [UNLOADED_TOOLING]: `export const nobodyLoadsMe = 1;\n`,
};

let repo!: ReadSetRepo;

beforeAll(async () => {
  repo = await createReadSetRepo("check-code-key-", FILES);
});

afterAll(() => repo?.dispose());

/** The code key of `checkModule` over the current tree, as the runner computes it. */
async function codeKeyOf(checkModule: string): Promise<CheckCodeKey> {
  const snap = await repo.snapshot();
  const files = repoSnapshotOver(snap.root, snap.paths(), (p) =>
    snap.blobSha(p),
  );
  const runnerUrl = new URL(`file://${repo.root}/${RUNNER}`).href;
  return checkCodeKeys(files, runnerUrl, CHECK_MODULES)(checkModule);
}

/** Record a read-set for `checkModule`, apply `edit`, replay it under the key after the edit. */
async function replayAfter(checkModule: string, path: string, content: string) {
  const before = await codeKeyOf(checkModule);
  const rs = await repo.record(() => {}, before);
  repo.write(path, content);
  try {
    const after = await codeKeyOf(checkModule);
    return { before, after, verdict: await repo.revalidate(rs, after) };
  } finally {
    repo.write(path, FILES[path]!);
  }
}

test("an edit to a helper of a check outside tooling/ is a MISS", async () => {
  const { before, after, verdict } = await replayAfter(
    LIVE_CHECK,
    LIVE_HELPER,
    `export const rule = (s: string) => s.includes("y");\n`,
  );
  expect(after).not.toBe(before);
  expect(verdict.hit).toBe(false);
  if (!verdict.hit) expect(verdict.reason).toContain("codeKey");
});

test("an edit to the check's own module is a MISS", async () => {
  const { verdict } = await replayAfter(
    OTHER_CHECK,
    OTHER_CHECK,
    `export default { id: "active-data", run: () => false };\n`,
  );
  expect(verdict.hit).toBe(false);
});

test("an edit to the runner's closure is a MISS for every check", async () => {
  for (const check of [LIVE_CHECK, OTHER_CHECK]) {
    const { verdict } = await replayAfter(
      check,
      RUNNER_DEP,
      `export const validate = () => false;\n`,
    );
    expect(verdict.hit).toBe(false);
  }
});

test("an edit no check loads — a tooling/ file included — is a HIT", async () => {
  const { before, after, verdict } = await replayAfter(
    LIVE_CHECK,
    UNLOADED_TOOLING,
    `export const nobodyLoadsMe = 2;\n`,
  );
  expect(after).toBe(before);
  expect(verdict.hit).toBe(true);
});

test("an edit to one check's code leaves another check's key alone", async () => {
  const { before, after } = await replayAfter(
    OTHER_CHECK,
    LIVE_HELPER,
    `export const rule = (s: string) => s.length > 0;\n`,
  );
  expect(after).toBe(before);
});

test("a read-set recorded before code keys existed is a MISS", async () => {
  const key = await codeKeyOf(LIVE_CHECK);
  const legacy = { ...(await repo.record(() => {}, key)) } as Record<
    string,
    unknown
  >;
  delete legacy.codeKey;
  legacy.sourceHash = "0".repeat(64);
  const verdict = await repo.revalidate(
    legacy as unknown as Parameters<ReadSetRepo["revalidate"]>[0],
    key,
  );
  expect(verdict.hit).toBe(false);
});

test("a check whose closure reaches other checks (the registry) throws", async () => {
  // Rejected synchronously-settled under bun:test: no await (test-layout).
  expect(codeKeyOf(REACHING_CHECK)).rejects.toThrow(/other check module/);
});
