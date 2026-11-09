import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import {
  computerFileExtract,
  computerFileMove,
  computerFileOpen,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { extractHostArchive } from "../../server/internal/extract";
import { moveHostPaths } from "../../server/internal/move";
import { openHostPath } from "../../server/internal/open";
import { resolveHostPath } from "../../server/internal/path";

// host-fs's routes: every one reads or changes the host filesystem, so each
// endpoint is declared `needsMachine` and served here — a host without the
// computer (the in-browser demo) answers it unavailable without a request.
// The writes (open, extract, move) are file-systems' `computer` endpoints; the
// reads a surface makes (stat, complete, …) are live values (`./reads.ts`,
// `./complete.ts`); `raw` (file-systems' `computerFileRaw`, `./file-system.ts`) stays a route because a byte URL is an asset.
// Who may call them is the socket host's principal gate, not a per-route
// Origin check: every route here is owner-only (no `access: { public }`), so a
// foreign site is refused before a handler runs (`framework/principal`).

export const handleOpen = implementMachine(computerFileOpen, ({ body }) => {
  if (process.platform !== "darwin") {
    throw new HttpError(
      501,
      `Open with default app is macOS-only (this host is ${process.platform})`,
    );
  }
  return openHostPath(resolveHostPath(body.path), body.reveal ?? false);
});

export const handleExtract = implementMachine(computerFileExtract, ({ body }) =>
  extractHostArchive(resolveHostPath(body.path)),
);

export const handleMove = implementMachine(computerFileMove, ({ body }) => {
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
