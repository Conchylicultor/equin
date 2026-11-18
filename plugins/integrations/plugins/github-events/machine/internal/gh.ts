import { join } from "node:path";
import type { z } from "zod";
import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { exists } from "@plugins/packages/plugins/timed-fs/core";

/** One `gh api` call's bound: a REST read, a few hundred ms when GitHub answers. */
const GH_API_TIMEOUT_MS = 30_000;

/** The extension the forwarders run (`gh extension install cli/gh-webhook`). */
export const WEBHOOK_EXTENSION = "cli/gh-webhook";

/**
 * Where gh installs a precompiled extension's binary. The forwarder runs it
 * directly, never through the `gh` wrapper: a SIGTERM to the wrapper orphans
 * the extension, which keeps running and keeps its hook on the repo.
 */
const EXTENSION_BIN = join(
  HOME_DIR,
  ".local",
  "share",
  "gh",
  "extensions",
  "gh-webhook",
  "gh-webhook",
);

/** The two binaries a forwarder needs. */
export interface GhTools {
  gh: string;
  webhook: string;
}

/**
 * Whether this machine can run forwarders: `gh` on the PATH, and the
 * gh-webhook extension installed. A missing one is a state the health row
 * shows with its fix, not an error.
 */
export async function resolveGhTools(): Promise<
  | { kind: "ready"; tools: GhTools }
  | { kind: "not-set-up"; reason: string; fix: string | null }
> {
  const gh = Bun.which("gh");
  if (gh === null) {
    return {
      kind: "not-set-up",
      reason: "the GitHub CLI (gh) is not installed",
      fix: "brew install gh && gh auth login",
    };
  }
  if (!(await exists(EXTENSION_BIN))) {
    return {
      kind: "not-set-up",
      reason: "the gh webhook extension is not installed",
      fix: `gh extension install ${WEBHOOK_EXTENSION}`,
    };
  }
  return { kind: "ready", tools: { gh, webhook: EXTENSION_BIN } };
}

/** `gh api <path>`, its JSON parsed by `schema`. Throws on any failure. */
export async function ghApi<T>(
  gh: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const { stdout } = await spawnExpectOk([gh, "api", path], {
    timeoutMs: GH_API_TIMEOUT_MS,
  });
  return schema.parse(JSON.parse(stdout));
}

/** The URL every forwarder hook GitHub creates points at. */
const FORWARDER_HOOK_URL = "https://webhook-forwarder.github.com/hook";

/**
 * The shell a forwarder runs as: delete the forwarder hook a hard-killed
 * forwarder left on the repo (a repo holds one, and a second start fails with
 * `422 Hook already exists`), then `exec` the extension — so the process the
 * daemon supervises, and SIGTERMs, IS the extension, which deletes its own
 * hook on the way out. Run at every spawn, respawns included, so the cleanup
 * can never be skipped.
 *
 * `$1` gh, `$2` the repo; the rest is the extension's argv.
 */
const FORWARD_SCRIPT = [
  "set -eu",
  'gh="$1"; repo="$2"; shift 2',
  `ids=$("$gh" api "repos/$repo/hooks" --jq '.[] | select(.config.url == "${FORWARDER_HOOK_URL}") | .id')`,
  'for id in $ids; do "$gh" api -X DELETE "repos/$repo/hooks/$id" >/dev/null; echo "deleted stale forwarder hook $id on $repo" >&2; done',
  'exec "$@"',
].join("\n");

/** The argv of one forwarder start. */
export function forwardArgv(opts: {
  tools: GhTools;
  repo: string;
  url: string;
  secret: string;
  events: readonly string[];
}): string[] {
  return [
    "/bin/sh",
    "-c",
    FORWARD_SCRIPT,
    "github-events-forward",
    opts.tools.gh,
    opts.repo,
    opts.tools.webhook,
    "forward",
    `--repo=${opts.repo}`,
    `--events=${opts.events.join(",")}`,
    `--url=${opts.url}`,
    `--secret=${opts.secret}`,
  ];
}
