import { isNotNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/saved-sources/server";
import { _supervisorRoles } from "./tables";

/** Every role's icon (Haiku's pick or a person's), drawable at first paint. */
export const supervisorRoleIconsSource = defineSavedIconSource({
  code: import.meta,
  id: "supervisor-roles.icons",
  kind: "tables",
  tables: [_supervisorRoles],
  names: async () =>
    (
      await db
        .selectDistinct({ icon: _supervisorRoles.icon })
        .from(_supervisorRoles)
        .where(isNotNull(_supervisorRoles.icon))
    ).flatMap((r) => (r.icon === null ? [] : [r.icon])),
});
