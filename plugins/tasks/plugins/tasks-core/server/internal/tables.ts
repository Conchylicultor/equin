import { type AnyPgColumn, index, uniqueIndex } from "drizzle-orm/pg-core";

import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import {
  taskFields,
  attemptFields,
  taskDependencyFields,
  pushFields,
  attemptDeliveryFields,
  conversationFields,
} from "../../core/internal/fields";

// Physical tables only. This file is a load-order leaf: it must NOT import
// from any other plugin's schema/tables file so that cross-plugin schemas can
// depend on it without forming a cycle. Views, Zod schemas, and types live in
// `./schema.ts` (now a shim over `core/internal/schema.ts`).
//
// These five tables form a single FK cluster and are co-located here to
// eliminate the cycle that existed when _conversations lived in the
// conversations plugin and imported _attempts from the tasks plugin.
//
// Each table is now defined through `defineEntity` (infra/entities), deriving
// the physical pgTable AND the base wire schema from one field record (in
// `core/internal/fields.ts`) so column/schema drift is unrepresentable. FK /
// cascade / set-null edges, DB defaults, and indexes are declared in the entity
// meta below, reproducing the previous raw-drizzle DDL byte-for-byte.

const tasksEntity = defineEntity("tasks", taskFields, {
  primaryKey: "id",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). `clusterId` is a cluster relabel — bookkeeping, not a fact about
  // the task; `rank` counts so a drag reorder bumps the moved task.
  updatedAt: {
    touchedBy: {
      id: false,
      title: true,
      description: true,
      droppedAt: true,
      heldAt: true,
      folderId: true,
      rank: true,
      groupId: false,
      clusterId: false,
      titleAuto: false,
      author: false,
      createdAt: false,
    },
  },
  columns: {
    folderId: {
      references: {
        column: (): AnyPgColumn => tasksEntity.table.id,
        onDelete: "cascade",
      },
    },
    groupId: {
      references: {
        column: (): AnyPgColumn => tasksEntity.table.id,
        onDelete: "set null",
      },
    },
    titleAuto: { default: true },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  indexes: (t) => [
    index("tasks_folder_rank_idx").on(t.folderId, t.rank),
    index("tasks_group_id_idx").on(t.groupId),
    // The union's `WHERE cluster_id = $loser` relabel. No FK on the column: the
    // label is a representative id, not a reference — a cluster's representative
    // can be a dropped task, and an FK would add a cascade we do not want.
    index("tasks_cluster_id_idx").on(t.clusterId),
  ],
});
export const _tasks = tasksEntity.table;

const attemptsEntity = defineEntity("attempts", attemptFields, {
  primaryKey: "id",
  updatedAt: {
    touchedBy: {
      id: false,
      taskId: true,
      worktreePath: true,
      createdAt: false,
      workspace: true,
    },
  },
  columns: {
    taskId: {
      references: { column: () => tasksEntity.table.id, onDelete: "cascade" },
    },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
    // Backfills every attempt that predates the column: they all ran in a
    // worktree.
    workspace: { default: { kind: "worktree" } },
  },
  // tasks_v derives task status via per-task correlated subqueries on
  // attempts.task_id (has_attempt / has_completed / has_active / has_blocking_dep).
  // Without this index those run as full seq scans / nested-loop anti-joins over
  // all-history attempts on every tasks/attempts recompute.
  indexes: (t) => [index("attempts_task_id_idx").on(t.taskId)],
});
export const _attempts = attemptsEntity.table;

const taskDependenciesEntity = defineEntity(
  "task_dependencies",
  taskDependencyFields,
  {
    primaryKey: ["taskId", "dependsOnTaskId"],
    columns: {
      taskId: {
        references: { column: () => tasksEntity.table.id, onDelete: "cascade" },
      },
      dependsOnTaskId: {
        references: { column: () => tasksEntity.table.id, onDelete: "cascade" },
      },
      createdAt: { default: defaultNow() },
    },
    indexes: (t) => [index("task_deps_depends_on_idx").on(t.dependsOnTaskId)],
  },
);
export const _taskDependencies = taskDependenciesEntity.table;

const pushesEntity = defineEntity("pushes", pushFields, {
  primaryKey: "id",
  columns: {
    attemptId: {
      references: {
        column: () => attemptsEntity.table.id,
        onDelete: "cascade",
      },
    },
    // conversationId carries NO FK (soft attribution so the conversations table
    // can own its own lifecycle).
    createdAt: { default: defaultNow() },
  },
  indexes: (t) => [
    uniqueIndex("pushes_sha_unique").on(t.sha),
    index("pushes_push_id_idx").on(t.pushId),
    index("pushes_attempt_id_idx").on(t.attemptId),
  ],
});
// drizzle-kit schema-glob discovery. Name kept (no underscore) so consumers
// don't churn.
export const pushes = pushesEntity.table;

// A non-push delivery (see `attemptDeliveryFields`): keyed by the attempt, so
// recording it twice is an upsert, never a second fact.
const attemptDeliveriesEntity = defineEntity(
  "attempt_deliveries",
  attemptDeliveryFields,
  {
    primaryKey: "attemptId",
    columns: {
      attemptId: {
        references: {
          column: () => attemptsEntity.table.id,
          onDelete: "cascade",
        },
      },
      deliveredAt: { default: defaultNow() },
    },
  },
);
export const _attemptDeliveries = attemptDeliveriesEntity.table;

const conversationsEntity = defineEntity("conversations", conversationFields, {
  primaryKey: "id",
  // Which columns move `updatedAt` (derived by a DB trigger; a write to it
  // raises). New messages are tracked by the status proxy: a turn enters
  // `working` and the reply leaves it; closing (`done`) counts. Resume
  // (waiting <-> starting), a pane dying (-> gone), viewing and hibernation
  // do not.
  updatedAt: {
    touchedBy: {
      id: false,
      attemptId: false,
      title: true,
      model: true,
      status: { into: ["working", "done"], outOf: ["working"] },
      runtime: false,
      kind: false,
      claudeSessionId: false,
      waitingFor: false,
      spawnedBy: false,
      createdAt: false,
      endedAt: false,
      closeRequested: false,
      hibernatedAt: false,
      lastViewedAt: false,
      waitingMenu: false,
    },
  },
  columns: {
    attemptId: {
      references: {
        column: () => attemptsEntity.table.id,
        onDelete: "cascade",
      },
    },
    status: { default: "starting" },
    runtime: { default: "tmux" },
    kind: { default: "user" },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
    closeRequested: { default: false },
  },
  // attempts_v / tasks_v derive status via per-attempt correlated subqueries on
  // conversations.attempt_id, several of them filtered by status (max_ended_at,
  // has_live_conv `status NOT IN ('gone','done')`, has_waiting `status='waiting'`).
  // The composite (attempt_id, status) serves both the bare attempt_id lookups
  // and the status-filtered ones; without it these are full seq scans of the
  // conversations table per attempt on every cascade.
  indexes: (t) => [
    index("conversations_attempt_id_status_idx").on(t.attemptId, t.status),
    // Backs the All-conversations DataView's default keyset (createdAt DESC, id
    // ASC tiebreaker) so the global list pages index-only at scale.
    index("conversations_created_id_idx").on(t.createdAt, t.id),
    // Which conversation a written transcript belongs to: the live session id
    // (the chain's floor) looked up from a transcript-write event's session id
    // (conversations/usage).
    index("conversations_claude_session_id_idx").on(t.claudeSessionId),
  ],
});
export const _conversations = conversationsEntity.table;

// The compiled derived-`updatedAt` specs of this cluster's entities, for the
// suite that installs exactly these into a throwaway DB (the registry is
// process-wide and also holds other suites' stand-in tables). Production
// installs them from the registry at boot.
export const tasksCoreDerivedUpdatedAt = {
  tasks: tasksEntity.derivedUpdatedAt,
  attempts: attemptsEntity.derivedUpdatedAt,
  conversations: conversationsEntity.derivedUpdatedAt,
};
