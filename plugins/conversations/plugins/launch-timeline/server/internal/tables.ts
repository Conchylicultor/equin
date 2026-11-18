import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { launchShape } from "../../core";

export const launches = defineExtension(_conversations, "launch", launchShape);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _launchesTable = launches.table;
