import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import {
  cancelClaudeSignIn,
  startClaudeSignIn,
  submitClaudeSignInCode,
} from "../../core";
import { cancelSignIn, startSignIn, submitSignInCode } from "./run";

export const handleStart = implementMachine(
  startClaudeSignIn,
  async ({ body }) => ({ id: await startSignIn(body.target) }),
);

export const handleCode = implementMachine(submitClaudeSignInCode, ({ body }) =>
  submitSignInCode(body.id, body.code),
);

export const handleCancel = implementMachine(cancelClaudeSignIn, ({ body }) =>
  cancelSignIn(body.id),
);
