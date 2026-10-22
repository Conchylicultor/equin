import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { createNotification } from "../../shared/endpoints";
import { writeNotification } from "../../server/internal/record-notification";

export const handleCreate = implementMachine(
  createNotification,
  async ({ body }) => {
    const id = await writeNotification({
      id: body.id,
      type: body.type,
      title: body.title,
      description: body.description,
      variant: body.variant,
      linkTo: body.linkTo ?? null,
      metadata: body.metadata ?? null,
      dedupeKey: body.dedupeKey ?? null,
    });
    return { id };
  },
);
