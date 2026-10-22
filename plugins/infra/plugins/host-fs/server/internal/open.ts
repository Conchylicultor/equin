import { stat } from "node:fs/promises";
import { namespaceFromHost } from "@plugins/infra/plugins/namespace/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import type { HostFsOpenResult } from "../../core";
import { locateHostPath } from "./archive/locate";
import { classifyFsError } from "./path";

// `open` hands the path to LaunchServices and returns at once; ten seconds is
// far past any healthy answer, so only a wedged child reaches it.
const OPEN_TIMEOUT_MS = 10_000;

/**
 * Whether a request's `Origin` is one of the app's own: a namespace the gateway
 * serves (`<namespace>.localhost`, read with the gateway's own grammar). A missing or
 * `null` Origin is refused too — every browser sends Origin on a POST, so
 * its absence never means "the app".
 */
export function isAppOrigin(origin: string | null): boolean {
  if (origin === null || !URL.canParse(origin)) return false;
  return namespaceFromHost(new URL(origin).host) !== null;
}

/** The argv that opens `path` with its default app, or reveals it in the Finder. */
export function openArgv(path: string, reveal: boolean): string[] {
  // `path` is absolute (resolveHostPath), so it can never be read as a flag;
  // it is one argv element, never a shell string.
  return reveal ? ["open", "-R", path] : ["open", path];
}

export async function openHostPath(
  path: string,
  reveal: boolean,
): Promise<HostFsOpenResult> {
  const located = await locateHostPath(path);
  if (located.kind === "archive") {
    // A member has no file of its own: reveal shows the archive that holds it,
    // and there is nothing on disk to hand a default app.
    if (!reveal) return { kind: "in-archive", path, archive: located.file };
  }
  const target = located.kind === "archive" ? located.file : path;
  try {
    await stat(target);
  } catch (err) {
    return { kind: classifyFsError(err), path: target };
  }
  await spawnExpectOk(openArgv(target, reveal), { timeoutMs: OPEN_TIMEOUT_MS });
  return { kind: "opened", path: target };
}
