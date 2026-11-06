import { implement } from "@plugins/infra/plugins/endpoints/server";
import { createCustomPlace, deletePlace, updatePlace } from "../../core";
import {
  createCustomPlace as dropCustomPlace,
  deletePlace as removePlace,
  updatePlace as editPlace,
} from "./places-repo";

export const handleCreateCustomPlace = implement(
  createCustomPlace,
  async ({ body }) => dropCustomPlace(body),
);

export const handleUpdatePlace = implement(
  updatePlace,
  async ({ params, body }) => editPlace(params.id, body),
);

export const handleDeletePlace = implement(deletePlace, async ({ params }) => {
  await removePlace(params.id);
});
