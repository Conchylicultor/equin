import { serveValue } from "@plugins/network/plugins/live/machine";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { attemptWorkspacesServed } from "@plugins/tasks/plugins/tasks-core/server";
import {
  FILE_BYTES_MAX,
  checkoutFileBytes,
  checkoutFileRaw,
  checkoutFileText,
  type FileText,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { handleCheckoutFileRaw } from "../../server/internal/checkout-raw";
import { isAllowedRef, resolveRef } from "../../server/internal/resolve-ref";
import {
  workspaceAttemptIds,
  workspaceRootFrom,
  type WorkspaceRoot,
} from "../../server/internal/resolve-worktree-path";
import {
  getFileContent,
  getFileContentAtRef,
  type FileReadResult,
} from "./get-file-content";
import { watchWorkspaceFile } from "./file-values";
import { readWorkspaceBytes, workspaceFileSignature } from "./workspace-bytes";
import {
  checkoutRootOf,
  workspaceRootOf,
  type RefuseWorkspace,
  type WorkspaceFile,
} from "./workspace";

// A checkout as a file system (`{ fs: "checkout", checkout, path, version? }`):
// file-systems' `checkout` reads, answered by code-explorer's workspace reads —
// as on disk now (any workspace kind), or as of `version` (a checkout's ref,
// a git read). The workspace's root is its attempt row, FOLLOWED, as every
// code read's: only a write to that attempt's workspace reaches the tuple,
// and it re-points the watch.

/** A checkout location's question as the workspace file the code reads take. */
type CheckoutQuery = { checkout: string; path: string; version?: string };

function fileOf({ checkout, path, version }: CheckoutQuery): WorkspaceFile {
  return {
    workspace: checkout,
    path,
    ...(version !== undefined ? { ref: version } : {}),
  };
}

/** Where a message says the file is. */
function whereOf({ checkout, path, version }: CheckoutQuery): string {
  return `${checkout}:${path}${version === undefined ? "" : ` at ${version}`}`;
}

/** No workspace reads as the file not being there; a git read of a non-checkout is unsupported. */
const refuseWorkspace =
  (
    refuse: (code: "missing" | "unsupported", message: string) => Error,
  ): RefuseWorkspace =>
  (code, message) =>
    refuse(code === "no-workspace" ? "missing" : "unsupported", message);

/** The text a checkout read answers under the workspace's `root`, or its refusal. */
async function checkoutText(
  q: CheckoutQuery,
  root: WorkspaceRoot | null,
): Promise<FileText> {
  const refuse = checkoutFileText.refuse;
  let result: FileReadResult;
  if (q.version !== undefined) {
    const checkout = checkoutRootOf(root, q.checkout, refuseWorkspace(refuse));
    if (!isAllowedRef(q.version)) {
      throw refuse("invalid-path", `${JSON.stringify(q.version)} is not a ref`);
    }
    result = await getFileContentAtRef(
      checkout,
      q.path,
      await resolveRef(checkout, q.version),
    );
  } else {
    result = await getFileContent(
      workspaceRootOf(root, q.checkout, refuseWorkspace(refuse)),
      q.path,
    );
  }
  const where = whereOf(q);
  switch (result.kind) {
    case "ok":
      return {
        content: result.content,
        size: new TextEncoder().encode(result.content).length,
      };
    case "invalid-path":
      throw refuse(
        "invalid-path",
        `${JSON.stringify(q.path)} is not a path inside ${q.checkout}`,
      );
    case "not-found":
      throw refuse("missing", `No such file: ${where}`);
    case "too-large":
      throw refuse(
        "too-large",
        `${where} is ${result.size} bytes, over the text limit`,
      );
    case "binary":
      throw refuse("binary", `${where} is a binary file`);
    case "denied":
      throw refuse("denied", `Permission denied: ${where}`);
    case "unreadable-archive":
      throw refuse(
        "unsupported",
        `${where} cannot be read from its archive (${result.reason})`,
      );
  }
}

/** A checkout file's bytes under its `root`, or the refusal saying why there are none. */
async function checkoutBytes(
  q: CheckoutQuery,
  root: WorkspaceRoot | null,
): Promise<ArrayBuffer> {
  const refuse = checkoutFileBytes.refuse;
  const where = whereOf(q);
  const read = await readWorkspaceBytes(fileOf(q), root, FILE_BYTES_MAX);
  switch (read.kind) {
    case "ok": {
      const own = new Uint8Array(read.bytes.byteLength);
      own.set(read.bytes);
      return own.buffer;
    }
    case "too-large":
      throw refuse(
        "too-large",
        `${where} is ${read.size} bytes, over the ${FILE_BYTES_MAX}-byte limit`,
      );
    case "missing":
      throw refuse("missing", `No such file: ${where}`);
    case "no-workspace":
      throw refuse("missing", `No workspace ${q.checkout}`);
    case "denied":
      throw refuse("denied", `Permission denied: ${where}`);
    case "not-a-file":
      throw refuse("not-a-file", `Not a file: ${where}`);
    case "not-a-checkout":
      throw refuse(
        "unsupported",
        `${q.checkout} is not a git checkout, so it has no version to read ${q.path} at`,
      );
    case "unreadable-archive":
      throw refuse(
        "unsupported",
        `${where} cannot be read from its archive (${read.reason})`,
      );
    case "invalid-path":
      throw refuse(
        "invalid-path",
        `${JSON.stringify(q.path)} is not a path inside ${q.checkout}`,
      );
    case "invalid-ref":
      throw refuse(
        "invalid-path",
        `${JSON.stringify(q.version)} is not a ref of ${q.checkout}`,
      );
  }
}

/**
 * A checkout file's text, on demand: re-read over HTTP by each tab after a
 * watch invalidates it (`watchWorkspaceFile`), throttled — a commit or a
 * rebase writes many refs at once. The ETag is the file's revision.
 */
export const checkoutFileTextServed = serveValue(checkoutFileText, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(attemptWorkspacesServed, ({ checkout }) => ({
      ids: workspaceAttemptIds(checkout),
    })),
  }),
  throttleMs: 500,
  loader: async (q, { followed }) =>
    checkoutText(q, await workspaceRootFrom(q.checkout, followed.ws)),
  revalidate: async (q, { followed }) =>
    workspaceFileSignature(
      fileOf(q),
      await workspaceRootFrom(q.checkout, followed.ws),
    ),
  whileFollowing: {
    over: (followed) => followed.ws,
    start: async (q, { over: ws, notify }) =>
      watchWorkspaceFile(
        fileOf(q),
        await workspaceRootFrom(q.checkout, ws),
        () => notify(),
      ),
  },
});

/** A checkout file's bytes, on demand, invalidated as its text is. */
export const checkoutFileBytesServed = serveValue(checkoutFileBytes, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(attemptWorkspacesServed, ({ checkout }) => ({
      ids: workspaceAttemptIds(checkout),
    })),
  }),
  loader: async (q, { followed }) =>
    checkoutBytes(q, await workspaceRootFrom(q.checkout, followed.ws)),
  revalidate: async (q, { followed }) =>
    workspaceFileSignature(
      fileOf(q),
      await workspaceRootFrom(q.checkout, followed.ws),
    ),
  whileFollowing: {
    over: (followed) => followed.ws,
    start: async (q, { over: ws, notify }) =>
      watchWorkspaceFile(
        fileOf(q),
        await workspaceRootFrom(q.checkout, ws),
        () => notify(),
      ),
  },
});

/** `GET /api/files/checkout/raw` — a checkout file's raw bytes (its own status and headers). */
export const handleCheckoutRaw = machineHandler(
  checkoutFileRaw,
  handleCheckoutFileRaw,
);
