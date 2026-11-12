import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  databaseExists,
  describeUndeclaredSchema,
  dropDatabase,
  forkDatabase,
} from "@plugins/database/plugins/admin/server";
import type { ForkExclusions } from "@plugins/database/plugins/admin/server";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  asNamespace,
  MAIN_WORKTREE_NAME,
} from "@plugins/infra/plugins/namespace/core";
import {
  holdBackendDown,
  startBackend,
} from "@plugins/infra/plugins/worktree/plugins/backend-hold/server";
import { checkoutNamespace } from "@plugins/infra/plugins/paths/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

// What a fork must not copy is DECLARED by the plugins that own the tables
// (`ExcludeFromFork` / `ExcludeSchemaDataFromFork`): static data on their
// server definitions, so a function of THIS checkout's code. We read it off the
// code itself: a child process (`./internal/declared-exclusions-probe.ts`)
// loads the plugin graph this checkout's backend would boot
// (`loadDeclaredGraph`, server-core/cli) and stops before anything touches a
// database. A child, because loading the graph declares a runtime namespace,
// which this process must not have (see the probe's header).
//
// It used to ask a RUNNING backend over HTTP (this checkout's, else main's),
// which made the recovery path depend on the thing it recovers from:
// `--replace` exists for a worktree DB that cannot boot, and on 2026-11-08 it
// could not run while main's backend was crash-looping and then down.
//
// A missing input is still loud, never an empty set: a module that fails to
// load fails the probe, `forkExclusionsFrom` throws when the graph declares no
// exclusion at all, and an answer that does not parse is refused — forking
// with none would copy ~2 GB of main's traces and notifications and look like
// it worked.
const PROBE = join(import.meta.dir, "internal/declared-exclusions-probe.ts");

const ForkExclusionsSchema = z.object({
  tables: z.array(z.string()),
  schemas: z.array(z.object({ schema: z.string(), keep: z.array(z.string()) })),
});

async function declaredForkExclusions(root: AppPath): Promise<ForkExclusions> {
  const namespace = await checkoutNamespace(root);
  const dir = mkdtempSync(join(tmpdir(), "equin-fork-exclusions-"));
  try {
    const out = join(dir, "exclusions.json");
    const probe = await spawnCaptured(
      [process.execPath, PROBE, "--namespace", namespace, "--out", out],
      {
        cwd: root,
        unbounded:
          "a CLI a human watches: it loads this checkout's plugin graph, as " +
          "long as a backend's load waves take, and has no shorter deadline to borrow",
      },
    );
    if (probe.exitCode !== 0) {
      throw new Error(
        `Could not read the fork exclusions this checkout declares: loading ` +
          `its plugin graph (as "${namespace}") exited ${probe.exitCode}:\n` +
          `${probe.stderr.slice(-4000)}\nNothing was dropped or forked.`,
      );
    }
    return ForkExclusionsSchema.parse(JSON.parse(readFileSync(out, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run: CliAction<[string | undefined], { replace?: boolean }> = async (
  target,
  opts,
) => {
  const root = await getWorktreeRoot();
  const worktree = basename(root);
  const name = target ?? worktree;
  if (opts.replace === true && name === MAIN_WORKTREE_NAME) {
    throw new Error(
      `--replace drops the target first; "${name}" is main's database and is never replaced.`,
    );
  }
  // Read the exclusions BEFORE dropping anything: if the graph cannot be read,
  // the command fails with the existing database still in place.
  const exclusions = await declaredForkExclusions(root);
  // Backend down before its data: the namespace's backend (if it runs) is
  // stopped and held down before its database is dropped, and cold-started on
  // the fresh fork afterwards. A fork that fails in between leaves it held —
  // `./equin build` (a deploy start) releases it — never serving against a
  // database that is not there.
  const held =
    opts.replace === true && (await databaseExists(name))
      ? await holdBackendDown(asNamespace(name))
      : null;
  if (held !== null) {
    console.log(
      `Dropping "${name}" (--replace): every row only it has is lost...`,
    );
    await dropDatabase(held);
  }
  console.log(`Forking "${LEGACY_IDS.pgBaseDatabase}" → "${name}"...`);
  const outcome = await forkDatabase(
    LEGACY_IDS.pgBaseDatabase,
    name,
    exclusions,
  );
  // A human is watching this terminal, so it is the right place to say what the
  // fork found: declarations that matched nothing (benign) and schemas nobody
  // claimed (their rows just got copied). Neither stops a fork — see `ForkPlan`
  // — and in the app the same findings reach the bell instead.
  if (outcome.kind === "forked") {
    for (const line of outcome.plan.unmatched) {
      console.warn(`  note: ${line}`);
    }
    for (const s of outcome.plan.undeclaredSchemas) {
      console.warn(`  warning: ${describeUndeclaredSchema(s)}`);
    }
  }
  if (held !== null) await startBackend(held);
  console.log(
    outcome.kind === "already-present"
      ? `DB "${name}" already existed — nothing to do (--replace forks it afresh).`
      : `DB "${name}" ready.${opts.replace === true ? " Run ./equin build to apply this branch's migrations to it." : ""}`,
  );
};

export default run;
