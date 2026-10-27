import { implement } from "@plugins/infra/plugins/endpoints/server";
import { listPrototypes } from "../../core";
import { listPrototypeMetas } from "./list";

/** `GET /api/prototypes` → the prototype list (JSON, via implement()). */
export const handleList = implement(listPrototypes, async () => {
  return listPrototypeMetas();
});
