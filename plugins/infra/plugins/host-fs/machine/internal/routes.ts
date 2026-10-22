import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import {
  implementMachine,
  machineHandler,
} from "@plugins/infra/plugins/endpoints/machine";
import {
  hostFsComplete,
  hostFsExtract,
  hostFsMove,
  hostFsOpen,
  hostFsRaw,
  hostFsStat,
} from "../../core";
import { completeHostDir, splitPrefix } from "../../server/internal/complete";
import { extractHostArchive } from "../../server/internal/extract";
import { moveHostPaths } from "../../server/internal/move";
import { isAppOrigin, openHostPath } from "../../server/internal/open";
import { resolveHostPath } from "../../server/internal/path";
import { handleRaw as rawBytes } from "../../server/internal/raw";
import { statHostOrArchivePath } from "../../server/internal/stat";

// host-fs's routes: every one reads or changes the host filesystem, so each
// endpoint is declared `needsMachine` and served here — a host without the
// computer (the in-browser demo) answers it unavailable without a request.

export const handleStat = implementMachine(hostFsStat, ({ query }) =>
  statHostOrArchivePath(resolveHostPath(query.path)),
);

export const handleComplete = implementMachine(hostFsComplete, ({ query }) => {
  const { dir, fragment } = splitPrefix(query.prefix);
  return completeHostDir(dir, fragment);
});

/** The bytes: a raw handler (its own status and headers — 200 / 206 / 416). */
export const handleRaw = machineHandler(hostFsRaw, rawBytes);

export const handleOpen = implementMachine(hostFsOpen, ({ body, req }) => {
  if (!isAppOrigin(req.headers.get("origin"))) {
    throw new HttpError(
      403,
      "Open is only accepted from the app's own *.localhost origin",
    );
  }
  if (process.platform !== "darwin") {
    throw new HttpError(
      501,
      `Open with default app is macOS-only (this host is ${process.platform})`,
    );
  }
  return openHostPath(resolveHostPath(body.path), body.reveal ?? false);
});

export const handleExtract = implementMachine(
  hostFsExtract,
  ({ body, req }) => {
    if (!isAppOrigin(req.headers.get("origin"))) {
      throw new HttpError(
        403,
        "Extract is only accepted from the app's own *.localhost origin",
      );
    }
    return extractHostArchive(resolveHostPath(body.path));
  },
);

export const handleMove = implementMachine(hostFsMove, ({ body, req }) => {
  if (!isAppOrigin(req.headers.get("origin"))) {
    throw new HttpError(
      403,
      "Move is only accepted from the app's own *.localhost origin",
    );
  }
  const resolutions = new Map(
    Object.entries(body.resolutions ?? {}).map(
      ([source, resolution]) => [resolveHostPath(source), resolution] as const,
    ),
  );
  return moveHostPaths(
    body.sources.map((source) => resolveHostPath(source)),
    resolveHostPath(body.destDir),
    resolutions,
  );
});
