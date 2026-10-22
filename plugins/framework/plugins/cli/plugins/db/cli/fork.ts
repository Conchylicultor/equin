import { basename } from "node:path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  databaseExists,
  describeUndeclaredSchema,
  dropDatabase,
  forkDatabase,
} from "@plugins/database/plugins/admin/server";
import type { ForkExclusions } from "@plugins/database/plugins/admin/server";
import { getForkExclusions } from "@plugins/database/plugins/fork/core";
import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  asNamespace,
  namespaceUrl,
  MAIN_WORKTREE_NAME,
} from "@plugins/infra/plugins/namespace/core";

// What a fork must not copy is DECLARED by the plugins that own the tables
// (`ExcludeFromFork` / `ExcludeSchemaDataFromFork`), and those declarations are
// collected at server boot. A CLI process never boots the server, and it cannot
// load the plugin registry to collect them either — that imports
// `@plugins/database/server`, whose worktree pool is scoped to a RUNTIME
// namespace, which a CLI process does not have.
//
// So we ask a backend that HAS booted. Candidates in order:
//
//   1. This checkout's own backend, when one is up. The exclusion set is a
//      function of the CODE — a checkout that adds or removes a declaration has
//      a different set — so the backend running this checkout is the only one
//      guaranteed to answer for it.
//   2. Main. A worktree freshly made with `git worktree add` has no database and
//      therefore no backend of its own, which is the whole reason this command
//      exists; main is the one backend we can count on. Its answer can be stale
//      if this checkout changed the declarations, which is why it is the
//      fallback and not the first choice.
//
// If neither answers we FAIL rather than fork with an empty exclusion set: that
// would silently produce a ~2 GB database full of main's traces and
// notifications and look like it worked.
async function fetchForkExclusions(worktree: string): Promise<ForkExclusions> {
  const candidates = [asNamespace(worktree), MAIN_WORKTREE_NAME].filter(
    (ns, i, all) => all.indexOf(ns) === i,
  );
  const failures: string[] = [];
  for (const ns of candidates) {
    const origin = namespaceUrl(ns);
    try {
      return await callEndpoint(getForkExclusions, {}, { origin });
    } catch (err) {
      failures.push(
        `${origin} → ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error(
    `Could not read the fork exclusion set from any running backend:\n  ${failures.join(
      "\n  ",
    )}\nStart Singularity and retry — forking without the exclusions would copy ` +
      `every observability and mail table (~2 GB of traces, messages and notifications).`,
  );
}

const run: CliAction<[string | undefined], { replace?: boolean }> = async (
  target,
  opts,
) => {
  const worktree = basename(await getWorktreeRoot());
  const name = target ?? worktree;
  if (opts.replace === true && name === MAIN_WORKTREE_NAME) {
    throw new Error(
      `--replace drops the target first; "${name}" is main's database and is never replaced.`,
    );
  }
  // Read the exclusions BEFORE dropping anything: if no backend answers, the
  // command fails with the existing database still in place.
  const exclusions = await fetchForkExclusions(worktree);
  if (opts.replace === true && (await databaseExists(name))) {
    console.log(
      `Dropping "${name}" (--replace): every row only it has is lost...`,
    );
    await dropDatabase(name);
  }
  console.log(`Forking "singularity" → "${name}"...`);
  const outcome = await forkDatabase("singularity", name, exclusions);
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
  console.log(
    outcome.kind === "already-present"
      ? `DB "${name}" already existed — nothing to do (--replace forks it afresh).`
      : `DB "${name}" ready.${opts.replace === true ? " Run ./singularity build to apply this branch's migrations to it." : ""}`,
  );
};

export default run;
