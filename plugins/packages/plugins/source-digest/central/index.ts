import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";

export { closureChangedSince } from "../shared/digest";

export default {
  description:
    "Central's reach to the source-digest closure walk: closureChangedSince(entries, sinceMs) — whether nothing a closure loads (repo files, package resolution entries) changed since an instant, by inode change time. The same walk the server barrel serves (shared/), so central's restart-skip judgement reads its code exactly as a backend's does.",
} satisfies CentralPluginDefinition;
