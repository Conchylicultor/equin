import { z } from "zod";
import { idKindField } from "@plugins/ids/core";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import {
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  parseSavedSymbolName,
  SavedSymbolNameSchema,
} from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { conversationSectionIdKind } from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import { supervisorRoleIdKind } from "./id-kinds";

/**
 * The most roles one install holds. A role is a long-lived area of
 * responsibility the user names by hand (Harness, App perf, Bug reports,
 * Misc…) — a handful — and every agent's system prompt lists the listed ones,
 * so the set is read whole. The create endpoint refuses one more, so the
 * collection's `max` is a guarantee of the writes.
 */
export const SUPERVISOR_ROLES_MAX = 50;

/**
 * One supervisor role: a named area of responsibility whose backlog its
 * supervisor sessions work through.
 *
 * - `icon` — picked by Haiku from the name and description (re-picked when
 *   either changes) unless `iconByUser`: a person's pick is never re-picked.
 *   Null until the first pick lands (and on a host without a model).
 * - `listed` — whether every agent's system prompt lists the role (and so
 *   whether `add_task` may name it).
 * - `description` — what agents read in that list to decide where to file.
 * - `prompt` — the brief each of the role's sessions is launched with.
 * - `section` — the sidebar queue section each new session lands in (a user
 *   section, `csec-…`); `null` is the Queue. Deleting the section clears it.
 */
export const supervisorRoleFields = {
  id: idKindField(supervisorRoleIdKind),
  name: textField({ label: "Name" }),
  icon: nullable(
    parsedTextField(SavedSymbolNameSchema, {
      // Never reached: the column is nullable with no DB default.
      default: parseSavedSymbolName("support-agent"),
    }),
  ),
  iconByUser: boolField({ label: "Icon picked by hand", default: false }),
  listed: boolField({ label: "Listed to agents", default: true }),
  description: textField({ label: "Description" }),
  prompt: textField({ label: "Prompt" }),
  section: nullable(idKindField(conversationSectionIdKind)),
  createdAt: dateField({ label: "Created" }),
} satisfies FieldsRecord;

/** The `supervisor_roles` entity. */
export const supervisorRolesEntityRef = entityRef(
  "supervisor_roles",
  supervisorRoleFields,
);

export const SupervisorRoleSchema = fieldsToZodObject(supervisorRoleFields);
export type SupervisorRole = z.infer<typeof SupervisorRoleSchema>;

/**
 * Every role, by name — the WHOLE set (`all`): the Supervisors pane lists
 * them all, the `supervisor` field's options are all of them, and the set is
 * capped at {@link SUPERVISOR_ROLES_MAX} by the create endpoint.
 */
export const supervisorRoles = liveCollection("supervisor-roles.all", {
  from: supervisorRolesEntityRef,
  pick: ["name", "listed", "description", "createdAt"],
  carry: { pick: ["id", "icon", "iconByUser", "prompt", "section"] },
  id: "id",
  all: {
    orderBy: [["name", "asc"]],
    max: SUPERVISOR_ROLES_MAX,
  },
});
