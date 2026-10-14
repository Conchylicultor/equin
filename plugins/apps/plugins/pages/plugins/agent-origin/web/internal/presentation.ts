import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { agentPageShape } from "../../shared/resources";

/**
 * The exposed `origin` field (`agentPageShape.exposes`) in every list whose
 * rows are blocks: an enum chip labelled Private / Scratch, presented by its
 * type. Registered so a list reaching the exposure derives the field
 * (`live:exposures-registered`).
 */
export const originPresentation = FieldPresentation.Register({
  owner: agentPageShape.exposure,
});
