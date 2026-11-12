import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";

export { closureChangedSince, sourceDigest } from "../shared/digest";

export default {
  description:
    "Central's reach to the source-digest closure walk: closureChangedSince(entries, sinceMs) — whether nothing a closure loads (repo files, package resolution entries) changed since an instant, by inode change time — and sourceDigest(sets), the digest of the code a set loads. The same walk the server barrel serves (shared/), so central reads its code exactly as a backend does: restart-skip's judgement, and central's own code build (build/central-build-id).",
} satisfies CentralPluginDefinition;
