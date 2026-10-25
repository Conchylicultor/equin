import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/** Any drizzle handle the intake writes through: the app's `db`, or a test DB. */
export type SiteMessagesDb = NodePgDatabase;
export type SiteMessagesTx = Parameters<
  Parameters<SiteMessagesDb["transaction"]>[0]
>[0];
