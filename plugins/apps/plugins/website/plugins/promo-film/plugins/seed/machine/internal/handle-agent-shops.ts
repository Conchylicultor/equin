import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { writeFilmShops as endpoint } from "../../core";
import { writeFilmShops } from "./seed";

export const handleAgentShops = implementMachine(endpoint, () =>
  writeFilmShops(),
);
