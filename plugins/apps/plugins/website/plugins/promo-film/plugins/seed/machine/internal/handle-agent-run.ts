import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { finishFilmAgentRun as endpoint } from "../../core";
import { finishFilmAgentRun } from "./seed";

export const handleAgentRun = implementMachine(endpoint, ({ body }) =>
  finishFilmAgentRun(body.prompt, body.now),
);
