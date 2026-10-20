import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { extractAttachmentIds } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/core";
import { assertChoiceLaunchable } from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { updateAgent } from "../../core";
import { AgentSchema } from "../../core";
import { _agents } from "./tables";
import { agentAttachments } from "./tables-attachments";
import { agents } from "./views";
import { isAgentDescendant } from "./hierarchy";
import { agentIdKind } from "../../core";

export const handleUpdate = implement(updateAgent, async ({ params, body }) => {
  const id = params.id;
  // `updatedAt` is derived (deriveUpdatedAt on `_agents`): the trigger bumps it
  // only when a counted column really changes, so the patch never names it.
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (body.prompt === null || typeof body.prompt === "string") {
    patch.prompt = body.prompt;
  }
  if (body.model === null || typeof body.model === "string") {
    if (body.model) assertChoiceLaunchable(body.model, getModelCatalog());
    patch.model = body.model;
  }
  if (body.icon !== undefined) patch.icon = body.icon;
  if (body.iconColor === null || typeof body.iconColor === "string") {
    patch.iconColor = body.iconColor;
  }
  if (body.parentId === null || typeof body.parentId === "string") {
    if (body.parentId === id) {
      throw new HttpError(400, "Cannot parent an agent to itself");
    }
    if (
      body.parentId !== null &&
      (await isAgentDescendant(id, body.parentId))
    ) {
      throw new HttpError(
        400,
        "Cannot parent an agent under its own descendant",
      );
    }
    patch.parentId = body.parentId;
  }
  // An empty patch has nothing to write (drizzle rejects an empty `set`): only
  // confirm the row exists, then answer it as it stands.
  const [updated] =
    Object.keys(patch).length === 0
      ? await db
          .select({ id: _agents.id })
          .from(_agents)
          .where(eq(_agents.id, agentIdKind.key(id)))
          .limit(1)
      : await db
          .update(_agents)
          .set(patch)
          .where(eq(_agents.id, agentIdKind.key(id)))
          .returning({ id: _agents.id });
  if (!updated) throw new HttpError(404, "Not found");
  // No destination force-expand on a re-parent: expand/collapse is device-local
  // view state owned by the data-view primitive, not a column. `TreeList.
  // onDragEnd` opens a collapsed drop target client-side, and the destination
  // folder's `updatedAt` is not a fact about the folder.

  if (body.prompt === null || typeof body.prompt === "string") {
    const [{ prompt } = { prompt: null }] = await db
      .select({ prompt: _agents.prompt })
      .from(_agents)
      .where(eq(_agents.id, agentIdKind.key(id)))
      .limit(1);
    await agentAttachments.set(
      id,
      Array.from(extractAttachmentIds(prompt ?? "")),
    );
  }

  const [row] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentIdKind.key(id)))
    .limit(1);
  if (!row) throw new HttpError(404, "Not found after update");
  return AgentSchema.parse(row);
});
