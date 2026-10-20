import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { ResourceRefusal } from "@plugins/packages/plugins/resource-protocol/core";
import {
  hostFsArchiveReasonMessage,
  type HostFsArchiveReason,
} from "../../core";
import { resolveHostPath } from "../../server/internal/path";

/** A declaration's typed `refuse` (see `liveValue`'s `refusals`). */
type Refuse<C extends string> = (code: C, message: string) => ResourceRefusal;

/**
 * The absolute host path `raw` names, or the read's `invalid-path` refusal —
 * the 400 every host-fs endpoint answered for a relative path or a NUL byte.
 * `undefined` / `""` is home, as for the endpoints.
 */
export function resolveOrRefuse<C extends string>(
  refuse: Refuse<C | "invalid-path">,
  raw: string | undefined,
): string {
  try {
    return resolveHostPath(raw);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) {
      throw refuse("invalid-path", err.message);
    }
    throw err;
  }
}

/** The absolute path `raw` names, or `null` when no read could take it (nothing to watch). */
export function resolvedOrNull(raw: string | undefined): string | null {
  try {
    return resolveHostPath(raw);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return null;
    throw err;
  }
}

/** A host-fs failure kind, as the endpoints answered it in their results. */
export type HostFsFailure =
  | { kind: "missing" | "denied" | "not-a-dir" | "not-a-file"; path: string }
  | {
      kind: "unreadable-archive";
      path: string;
      archive: string;
      reason: HostFsArchiveReason;
    };

/** The refusal a read answers for a failure its endpoint answered as a kind. */
export function refusalFor<K extends HostFsFailure["kind"]>(
  refuse: Refuse<K>,
  failure: HostFsFailure & { kind: K },
): ResourceRefusal {
  const code: K = failure.kind;
  // Narrowed apart from `K`, which a switch on the generic does not narrow.
  const f: HostFsFailure = failure;
  switch (f.kind) {
    case "missing":
      return refuse(code, `No such file or folder: ${f.path}`);
    case "denied":
      return refuse(code, `Permission denied: ${f.path}`);
    case "not-a-dir":
      return refuse(code, `Not a folder: ${f.path}`);
    case "not-a-file":
      return refuse(code, `Not a file: ${f.path}`);
    case "unreadable-archive":
      return refuse(
        code,
        `${hostFsArchiveReasonMessage(f.reason)}: ${f.archive}`,
      );
  }
}
