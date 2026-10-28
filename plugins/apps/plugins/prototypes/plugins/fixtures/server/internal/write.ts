import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  PrototypeHistoryStore,
  settlePrototypesWatcher,
} from "@plugins/apps/plugins/prototypes/plugins/files/server";
import { prototypeTagIdKind } from "@plugins/apps/plugins/prototypes/plugins/state/core";
import {
  _prototypeState,
  _prototypeTags,
} from "@plugins/apps/plugins/prototypes/plugins/state/server";
import { thumbnailCache } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/server";
import { db } from "@plugins/database/server";
import {
  parseRelPath,
  stageThenRename,
  type FileData,
  type Mount,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  auditPrototypeFixtureThumbnails,
  parsePrototypeTree,
  prototypeFixtureStates,
  type ParsedPrototypeTree,
  type PrototypeFixture,
} from "../../core";

const writer = systemOrigin("prototype fixture");

/**
 * Write a prototype fixture into a running host — its graph booted and past
 * `onReady`, so the tree's watcher, its history adoption and the thumbnails
 * sync are live and do their own work on it — in the order a real tree grew:
 *
 * 1. the thumbnails, into the cache root, FIRST: a host with no renderer
 *    answers a cache miss as `unavailable` and never looks again, so every
 *    version's picture must already be there when the watcher first sees its
 *    folder. A version with no PNG is refused before anything is written
 *    (the check `prototypeFixtureThumbnailsCheck` catches it at build);
 * 2. each folder as it first was (`v0`), built out of sight and renamed into
 *    the `prototypesFiles` root in one move (`stageThenRename`, as a mint
 *    does), so the watcher never adopts a half-written folder;
 * 3. the watcher settled: it has adopted each folder's history (`v0`) — the
 *    real path for a folder that appeared without the mint — asserted here;
 * 4. each step: its files laid over the folder, then recorded as a `turn`
 *    version through the host's `PrototypeHistoryStore`;
 * 5. the record files (`_picks/<id>.json`), and the watcher settled again;
 * 6. the gallery's rows: the tags (in the order given), each prototype's
 *    tag and pin.
 *
 * Through the roots' own writes on any host: memory in a browser host, the
 * computer's disk on the desktop. Loud on a tree the layout does not allow, a
 * history the watcher did not adopt, or a step the store did not record.
 * Returns the parsed tree, for a caller that asserts on what was written.
 */
export async function writePrototypeFixture(
  fixture: PrototypeFixture,
): Promise<ParsedPrototypeTree> {
  const parsed = parsePrototypeTree(fixture.tree);
  const states = prototypeFixtureStates(parsed, fixture);
  const { missing } = auditPrototypeFixtureThumbnails(
    parsed,
    fixture.thumbnails,
  );
  if (missing.length > 0)
    throw new Error(
      `[prototype fixture] no thumbnail for ${missing.join(", ")} — re-render the fixture's thumbnails (plugins/apps/plugins/prototypes/plugins/fixtures/scripts/render-fixture-thumbnails.ts)`,
    );

  await writeFiles(
    thumbnailCache,
    Object.fromEntries(
      Object.entries(fixture.thumbnails).map(([key, png]) => [
        `${key}.png`,
        png,
      ]),
    ),
  );

  for (const p of parsed.prototypes) {
    const outcome = await stageThenRename(
      prototypesFiles,
      parseRelPath(p.id),
      (staging) =>
        writeFiles(prototypesFiles, p.versions[0]!.files, `${staging}/`),
      writer,
    );
    if (outcome !== "renamed")
      throw new Error(
        `[prototype fixture] ${p.id} is already in the prototypes tree`,
      );
  }

  await settlePrototypesWatcher();
  const history = PrototypeHistoryStore.get();
  // The stamps, not `readHistory` — which adopts on a first read, and so
  // would answer for an adoption the watcher never made.
  const adopted = await history.readVersionCounts();
  for (const p of parsed.prototypes) {
    if (adopted[p.id] !== 1)
      throw new Error(
        `[prototype fixture] the watcher did not adopt ${p.id}'s history (${adopted[p.id] ?? "no"} versions recorded)`,
      );
    for (const version of p.versions.slice(1)) {
      await writeFiles(prototypesFiles, version.changed, `${p.id}/`);
      const recorded = await history.checkpoint(p.id, {
        kind: "turn",
        subject: version.subject,
        ...(version.body === "" ? {} : { body: version.body }),
      });
      if (recorded.kind !== "recorded")
        throw new Error(
          `[prototype fixture] ${p.id} v${version.n} was not recorded: ${recorded.kind}`,
        );
    }
  }
  await writeFiles(prototypesFiles, parsed.records);
  await settlePrototypesWatcher();

  const tags = fixture.tags ?? [];
  const ranks = Rank.nBetween(null, null, tags.length);
  for (const [i, tag] of tags.entries())
    await db.insert(_prototypeTags).values({
      id: prototypeTagIdKind.parse(tag.id),
      name: tag.name,
      parentId: null,
      color: tag.color,
      childColors: null,
      icon: null,
      rank: ranks[i]!.toJSON(),
    });
  for (const state of states)
    await db.insert(_prototypeState).values({
      id: protoIdKind.parse(state.id),
      tagId:
        state.tagId === null ? null : prototypeTagIdKind.parse(state.tagId),
      pinned: state.pinned,
    });

  return parsed;
}

/** Write each file (path → data) into `mount`, under `prefix`. */
async function writeFiles(
  mount: Mount,
  files: Readonly<Record<string, FileData>>,
  prefix = "",
): Promise<void> {
  for (const [path, data] of Object.entries(files))
    await mount.write(parseRelPath(`${prefix}${path}`), data, { writer });
}
