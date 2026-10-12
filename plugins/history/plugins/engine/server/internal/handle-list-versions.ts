import { and, desc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { listVersions } from "../../core/endpoints";
import type { Version } from "../../core/schemas";
import { _entityVersions } from "./tables";

// Version metadata for one entity, newest first. Metadata only — the snapshot
// blob is fetched per-version via `historyVersion` (the `history.version` live value).
export const handleListVersions = implement(
  listVersions,
  async ({ params }) => {
    const rows = await db
      .select({
        id: _entityVersions.id,
        sourceId: _entityVersions.sourceId,
        entityId: _entityVersions.entityId,
        label: _entityVersions.label,
        author: _entityVersions.author,
        pinned: _entityVersions.pinned,
        createdAt: _entityVersions.createdAt,
      })
      .from(_entityVersions)
      .where(
        and(
          eq(_entityVersions.sourceId, params.sourceId),
          eq(_entityVersions.entityId, params.entityId),
        ),
      )
      .orderBy(desc(_entityVersions.createdAt));

    return rows satisfies Version[];
  },
);
