import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { writeFile, mkdir } from "node:fs/promises";
import { stat } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { worktreeDataDir } from "@plugins/infra/plugins/paths/server";
import { captureHeapSnapshot } from "../../shared/endpoints";

// Heavy, manual debug action. `Bun.generateHeapSnapshot("v8")` walks the FULL
// object graph SYNCHRONOUSLY — it blocks the event loop for the duration
// (seconds on a multi-GB heap) and returns a V8 `.heapsnapshot` JSON string
// (loadable in Chrome DevTools / VS Code) that can be hundreds of MB on disk.
// Only ever invoked on an explicit user click; never polled.
export const handleCaptureSnapshot = implement(
  captureHeapSnapshot,
  async () => {
    const capturedAtMs = Date.now();
    const json = Bun.generateHeapSnapshot("v8");

  const dir = worktreeDataDir(runtimeNamespace());
    await mkdir(dir, { recursive: true });
  const path = join(dir, `heap-${capturedAtMs}.heapsnapshot`);
    await writeFile(path, json);

    return { path, sizeBytes: (await stat(path)).size, capturedAtMs };
  },
);
