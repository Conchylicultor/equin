import { arch, platform, release, type } from "node:os";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { resolveUpstreamRemote } from "@plugins/infra/plugins/git/plugins/remotes/core";
import {
  getWorktreeRoot,
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { serverPin } from "@plugins/build/plugins/server-build-id/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  countCommits,
  currentRelease,
  OWN_RELEASE_NAMESPACE,
  UPSTREAM_BRANCH,
  upstreamReleaseNamespace,
} from "@plugins/upstream/core";
import {
  issueEnvironment,
  type IssueCode,
  type IssueEnvironment,
} from "../../core";

/**
 * The backend's half of an issue's environment (see `IssueEnvironment`).
 *
 * External: the operating system is read once per process, the code from git.
 * Recomputed when a tracked ref moves (`refHeadServed` — the trunk or this
 * checkout's branch advancing changes ahead / behind) and on the backend
 * serving a new build (a restart reads it fresh; an adopted deploy notifies,
 * machine barrel). Nothing polls it.
 */
export const issueEnvironmentServed = serveValue(issueEnvironment, {
  source: "external",
  changes: "notified",
  recomputeOn: [refHeadServed],
  loader: () => readIssueEnvironment(),
});

async function readIssueEnvironment(): Promise<IssueEnvironment> {
  return {
    system: await hostSystem(),
    runtime: `Bun ${Bun.version}`,
    code: await readCode(),
  };
}

let systemMemo: Promise<string> | undefined;

/** `macOS 26.4 (arm64)`, `Ubuntu 24.04.1 LTS (x64)` — read once: it cannot change under a running process. */
function hostSystem(): Promise<string> {
  systemMemo ??= readHostSystem();
  return systemMemo;
}

async function readHostSystem(): Promise<string> {
  const os = platform();
  if (os === "darwin") {
    const out = await spawnExpectOk(["sw_vers", "-productVersion"], {
      timeoutMs: 10_000,
    });
    return `macOS ${out.stdout.trim()} (${arch()})`;
  }
  if (os === "linux") {
    const name = prettyName(await readFile("/etc/os-release", "utf8"));
    return `${name ?? `Linux ${release()}`} (${arch()})`;
  }
  return `${type()} ${release()} (${arch()})`;
}

/** `PRETTY_NAME` from an os-release file, unquoted; undefined when the file names none. */
export function prettyName(osRelease: string): string | undefined {
  const line = osRelease.split("\n").find((l) => l.startsWith("PRETTY_NAME="));
  if (line === undefined) return undefined;
  const value = line.slice("PRETTY_NAME=".length).trim();
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * The commit this backend runs, the release it holds and where it stands
 * against the trunk: upstream's main on a clone (as fetched by the last update
 * check), else local `main` — on the canonical repo that IS the trunk.
 */
async function readCode(): Promise<IssueCode> {
  const pin = serverPin();
  if (!pin.resolved) return { kind: "unknown", reason: pin.reason };
  const commit = pin.value;
  const root = await getWorktreeRoot();
  const upstream = await resolveUpstreamRemote(root);
  const upstreamMain =
    upstream.kind === "upstream"
      ? `${upstream.remote}/${UPSTREAM_BRANCH}`
      : null;
  const base =
    upstreamMain !== null && (await refExists(root, upstreamMain))
      ? upstreamMain
      : UPSTREAM_BRANCH;
  const namespace =
    upstream.kind === "upstream"
      ? upstreamReleaseNamespace(upstream.remote)
      : OWN_RELEASE_NAMESPACE;
  const [releaseTag, ahead, behind] = await Promise.all([
    currentRelease(root, commit, namespace),
    countCommits(root, `${base}..${commit}`),
    countCommits(root, `${commit}..${base}`),
  ]);
  return {
    kind: "commit",
    commit,
    release: releaseTag,
    base,
    ahead,
    behind,
  };
}

async function refExists(root: string, ref: string): Promise<boolean> {
  const r = await spawnCaptured(
    ["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: root, timeoutMs: 10_000 },
  );
  return r.exitCode === 0;
}
