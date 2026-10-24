import { webDistDir } from "@plugins/infra/plugins/paths/server";
import { readFileSync } from "node:fs";

// The content identity of the frontend bundle this backend is serving, read
// from `dist/.build-graph` FRESH on every call — same rule, and same reason, as
// `getServerCommit` beside it: `./equin build` swaps the `dist` symlink
// (what the browser downloads) *before* it restarts this backend, so a value
// memoized at process start would disagree with the served bundle for the whole
// swap→restart window and leave the "Server updated" reload button stuck.
// Resolving through the same live symlink the gateway serves from is what makes
// the reported value always the one in the browser's hands.
//
// Unlike the build id this pin is a function of the composed graph, so two
// builds of an unchanged tree return the same value — a tab holding it is not
// asked to reload for a rebuild that changed nothing.
export function getServerGraphHash(): string | null {
  try {
    return readFileSync(`${webDistDir()}/.build-graph`, "utf8").trim() || null;
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- best-effort optional dotfile read; a missing/unreadable .build-graph (before the first build that writes one) legitimately means "graph unknown" → staleness detection inert, never a bug to surface
  } catch {
    return null;
  }
}
