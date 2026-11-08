import { isNotNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineSavedIconSource } from "@plugins/ui/plugins/icons/plugins/saved-sources/server";
import { _places } from "./tables";

/**
 * Every place's own icon (Haiku's pick, or the user's), so a pin is drawable
 * at first paint. A tag's icon is the tag tree's source (`serveTagTree`).
 */
export const placeIconsSource = defineSavedIconSource({
  code: import.meta,
  id: "places.places",
  kind: "tables",
  tables: [_places],
  names: async () =>
    (
      await db
        .selectDistinct({ icon: _places.icon })
        .from(_places)
        .where(isNotNull(_places.icon))
    ).flatMap((r) => (r.icon === null ? [] : [r.icon])),
});
