// The served URL grammar of web artifacts — what a page's request path says
// about what it loads. A leaf with no imports, so a reader of a URL (the e2e
// harness's network-idle count, the agent browser's host) does not load the
// artifact build pipeline (vite, esbuild, rolldown) to ask.

/**
 * A worker tree's store-entry name prefix (`internal/worker-link.ts`): a dir of
 * links into the store, so pruning follows its links as served roots.
 */
export const WORKER_TREE_PREFIX = "worker-tree.";

/**
 * Where vite emits a worker chunk (`new SharedWorker(new URL(…), …)`) inside an
 * artifact dir — the ONLY thing an artifact keeps under it. Served as
 * `/artifacts/<dir>/assets/<name>-<hash>.js`.
 */
export const WORKER_ASSETS_DIR = "assets";

/**
 * Whether a served URL path is a module of a worker tree
 * (`/artifacts/worker-tree.<hash>/…/<file>.js`): a browser host's worker
 * entry and what it loads — nothing but a worker loads from a tree.
 */
export function isWorkerTreePath(pathname: string): boolean {
  const parts = pathname.split("/");
  // ["", "artifacts", "worker-tree.<hash>", …, <file>.js]
  return (
    parts.length >= 4 &&
    parts[0] === "" &&
    parts[1] === "artifacts" &&
    parts[2]!.startsWith(WORKER_TREE_PREFIX) &&
    parts.at(-1)!.endsWith(".js")
  );
}

/**
 * Whether a served URL path is a worker's script: an artifact's worker chunk
 * (`/artifacts/<dir>/assets/<file>.js`) or a module of a worker tree
 * (`isWorkerTreePath`). The e2e harness uses it to leave a worker's script
 * load out of its network-idle count: Playwright reports that load as the
 * page's request but never sees it finish (the response lands in the worker's
 * target).
 */
export function isWorkerChunkPath(pathname: string): boolean {
  if (isWorkerTreePath(pathname)) return true;
  const parts = pathname.split("/");
  // ["", "artifacts", <dir>, "assets", <file>.js]
  return (
    parts.length === 5 &&
    parts[0] === "" &&
    parts[1] === "artifacts" &&
    parts[3] === WORKER_ASSETS_DIR &&
    parts[4]!.endsWith(".js")
  );
}
