import { implement } from "@plugins/infra/plugins/endpoints/server";
import { setSwingEndpoint } from "../../shared/endpoints";
import { songSwing } from "./tables";

export const handleSetSwing = implement(
  setSwingEndpoint,
  async ({ params, body }) => {
    if (body.kind === "score") {
      await songSwing.delete(params.id);
      return;
    }
    // The FK to sonata_songs makes a write for a non-existent song fail loudly.
    const feel = body.kind === "straight" ? body.feel : body.swing;
    await songSwing.upsert(params.id, {
      swung: body.kind === "swing",
      unit: feel.unit,
      ratio: feel.ratio,
    });
  },
);
