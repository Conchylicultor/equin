import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["shared/judge.ts", "shared/process-view.ts"],
    kind: "sanctioned",
    reason:
      "The restart-skip judgement reads the running process (its start, binary, entry, loader cache) and stats its files on disk: it exists only in a process running from source. In shared/ because both processes a deploy restarts serve it — the backend's machine half and central — and neither runtime may import the other's folder.",
  },
] satisfies Exemptions;
