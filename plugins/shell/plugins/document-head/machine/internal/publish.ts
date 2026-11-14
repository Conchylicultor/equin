import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import {
  DocumentHead,
  frameAncestorsByPath,
  mergeHeadFragments,
} from "../../server";

/**
 * Keep `document-head.json` — what the gateway splices into the SPA shell, and
 * the `frameAncestors` policy it serves the shell under, per app path —
 * equal to what every `DocumentHead.Fragment` source answers now: rendered
 * once before this resolves (a failed first render fails the hook, loudly),
 * then again, coalesced, whenever a source says its answer changed (a failed
 * re-render is an unhandled rejection, loud too, and leaves the last good file).
 *
 * A file rather than an endpoint because the gateway serves the shell on its
 * own: it never waits for a backend to boot, so a page load starts painting
 * while the backend it prestarted is still coming up.
 */
export async function publishDocumentHead(): Promise<void> {
  const sources = DocumentHead.Fragment.getContributions();
  // Static: checked once, before anything is written, so a bad policy fails
  // the hook instead of shipping a shell the gateway would refuse to frame.
  const frameAncestors = frameAncestorsByPath(
    DocumentHead.FrameAncestors.getContributions(),
  );
  const file = worktreeArtifacts.documentHead(runtimeNamespace());
  const publish = createCoalescer({
    run: async () => {
      const rendered = await Promise.all(sources.map((s) => s.render()));
      await writeAtomic(
        file,
        JSON.stringify({
          v: 1,
          entries: mergeHeadFragments(rendered),
          frameAncestors,
        }),
      );
    },
  });
  for (const source of sources) source.subscribe(() => publish.trigger());
  await publish.run();
}

// Temp file + rename: the gateway reads the file on every shell request and
// must never see half of one. The coalescer runs one publish at a time, so
// the per-process temp name is never written twice at once.
async function writeAtomic(file: AppPath, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
