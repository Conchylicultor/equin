import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { compileCreateView } from "@plugins/database/plugins/derived-views/core";
import { claudeSpendHoursView } from "../internal/views";

/**
 * Create the priced view (`claude_spend_hours_v`) on a throwaway test
 * database, after `runMigrations` — a derived view is rebuilt by the boot
 * layer, which a test database never runs.
 */
export async function installSpendHoursView(db: NodePgDatabase): Promise<void> {
  await db.execute(
    sql.raw(
      compileCreateView({
        name: "claude_spend_hours_v",
        view: claudeSpendHoursView,
        dependsOn: [],
      }),
    ),
  );
}
