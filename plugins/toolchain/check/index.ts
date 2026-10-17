import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import {
  runtimePath,
  runtimeShimsDir,
} from "@plugins/infra/plugins/launcher/core";
import { toolchainPin } from "@plugins/infra/plugins/paths/core";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { utcDay } from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  HOLDS,
  TOOLS,
  lockProblems,
  parseMiseLock,
  parseMiseToolRequests,
} from "@plugins/toolchain/core";

/** `rustc --version` goes through rustup's proxy; a cold one takes a moment. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * `mise.toml` asks for the latest of every tool, `mise.lock` records exactly
 * which release that is, and the tool the runtime would run IS that release.
 *
 * Tree-scoped with `cacheSignature: () => null`, like `bun-runtime`: the last
 * arm reads installed binaries, which no tree hash covers, so no PASS may
 * transfer to a machine (or a moment) running something else.
 */
const check: Check = {
  id: "toolchain:resolved",
  cacheSignature: () => null,
  description:
    "mise.toml requests every tool at latest, mise.lock records one exact release per tool within its floor and active holds, every hold bounded to 90 days, and the runtime resolves each tool to that release — inside the checkout, and from outside any checkout under the toolchain pin",
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const requests = parseMiseToolRequests(
      readFileSync(join(root, "mise.toml"), "utf8"),
    );
    let lockText: string;
    try {
      lockText = readFileSync(join(root, "mise.lock"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return {
        ok: false,
        message:
          "mise.lock is missing. Without it `latest` is resolved once, at install time, and never again — the drift this repo exists to prevent.",
        hint: "Restore the committed mise.lock (`git checkout -- mise.lock`).",
      };
    }
    const locked = parseMiseLock(lockText);

    const problems = lockProblems(requests, locked, {
      holds: HOLDS,
      today: utcDay(new Date()),
    });
    if (problems.length > 0) {
      return {
        ok: false,
        message: problems.join("\n"),
        hint: "Move a tool only with `./singularity toolchain upgrade`; floors and holds live in plugins/toolchain/core.",
      };
    }

    // The runtime's PATH, not this process's: the gateway hands every backend
    // `runtimePath(env)` — mise's shims first, located from the environment
    // whether or not this shell activated mise. Probing the raw PATH would ask a
    // developer's shell, where Homebrew may come first or mise be absent.
    const env = { ...process.env, PATH: runtimePath(process.env) };
    const mismatches = await probeTools(locked, root, env, "");

    if (mismatches.length > 0) {
      return {
        ok: false,
        message: mismatches.join("\n"),
        hint: missingToolchainHint(),
      };
    }

    // And from OUTSIDE any checkout, with the pin every backend applies to
    // itself (`toolchainPin`): a shim with no `mise.toml` above its cwd would
    // otherwise run an unlocked system copy or fail outright. The pin rests on
    // mise's semantics (global config + the lock beside it), not ours, so it is
    // re-measured here rather than trusted. Asked only once the tools resolve
    // inside the checkout, so a missing tool is named once, with its fix.
    const outside = mkdtempSync(join(tmpdir(), "toolchain-outside-"));
    let unpinned: string[];
    try {
      unpinned = await probeTools(
        locked,
        outside,
        { ...env, ...toolchainPin() },
        " outside a checkout",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    if (unpinned.length > 0) {
      return {
        ok: false,
        message: unpinned.join("\n"),
        hint:
          "The runtime pins its toolchain with MISE_GLOBAL_CONFIG_FILE=<checkout>/mise.toml (paths/core `toolchainPin`), " +
          "and this mise no longer resolves the locked release through it. Check what changed in mise's handling of the global config or its lock.",
      };
    }
    return { ok: true };
  },
};

/**
 * Asks every tool for its version from `cwd` under `env`, and names each one
 * that does not report the release `mise.lock` records. Collected, not thrown:
 * every missing tool is named in ONE run. `where` qualifies each message.
 */
async function probeTools(
  locked: ReturnType<typeof parseMiseLock>,
  cwd: string,
  env: Record<string, string | undefined>,
  where: string,
): Promise<string[]> {
  const mismatches: string[] = [];
  for (const spec of TOOLS) {
    const want = locked.get(spec.name)?.[0];
    let probe: Awaited<ReturnType<typeof spawnCaptured>>;
    try {
      probe = await spawnCaptured([...spec.versionArgv], {
        cwd,
        env,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      mismatches.push(
        `${spec.name}: \`${spec.versionArgv[0]}\` is not on the runtime PATH (mise.lock records ${want}).`,
      );
      continue;
    }
    const said = `${probe.stdout}\n${probe.stderr}`.trim();
    const got =
      probe.exitCode === 0
        ? (spec.versionPattern.exec(probe.stdout.trim())?.[1] ?? null)
        : null;
    if (got === null) {
      mismatches.push(
        `\`${spec.versionArgv.join(" ")}\`${where} did not report a version (exit ${probe.exitCode}${probe.timedOut ? ", timed out" : ""}): ${said.split("\n")[0]}`,
      );
    } else if (got !== want) {
      mismatches.push(
        `${spec.name}: mise.lock records ${want}, but the runtime resolves \`${spec.versionArgv[0]}\`${where} to ${got}.`,
      );
    }
  }
  return mismatches;
}

/**
 * No shims directory means mise has never installed anything for this user (or
 * is not installed at all) — the "something shadows mise" advice would send
 * them looking for a conflict that is not there.
 */
function missingToolchainHint(): string {
  const shims = runtimeShimsDir(process.env);
  if (shims === undefined || !existsSync(shims)) {
    return (
      `mise's shims directory (${shims ?? "$HOME unset"}) does not exist: mise is not installed, or has installed nothing yet. ` +
      "Install mise and run `mise install` in this checkout (see docs/setup.md); `mise run doctor` lists anything else missing."
    );
  }
  return (
    "Run `mise install` in this checkout to install the locked releases. If a tool still resolves elsewhere, " +
    "something ahead of mise's shims on PATH is shadowing it."
  );
}

export default check;
