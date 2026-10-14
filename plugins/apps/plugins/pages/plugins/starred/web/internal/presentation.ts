import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { starredPageShape } from "../../shared/resources";

/**
 * The exposed `starred` field (`starredPageShape.exposes`) in every list whose
 * rows are blocks: a boolean, presented by its type. Registered so a list
 * reaching the exposure derives the field (`live:exposures-registered`).
 */
export const starredPresentation = FieldPresentation.Register({
  owner: starredPageShape.exposure,
});
