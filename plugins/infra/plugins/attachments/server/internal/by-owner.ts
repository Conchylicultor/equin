import { getTableName } from "drizzle-orm";
import {
  serveValue,
  type FollowBuilder,
} from "@plugins/network/plugins/live/server";
import {
  followsAtBind,
  type Follow,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import {
  attachmentRows,
  attachmentsByOwner,
  type AttachmentLinkRow,
} from "../../core";
import { Attachments } from "./attachments";
import { getRegisteredLinks } from "./define-link";
import { attachmentRowsServed } from "./file";

/** The follow name of an owner type's link set. */
const linkFollow = (ownerType: string) => `link:${ownerType}` as const;

type Subject = { ownerType: string; id: string };
type AttachmentRow =
  typeof attachmentRows extends LiveRowsCollection<infer R> ? R : never;
/** Each contributed owner type's link set, then the attachments they name. */
type OwnerFollows = { readonly attachments: Follow<AttachmentRow> } & {
  readonly [K in `link:${string}`]: Follow<AttachmentLinkRow>;
};

// One follow per contributed link set (`Attachments.Link`), built at the
// bind once every owner has contributed — the value names no owner. A
// subject reads only its own owner type's set (every other answers `null`),
// then the attachments that set names (`follow.from`). So a link written for
// another owner, or another attachment's row, reaches no reader.
// Built at the bind, so a process holding no owner plugin builds none.
function ownerFollows(follow: FollowBuilder<Subject>): OwnerFollows {
  const contributed = Attachments.Link.getContributions();
  const types = new Set<string>();
  for (const { link } of contributed) {
    if (types.has(link.ownerType)) {
      throw new Error(
        `attachments.by-owner: owner type "${link.ownerType}" is contributed twice (\`Attachments.Link\`) — one link set per owner table.`,
      );
    }
    types.add(link.ownerType);
  }
  const links = Object.fromEntries(
    contributed.map(({ link, served }) => [
      linkFollow(link.ownerType),
      follow(served, ({ ownerType, id }) =>
        ownerType === link.ownerType ? { where: { ownerId: id } } : null,
      ),
    ]),
  );
  return {
    ...links,
    attachments:
      contributed.length === 0
        ? // No owner in this process (a test runner's): nothing names a row.
          follow(attachmentRowsServed, () => null)
        : follow.from(links, attachmentRowsServed, (_s, rows) => ({
            ids: Object.values(rows).flatMap((set) =>
              set.map((l) => l.attachmentId),
            ),
          })),
  };
}

// The owner's link set in its order (linked first, first), each with its
// attachment's row. The two are read one after the other, so an attachment
// deleted between them (its link cascades with it) is left out — that delete
// reaches the tuple and re-reads it. Strips the server-only `diskPath` so
// the payload matches the wire `AttachmentSchema`.
export const attachmentsByOwnerServed = serveValue(attachmentsByOwner, {
  source: "db",
  follows: followsAtBind<Subject, OwnerFollows>(ownerFollows),
  loader: ({ ownerType }, { followed }) => {
    const set = followed[linkFollow(ownerType)];
    if (set === undefined) {
      // Linked (`defineLink`) but never contributed: a wiring bug, reported
      // — not a refusal the reader renders and nobody hears of. (Checked at
      // read, not at bind: a process may load an owner's tables without its
      // plugin, a test runner's included.)
      if (
        getRegisteredLinks().some(
          (l) => getTableName(l.table) === `${ownerType}_attachments`,
        )
      ) {
        throw new Error(
          `attachments.by-owner: "${ownerType}" links attachments (\`Attachments.defineLink\`) but contributes no \`Attachments.Link({ link, served })\` — serve its link collection and contribute it.`,
        );
      }
      throw attachmentsByOwner.refuse(
        "unknown-owner-type",
        `Unknown attachment owner type: ${ownerType}`,
      );
    }
    const byId = new Map(followed.attachments.map((a) => [a.id, a]));
    return set.flatMap((l) => {
      const att = byId.get(l.attachmentId);
      if (att === undefined) return [];
      const { diskPath: _diskPath, ...wire } = att;
      return [{ ...wire, createdAt: att.createdAt.toISOString() }];
    });
  },
});
