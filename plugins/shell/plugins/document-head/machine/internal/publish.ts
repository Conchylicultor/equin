import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { DocumentHead, mergeHeadFragments } from "../../server";

/**
 * Keep `document-head.json` — what the gateway splices into the SPA shell —
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
  const file = worktreeArtifacts.documentHead(runtimeNamespace());
  const publish = createCoalescer({
    run: async () => {
      const rendered = await Promise.all(sources.map((s) => s.render()));
      writeAtomic(
        file,
        JSON.stringify({ v: 1, entries: mergeHeadFragments(rendered) }),
      );
    },
  });
  for (const source of sources) source.subscribe(() => publish.trigger());
  await publish.run();
}

// Temp file + rename: the gateway reads the file on every shell request and
// must never see half of one.
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
