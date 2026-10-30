import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { nextRankUnder } from "@plugins/primitives/plugins/rank/server";
import { _conversationGroupMembers, _conversationGroups } from "./tables";
import { conversationGroupIdKind } from "../../core";

export async function addMembersToGroup(
  groupId: string,
  conversationIds: string[],
) {
  await db.transaction(async (tx) => {
    const [group] = await tx
      .select({ id: _conversationGroups.id })
      .from(_conversationGroups)
      .where(eq(_conversationGroups.id, conversationGroupIdKind.key(groupId)))
      .limit(1);
    if (!group) throw new Error(`Group ${groupId} not found`);
    for (const conversationId of conversationIds) {
      const rank = await nextRankUnder(
        _conversationGroupMembers,
        _conversationGroupMembers.groupId,
        groupId,
        tx,
      );
      // Upsert by PK so an already-grouped conversation is moved into this
      // group rather than rejected.
      await tx
        .insert(_conversationGroupMembers)
        .values({ conversationId, groupId, rank: rank.toJSON() })
        .onConflictDoUpdate({
          target: _conversationGroupMembers.conversationId,
          set: { groupId, rank: rank.toJSON(), createdAt: new Date() },
        });
    }
  });
}

export async function addMemberToGroup(
  groupId: string,
  conversationId: string,
) {
  return addMembersToGroup(groupId, [conversationId]);
}
