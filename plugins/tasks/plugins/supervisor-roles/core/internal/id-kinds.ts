import { defineIdKind, type IdOf } from "@plugins/ids/core";

/** A supervisor role (`supervisor_roles.id`), minted when the user creates one. */
export const supervisorRoleIdKind = defineIdKind({
  prefix: "srole",
  label: "Supervisor role",
});

export type SupervisorRoleId = IdOf<typeof supervisorRoleIdKind>;
