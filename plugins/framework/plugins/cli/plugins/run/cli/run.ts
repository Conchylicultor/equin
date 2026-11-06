import { existsSync, statSync } from "@plugins/packages/plugins/timed-fs/core";
import { extname, relative, resolve } from "path";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
// The set of extensions this command accepts is READ FROM THE GUARD, not
// re-stated here. The `bun-script` guard denies `bun <file>` for exactly these
// and sends the caller to this command, so the two sets have to be the same
// set — an extension this command refused but the guard denied would leave that
// caller with nowhere to go. One declaration is what makes that unspellable;
// see its docblock. The import sits here, in the deferred implementation, and
// never in `./index.ts`, which `cli:command-declarations-light` measures.
import { MODULE_EXTENSION } from "@plugins/framework/plugins/tooling/plugins/guards/plugins/module-extension/core";
import { isE2eScriptPath } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/core";
import { withDirectOp } from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import { withForegroundPriority } from "@plugins/packages/plugins/spawn-priority/core";
import {
  getWorktreeRoot,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";

/**
 * Refuse, naming the path, rather than running something else.
 *
 * Every arm is a case where the alternative is silent: bun would happily
 * execute a directory's `index.ts`, a `.json`, or a file in a sibling checkout.
 * Both paths are printed — the one typed and the one it resolved to — because a
 * path that resolved somewhere unexpected is the whole class of mistake here.
 */
function reject(script: string, abs: string, why: string): never {
  console.error(`Cannot run ${script}\n  resolved to ${abs}\n  ${why}`);
  process.exit(1);
}

const run: CliAction<[string, string[]], object> = async (script, args) => {
  const root = await getWorktreeRoot();

  // `./equin` cd's to the checkout root before exec'ing the CLI, so
  // `process.cwd()` IS the root here: a relative path is repo-root-relative,
  // which is how scripts are written down everywhere in this repo.
  const abs = resolve(process.cwd(), script);

  if (!existsSync(abs)) reject(script, abs, "no such file");
  if (!statSync(abs).isFile()) reject(script, abs, "not a file");

  // A script in a SIBLING checkout would resolve its dependencies from that
  // checkout's tree — the exact failure this command exists to close, so it
  // must not be reachable through the command that closes it.
  const rel = relative(root, abs);
  if (rel.startsWith("..")) {
    reject(script, abs, `outside this checkout (${root})`);
  }

  if (!MODULE_EXTENSION.test(abs)) {
    const ext = extname(abs);
    reject(
      script,
      abs,
      `not a runnable module — expected a .ts/.tsx/.js/.jsx (or .mts/.cts/.mjs/.cjs) file, got ${ext ? `"${ext}"` : "no extension"}`,
    );
  }

  // We are past `ensureDeps()`, which is the entire point: THIS worktree's
  // `node_modules` now exists and matches this branch's lock, so the child's
  // walk-up finds it before it can reach the main checkout's.
  //
  // `stdin: "inherit"` because the child must be indistinguishable from the
  // script the caller would have run by hand; the default `"ignore"` would be a
  // behavior change hiding in a fd, invisible until a script prompts.
  //
  // EVERY script is an op: it plants the worktree op marker and lands an
  // op-log record, so the Ops views show it and the machine-usage sampler
  // charges its process tree to `agent ops`. The lifecycle is shared with
  // `check` and `test`, see op-runtime/cli/direct-op.ts.
  //
  // Only an e2e script — one under a plugin's `e2e/` dir, the convention the
  // harness owns — is ADMITTED: it drives the deployed app with a browser, so
  // it takes one slot of the `e2e` pool. Any other script is kind `script`,
  // recorded but never admitted: no slot to wait for or hold — a one-off data
  // script must not queue behind builds — and no grant handed down, so a
  // `./equin check` it spawns acquires its own; it stays in the session's
  // (darwinbg) tier. Recorded because unrecorded they were invisible: on
  // 2026-11-06 four agent-run `blocking-fs/scripts/inventory.ts` held ~11 GB
  // with nothing naming them
  // (research/2026-11-06-global-host-pressure-by-owner.md).
  //
  // An e2e script runs in the FOREGROUND tier, and so does the Chromium it
  // launches (darwinbg is inherited at spawn). An agent session is darwinbg
  // as a whole; left there, its browser ran on the efficiency cores and every
  // wall-clock number the run took — long tasks, long animation frames, a
  // CPU profile's self time — was mostly the renderer waiting to be scheduled:
  // /demo measured 36.5 s of > 50 ms tasks in 30 s with 1.6 s of CPU, against
  // 1.2–1.4 s in the foreground
  // (research/2026-11-06-apps-demo-main-thread-is-scheduling-starvation.md).
  // Lifting here, at the one place an e2e run is admitted, makes every perf
  // script measure what the user's browser would, with no flag to forget. The
  // `e2e` pool bounds what is lifted (two runs host-wide), the same argument
  // that lets a `cpu` grant holder run in the foreground; this process does
  // nothing else while it waits on the script. An unadmitted script has no
  // bound, so it is not lifted.
  const kind = isE2eScriptPath(rel) ? "e2e" : "script";
  const outcome = await withDirectOp(kind, { max: 1 }, async (grant) => {
    const spawnScript = () =>
      spawnPassthrough([process.execPath, abs, ...args], {
        cwd: root,
        stdin: "inherit",
        env: { ...process.env, ...(grant === null ? {} : grant.env()) },
      });
    const { exitCode, signalCode } =
      grant === null
        ? await spawnScript()
        : await withForegroundPriority(spawnScript);
    // A signalled child can still report exit 0. Reporting that as success is
    // the absorbed failure this repo bans — the script did not finish, it was
    // killed.
    if (signalCode !== null) {
      console.error(`\n${rel} was killed by ${signalCode}.`);
      return "failed";
    }
    // The exit code is the script's answer (the e2e harness exits 2 for a usage
    // refusal, 1 for failed checks); this command is a wrapper, not a verdict
    // of its own. The exit below reads it back.
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      return "failed";
    }
    return "success";
  });
  // `process.exit` rather than `process.exitCode` alone so a non-zero cannot
  // be overwritten by anything that runs after us.
  if (outcome !== "success") process.exit(process.exitCode ?? 1);
};

export default run;
