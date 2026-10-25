import { getAttempt } from "@plugins/tasks/plugins/tasks-core/server";
import { ndjsonResponse } from "@plugins/infra/plugins/ndjson-stream/server";
import { orphanDirPath } from "./dirs";
import { reapAttempt } from "./reap";
import { refreshScannedRows } from "./scan-served";

export async function handleDelete(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const { id } = params;
  if (!id) return Response.json({ ok: false, error: "Missing id" }, { status: 400 });

  // An attempt row names the worktree when there is one; a dir orphan (listed by
  // the scan in entries.ts, reaped by the hourly job) has none, so its path is
  // resolved from the canonical dir instead. Requiring one or the other keeps
  // the 404 doing the work the attempt lookup used to: an id matching neither
  // reaches no filesystem or database step at all.
  const attempt = await getAttempt(id);
  const worktreePath = attempt?.worktreePath ?? (await orphanDirPath(id));
  if (!worktreePath) {
    return Response.json({ ok: false, error: "No such attempt or worktree" }, { status: 404 });
  }

  return ndjsonResponse(async (emit) => {
    // The reap's outcome is held, not emitted yet: the row re-read below runs
    // whatever the reap got through, and its own failure must neither stand
    // in for the reap's nor hide it — so it is a frame of its own.
    let reapError: unknown = undefined;
    try {
      await reapAttempt(id, {
        worktreePath,
        onStep: (step) => emit({ step }),
      });
    } catch (e) {
      reapError = e;
    }
    try {
      await refreshScannedRows([id]);
    } catch (e) {
      emit({ refreshError: String(e) });
    }
    emit(
      reapError === undefined
        ? { ok: true }
        : { ok: false, error: String(reapError) },
    );
  });
}
