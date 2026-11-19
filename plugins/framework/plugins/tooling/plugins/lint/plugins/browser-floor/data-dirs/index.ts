import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The `browser-floor:vendor-sets` verdicts: one JSON per vendor set of the
 * web-artifact store (`<set>.json`, each file's content hash, regex count and
 * above-floor regexes), under the scanner's digest. A set is write-once, so its
 * memo stays true until its set leaves the store, when the probe deletes it.
 *
 * @see plugins/framework/plugins/tooling/plugins/lint/plugins/browser-floor/lint/vendor-scan-probe.ts
 */
export const vendorFloorScansDir = defineDataDir({
  kind: "cache",
  name: "browser-floor-vendor-scans",
  owner: "framework/tooling/lint/browser-floor",
  description:
    "Per vendor set of the web-artifact store, which of its regexes the browser floor lacks (by file content hash), so a set is parsed once; a memo whose set was pruned is deleted",
  reclaim: { kind: "safe" },
});

export default [vendorFloorScansDir];
