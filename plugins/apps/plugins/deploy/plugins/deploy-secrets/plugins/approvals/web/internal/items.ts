import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { DeploySecretRow } from "../../core";

/** A Secrets row as the section lists it: the row, plus the deployment it is a row OF (an action needs both). */
export type SecretItem = DeploySecretRow & { readonly deploymentId: string };

/** Trailing actions of a Secrets row: Set value, Approve. */
export const SecretItemActions = defineItemActions<SecretItem>();
