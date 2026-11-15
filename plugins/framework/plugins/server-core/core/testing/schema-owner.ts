import { schemaRoleFor, type SchemaOwner } from "../schema-role";

/** The token a serving host's boot hooks are handed (`BootHookContext.schema`). */
export function testSchemaOwner(): SchemaOwner {
  const role = schemaRoleFor("serve");
  if (role.kind !== "owner") throw new Error("serve must own its schema");
  return role.owner;
}
