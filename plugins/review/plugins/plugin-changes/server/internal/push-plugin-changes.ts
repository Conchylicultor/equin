import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  getRangeFiles,
  pushRangeReads,
  resolvePushRange,
} from "@plugins/code-explorer/server";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { buildPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { pushPluginChanges } from "../../shared/resources";
import { computePluginChanges } from "./compute-plugin-diff";
import { getMainRoot } from "./main-plugins-dir";
import type { PluginChangesResponse } from "../../core/protocol";

// Each step serves a waiting review pane and reads only the local repo; a minute
// is far past any useful answer, so only a wedged child reaches it.
const EXTRACT_TIMEOUT_MS = 60_000;

// `git archive -o <file>` then `tar -xf <file>`, never `git archive | tar -x`
// through `Bun.spawn`: Bun relays a child-to-child pipe through JS and can drop
// the stream's tail when the writer exits (the same loss that broke the DB fork).
async function extractPluginsAtSha(sha: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `review-${sha.slice(0, 8)}-`));
  const mainRoot = await getMainRoot();
  const archivePath = join(dir, "plugins.tar");
  const opts = { timeoutMs: EXTRACT_TIMEOUT_MS };
  const archive = await spawnCaptured(
    [
      GIT,
      "--no-optional-locks",
      "-C",
      mainRoot,
      "archive",
      "-o",
      archivePath,
      sha,
      "--",
      "plugins/",
    ],
    opts,
  );
  const tar =
    archive.exitCode === 0
      ? await spawnCaptured(["tar", "-xf", archivePath, "-C", dir], opts)
      : undefined;
  if (archive.exitCode !== 0 || tar?.exitCode !== 0) {
    await rm(dir, { recursive: true, force: true });
    const detail = tar
      ? `tar: ${tar.stderr}`
      : `git archive: ${archive.stderr}`;
    throw new Error(`Failed to extract plugins at ${sha}: ${detail}`);
  }
  await rm(archivePath);
  return dir;
}

/** The push `pushId` as its range (`resolvePushRange`), `baseSha..headSha`. */
async function loadPushPluginChanges(
  pushId: string,
): Promise<PluginChangesResponse> {
  const mainRoot = await getMainRoot();
  const range = await resolvePushRange(mainRoot, pushId);
  switch (range.kind) {
    case "no-push":
      throw pushPluginChanges.refuse("missing", `no push ${pushId}`);
    case "missing":
      throw pushPluginChanges.refuse(
        "missing",
        `a commit of push ${pushId} is not in the repository`,
      );
    case "no-base":
      throw pushPluginChanges.refuse(
        "no-base",
        `${range.first} is a root commit: push ${pushId} has no base to diff from`,
      );
    case "ok":
      break;
  }
  const { baseSha, headSha } = range;

  const editedFiles = await getRangeFiles(mainRoot, baseSha, headSha);
  if (!editedFiles) {
    throw new Error(`git diff ${baseSha} ${headSha} failed`);
  }

  return withHeavyReadSlot(async () => {
    const [baseDir, headDir] = await Promise.all([
      extractPluginsAtSha(baseSha),
      extractPluginsAtSha(headSha),
    ]);

    try {
      // base/head are immutable historical shas, but distinct per push range —
      // not worth a memo (unbounded growth). The runtime already shares one
      // load per tuple among its readers, and the heavy-read slot caps how many
      // run at once, so just build both trees inside the one slot.
      const [headTree, baseTree] = await Promise.all([
        buildPluginTree(join(headDir, "plugins"), {
          skipBarrelImport: true,
          facets: true,
        }),
        buildPluginTree(join(baseDir, "plugins"), {
          skipBarrelImport: true,
          facets: true,
        }),
      ]);
      const plugins = computePluginChanges(headTree, baseTree, editedFiles);
      return { plugins };
    } finally {
      await Promise.all([
        rm(baseDir, { recursive: true, force: true }),
        rm(headDir, { recursive: true, force: true }),
      ]);
    }
  });
}

// External: the truth is two commits' plugin trees in git, read through `git
// archive`, which never move once the range is known — the range itself is the
// push's ledger rows, declared as the value's reads, so a row of the push
// landing recomputes it.
export const pushPluginChangesServed = serveValue(pushPluginChanges, {
  source: "external",
  changes: "notified",
  reads: pushRangeReads,
  loader: ({ pushId }) => loadPushPluginChanges(pushId),
});
