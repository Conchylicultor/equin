import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { placeFields } from "./fields";
import { placeTagsEntityRef } from "./entity-refs";

// Wire schemas, derived from the field records: `entity.table.$inferSelect` is
// identical by construction to `z.infer` of these.

export const PlaceSchema = fieldsToZodObject(placeFields);
export type Place = z.infer<typeof PlaceSchema>;

export const PlaceTagSchema = fieldsToZodObject(placeTagsEntityRef.fields);
export type PlaceTag = z.infer<typeof PlaceTagSchema>;
