import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { restoreVersion } from "../../core";
import { recordVersion } from "./record-version";
import { getHistorySource } from "./registry";
import { versionIdKind } from "../../core";
import { _entityVersions } from "./tables";

// Reversible replace. First snapshot the current state as a distinct "Before
// restore" undo point (force: true bypasses the coalescing window so it
// survives), then load the chosen version and hand its snapshot to the source's
// `restore`. 404s cleanly if the source is unregistered or the version is
// missing.
export const handleRestoreVersion = implement(
  restoreVersion,
  async ({ params }) => {
    const source = getHistorySource(params.sourceId);
    if (!source) throw new HttpError(404, "History source not found");

    // Save current state as a reversible undo point before replacing. Pinned so
    // the post-restore auto-snapshot can't coalesce over it.
    await recordVersion(params.sourceId, params.entityId, {
      pin: true,
      label: "Before restore",
    });

    const [row] = await db
      .select()
      .from(_entityVersions)
      .where(
        and(
          eq(_entityVersions.id, versionIdKind.key(params.versionId)),
          eq(_entityVersions.sourceId, params.sourceId),
          eq(_entityVersions.entityId, params.entityId),
        ),
      )
      .limit(1);

    if (!row) throw new HttpError(404, "Version not found");

    await source.restore(params.entityId, row.snapshot);

    return { ok: true as const };
  },
);
