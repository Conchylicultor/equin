import { sharedMemo } from "@plugins/packages/plugins/shared-work/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { codeCheckoutOf } from "./code-checkout";
import { recordKey } from "./keys";
import { buildModuleGraph, type ModuleGraphInput } from "./module-graph";
import { npmCodeKey } from "./npm-identity";

// Per set: each producer module's identity, by its tag and URL.
const identitiesOf = sharedMemo(
  "plugin records",
  (_set: RepoFiles) => new Map<string, Promise<string>>(),
);

/**
 * A record producer's CODE identity: the Merkle key of the module at `url`
 * (its `import.meta.url`, or a URL resolved against it) and of the npm code
 * its closure imports, read from the checkout that module lives in
 * (`codeCheckoutOf`) — the set being processed when it is that checkout, this
 * process's own otherwise. So a fixture or a foreign checkout holds data only,
 * and no copy of the producer in it can stand in for the code that ran.
 *
 * Code is named by URL, never by a path of the set: there is no way to ask
 * for a producer's identity inside the file set it processes. `tag` separates
 * the uses (a scan's identity, a closure record's code part) so each keeps
 * the key spelling it was stored under.
 */
export function codeIdentity(
  input: ModuleGraphInput,
  url: string,
  tag: string,
): Promise<string> {
  const byModule = identitiesOf(input.snapshot);
  const memo = `${tag}\0${url}`;
  let id = byModule.get(memo);
  if (!id) {
    // The npm code is what the module's closure imports, closed over the
    // lockfile — never the whole lockfile, which would move every identity on
    // any package bump though most producers load no package.
    id = codeCheckoutOf(input, url).then(async ({ input: code, module }) => {
      const graph = await buildModuleGraph(code, [module]);
      return recordKey(
        tag,
        module,
        graph.keyOf(module),
        code.store.environment,
        await npmCodeKey(code.snapshot, graph.packages),
      );
    });
    byModule.set(memo, id);
  }
  return id;
}
