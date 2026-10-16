import { isNotNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/sprites/server";
import { _agents } from "./tables";

/** Every agent's avatar icon, so agent avatars are drawable at first paint. */
export const agentIconsSource = defineSavedIconSource({
  id: "conversations.agents",
  tables: [_agents],
  names: async () =>
    (
      await db
        .selectDistinct({ icon: _agents.icon })
        .from(_agents)
        .where(isNotNull(_agents.icon))
    ).flatMap((r) => (r.icon === null ? [] : [r.icon])),
});
