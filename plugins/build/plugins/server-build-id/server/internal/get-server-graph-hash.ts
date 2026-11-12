import { webDistDir } from "@plugins/infra/plugins/paths/server";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";

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
export async function getServerGraphHash(): Promise<string | null> {
  try {
    return (
      (await readFile(`${webDistDir()}/.build-graph`, "utf8")).trim() || null
    );
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- best-effort optional dotfile read; a missing/unreadable .build-graph (before the first build that writes one) legitimately means "graph unknown" → staleness detection inert, never a bug to surface
  } catch {
    return null;
  }
}

// The central build the served page was built against, read from the served
// dist's `.central-build` (written by compose beside the page that bakes it as
// VITE_CENTRAL_BUILD). What a reload brings a tab for central's values: the
// backend names it on its ack frames (`setServedCentralBuild`), so a tab can
// tell a central value a reload fixes from one no reload can.
export async function getServedCentralBuild(): Promise<string | null> {
  try {
    return (
      (await readFile(`${webDistDir()}/.central-build`, "utf8")).trim() || null
    );
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- best-effort optional dotfile read, the `.build-graph` sibling's rule: a dist composed before the trailer existed, or a page naming no central build (a release), legitimately means "unnamed" — the tab then keeps central's `skew` reading as before, never claiming a `deploy-skew` it cannot see
  } catch {
    return null;
  }
}
