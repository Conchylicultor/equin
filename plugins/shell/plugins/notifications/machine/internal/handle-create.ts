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
      category: body.category,
      subjectId: body.subjectId ?? null,
      subjectName: body.subjectName ?? null,
      detail: body.detail ?? null,
      action: body.action ?? null,
      icon: body.icon ?? null,
      metadata: body.metadata ?? null,
      dedupeKey: body.dedupeKey ?? null,
      audience: body.audience,
    });
    return { id };
  },
);
