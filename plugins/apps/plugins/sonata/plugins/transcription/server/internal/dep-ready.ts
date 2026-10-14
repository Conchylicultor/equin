import {
  readyNow,
  type Dep,
  type DepSource,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";
import {
  onDepInstallSettled,
  requestDep,
} from "@plugins/infra/plugins/deps/server";

/**
 * `dep` installed, for a backend path that may wait but holds no
 * `ExecContext` (the scratch profile's `prepare`, in the spawn job): already
 * installed is one `readyNow`; otherwise the install is requested through the
 * `deps.install` job and this resumes when that run settles (pushed, no
 * polling), then reads the proof — a failed install throws its message.
 */
export async function awaitDepReady<S extends DepSource>(
  dep: Dep<S>,
  signal: AbortSignal,
): Promise<Ready<S>> {
  const now = await readyNow(dep);
  if (now.kind === "ready") return now.ready;

  let off = (): void => {};
  const settled = new Promise<void>((resolve, reject) => {
    off = onDepInstallSettled(dep, resolve);
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  try {
    // Subscribed first, so a run that settles at once is not missed. A
    // request made while an install runs elsewhere waits on its lock and
    // settles right after it.
    await requestDep(dep);
    await settled;
  } finally {
    off();
  }

  const after = await readyNow(dep);
  if (after.kind === "ready") return after.ready;
  throw new Error(
    after.kind === "failed"
      ? `[transcription] installing ${dep.id} failed: ${after.message}`
      : `[transcription] ${dep.id} is still ${after.kind} after its install settled`,
  );
}
