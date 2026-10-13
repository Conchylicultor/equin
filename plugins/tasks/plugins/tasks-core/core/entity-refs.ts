import { entityRef } from "@plugins/infra/plugins/entities/core";

// The tasks-core entities, by reference — what browser-safe declarations name
// them with (a collection's `exposes`, an extension shape's `exposes.parent`).
// Each name is its table's (`server/internal/tables.ts`); a server half handed
// the table asserts the two agree.
export const tasksEntityRef = entityRef("tasks");
export const attemptsEntityRef = entityRef("attempts");
export const conversationsEntityRef = entityRef("conversations");
