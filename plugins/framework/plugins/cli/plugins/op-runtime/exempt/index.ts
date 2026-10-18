import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "watcher-safety/no-raw-fs-watch",
    paths: ["cli/admission-valve.ts"],
    kind: "sanctioned",
    reason:
      "The build admission valve, in the CLI process, while a background build is HELD for host duress: a one-shot wake on ONE latch file (unlink or mtime bump), raced against a computed lease deadline and closed on the first event. It runs precisely when the box is in trouble, so it takes the lightest possible watch — a single non-recursive fs.watch on one directory, filtered to one filename — rather than loading @parcel/watcher's native addon and a recursive, debounced subscription for a single wake-up. A foreground wait, not background activity: there is no catalog entry to report into.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/build-receipt.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
