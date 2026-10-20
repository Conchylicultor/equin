import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { createConversation } from "@plugins/conversations/server";
import {
  DEFAULT_MODEL_CHOICE,
  assertChoiceLaunchable,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { launchAgent } from "../../core";
import {
  _agent_launches,
  agents,
} from "@plugins/conversations/plugins/agents/server";
import { assertClaudeCodeReady } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { agentIdKind, agentLaunchIdKind } from "../../core";

function formatLaunchTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export const handleLaunch = implementMachine(
  launchAgent,
  async ({ params, body }) => {
    const agentId = params.id;

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentIdKind.key(agentId)))
    .limit(1);
  if (!agent) throw new HttpError(404, "Not found");
  if (!agent.prompt) {
    throw new HttpError(400, "Agent has no prompt (folder node)");
  }
  // Before the launch's task is filed, so a refusal leaves nothing behind.
  await assertClaudeCodeReady();

  // A model choice (family or pinned version); the spawn resolves it. Checked
  // here, before the launch's task is filed: a request naming a version this
  // machine cannot run — or an agent whose saved version was retired since —
  // is a 400 listing what can run, and leaves nothing behind.
  const model = body.model ?? agent.model ?? DEFAULT_MODEL_CHOICE;
  assertChoiceLaunchable(model, getModelCatalog());

  const now = new Date();
  const task = await createTask({
    title: `Agent-${agent.name}-${formatLaunchTime(now)}`,
    author: "agents-plugin",
  });
  await setTaskCategory(task.id, "agents");

  const conversation = await createConversation({
    taskId: task.id,
    prompt: agent.prompt,
    model,
    spawnedBy: "agents-plugin",
    kind: "agent",
  });

  const launchId = agentLaunchIdKind.mint();
  await db
    .insert(_agent_launches)
    .values({ id: launchId, agentId, taskId: task.id });

  return {
    launchId,
    taskId: task.id,
    conversationId: conversation.id,
  };
});
