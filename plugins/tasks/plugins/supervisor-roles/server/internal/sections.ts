import { SystemPrompt } from "@plugins/conversations/plugins/system-prompt/server";
import { getConfig } from "@plugins/config_v2/server";
import {
  conversationMandate,
  grantOf,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { tasksFile } from "@plugins/tasks/plugins/tasks-core/core";
import { mandateIsKindOf } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { supervisorMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import { supervisorRoleMandate } from "../../core";
import { supervisorPromptConfig } from "../../core";
import {
  FALLBACK_ROLE_REF,
  getSupervisorRole,
  listSupervisorRoles,
  supervisorOfTask,
} from "./roles";

/**
 * The listed roles, for an agent whose mandate lets it file into a backlog
 * (`tasks.file` with `backlog`): one item each — name, id, description (its
 * further lines indented under the item) — and how to file. Nothing when no
 * role is listed and none is the fallback.
 */
export async function renderSupervisorRoles(
  conversationId: string,
): Promise<string | null> {
  const grant = await grantOf(tasksFile, conversationId);
  if (grant?.backlog !== true) return null;
  const roles = await listSupervisorRoles();
  const listed = roles.filter((r) => r.listed);
  const fallback = roles.find((r) => r.fallback);
  if (listed.length === 0 && !fallback) return null;
  const lines = listed.map((r) => {
    // A multi-line description stays inside its list item.
    const description = r.description.trim().replace(/\n/g, "\n  ");
    return `- **${r.name}** (\`${r.id}\`)${description ? ` — ${description}` : ""}`;
  });
  return [
    "## Supervisor roles",
    "",
    'Work that is not part of your own task — a problem you found, a follow-up some other area owns — can be handed to a supervisor role instead of filed under your task: `add_task` with `supervisor: "<role id>"` and `start: "manual"` files it into that role\'s backlog, where it waits until a session of the role adopts it.',
    ...(lines.length > 0 ? ["", "Roles:", ...lines] : []),
    ...(fallback
      ? [
          "",
          `When no role fits, pass \`supervisor: "${FALLBACK_ROLE_REF}"\` (→ ${fallback.name}).`,
        ]
      : []),
  ].join("\n");
}

/**
 * The shared supervisor prompt, for the conversation at the ROOT of a
 * supervisor mandate (an ad-hoc supervisor, or a role's session) — never a
 * worker below it. A role session also reads which role it works for.
 * Nothing when neither has anything to say.
 */
export async function renderSupervisorPrompt(
  conversationId: string,
): Promise<string | null> {
  const mandate = await conversationMandate(conversationId);
  if (mandate.kind === "none" || mandate.at !== "root") return null;
  if (!mandateIsKindOf(mandate.mandateId, supervisorMandate)) return null;
  const isRole = mandate.mandateId === supervisorRoleMandate.id;
  const parts: string[] = [];
  if (isRole) {
    const roleId = await supervisorOfTask(mandate.rootTaskId);
    const role = roleId === null ? null : await getSupervisorRole(roleId);
    if (role === null)
      throw new Error(
        `Task ${mandate.rootTaskId} states the supervisor-role mandate but owns no existing supervisor role.`,
      );
    parts.push(
      `You are this session of the **${role.name}** supervisor role (\`${role.id}\`): work through its backlog (\`backlog\` lists it, \`adopt_task\` moves a task into your tree and arms it), route what belongs elsewhere (\`route_task\`), and manage every task the role owns — its backlog and its earlier sessions — with \`edit_task\` / \`drop_task\`. Your task's description is the role's brief.`,
    );
  }
  const shared = getConfig(supervisorPromptConfig).prompt.trim();
  if (shared) parts.push(shared);
  if (parts.length === 0) return null;
  return ["## Supervisor", "", parts.join("\n\n")].join("\n");
}

export const supervisorRolesSection = SystemPrompt.Section({
  id: "supervisor-roles",
  label: "Supervisor roles",
  render: renderSupervisorRoles,
});

export const supervisorPromptSection = SystemPrompt.Section({
  id: "supervisor-prompt",
  label: "Supervisor prompt",
  render: renderSupervisorPrompt,
});
