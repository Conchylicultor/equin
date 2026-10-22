import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

const secretMetaValueSchema = z.object({
  set: z.boolean(),
  updatedAt: z.number().optional(),
});

const configV2SecretMetaSchema = z.record(secretMetaValueSchema);
export type ConfigV2SecretMeta = z.infer<typeof configV2SecretMetaSchema>;

// One descriptor's secret fields (fieldKey → set / updatedAt), keyed by the
// descriptor's storePath. Served from the external arm: the truth is the
// central secrets store, which no change feed sees, so the storage provider
// notifies the path on every save / clear. Record keyed by the descriptor's
// secret fields — bounded by its schema.
export const configSecretMeta = liveValue("config-v2.secret-meta", {
  schema: configV2SecretMetaSchema,
  params: ["path"],
  // The secrets store is the computer's.
  needsMachine: { feature: "Reading saved secrets" },
});
