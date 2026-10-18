import { entityRef } from "@plugins/infra/plugins/entities/core";
import {
  attemptFields,
  attemptDeliveryFields,
  conversationFields,
  pushFields,
  taskDependencyFields,
  taskFields,
} from "./internal/fields";

// The tasks-core entities, by reference — what browser-safe declarations name
// them with (a collection's `exposes`, an extension shape's `exposes.parent`),
// carrying each entity's field record. Each name is its table's and each
// record its columns: `server/internal/tables.ts` builds the table from the ref
// (`defineEntity(ref, meta)`), and a server half handed the table asserts the
// two agree.
export const tasksEntityRef = entityRef("tasks", taskFields);
export const attemptsEntityRef = entityRef("attempts", attemptFields);
export const conversationsEntityRef = entityRef(
  "conversations",
  conversationFields,
);
export const taskDependenciesEntityRef = entityRef(
  "task_dependencies",
  taskDependencyFields,
);
export const pushesEntityRef = entityRef("pushes", pushFields);
export const attemptDeliveriesEntityRef = entityRef(
  "attempt_deliveries",
  attemptDeliveryFields,
);
