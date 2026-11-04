import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { installDepEndpoint, removeDepEndpoint } from "../../core";
import { declaredDep, removeDep, UnknownDepError } from "../../deps";
import { requestDep } from "../../server";

async function lookup(id: string) {
  try {
    return await declaredDep(id);
  } catch (err) {
    if (err instanceof UnknownDepError) throw new HttpError(404, err.message);
    throw err;
  }
}

export const handleInstallDep = implementMachine(
  installDepEndpoint,
  async ({ body }) => {
    const dep = await lookup(body.id);
    await requestDep(dep);
    return { id: dep.id };
  },
);

export const handleRemoveDep = implementMachine(
  removeDepEndpoint,
  async ({ body }) => {
    const outcome = await removeDep(await lookup(body.id));
    if (outcome.kind === "busy") {
      throw new HttpError(
        409,
        `${body.id} is being installed (or swept) right now; remove it once that finishes.`,
      );
    }
    return outcome;
  },
);
