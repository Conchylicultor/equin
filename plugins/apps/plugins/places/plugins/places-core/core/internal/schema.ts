import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { placeFields, placeTagFields } from "./fields";

// Wire schemas, derived from the field records: `entity.table.$inferSelect` is
// identical by construction to `z.infer` of these.

export const PlaceSchema = fieldsToZodObject(placeFields);
export type Place = z.infer<typeof PlaceSchema>;

export const PlaceTagSchema = fieldsToZodObject(placeTagFields);
export type PlaceTag = z.infer<typeof PlaceTagSchema>;
