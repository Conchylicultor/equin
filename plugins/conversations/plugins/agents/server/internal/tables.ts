import { type AnyPgColumn, index } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { agentLaunchesEntityRef, agentsEntityRef } from "../../core/entity";

// Physical tables only, built from the field records in `core/entity.ts`.
// Views, Zod schemas, and types live in `./schema.ts`.

const agentsEntity = defineEntity(agentsEntityRef, {
  primaryKey: "id",
  columns: {
    parentId: {
      references: {
        column: (): AnyPgColumn => agentsEntity.table.id,
        onDelete: "cascade",
      },
    },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  updatedAt: {
    touchedBy: {
      parentId: true,
      name: true,
      prompt: true,
      model: true,
      icon: true,
      iconColor: true,
      rank: true,
      id: false,
      createdAt: false,
    },
  },
  indexes: (t) => [index("agents_parent_rank_idx").on(t.parentId, t.rank)],
});
export const _agents = agentsEntity.table;

const agentLaunchesEntity = defineEntity(agentLaunchesEntityRef, {
  primaryKey: "id",
  columns: {
    agentId: {
      references: { column: () => _agents.id, onDelete: "cascade" },
    },
    createdAt: { default: defaultNow() },
  },
  indexes: (t) => [index("agent_launches_agent_id_idx").on(t.agentId)],
});
export const _agent_launches = agentLaunchesEntity.table;
