import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import {
  addClaudeAccount,
  removeClaudeAccount,
  selectClaudeAccount,
  setClaudeAccountAutoSwitch,
} from "../../core";
import {
  addClaudeAccountWithToken,
  removeClaudeAccountById,
  selectClaudeAccountById,
  setClaudeAccountsAutoSwitch,
} from "./store";

export const handleAdd = implementMachine(addClaudeAccount, ({ body }) =>
  addClaudeAccountWithToken(body.name, body.token),
);

export const handleRemove = implementMachine(removeClaudeAccount, ({ body }) =>
  removeClaudeAccountById(body.id),
);

export const handleSelect = implementMachine(
  selectClaudeAccount,
  ({ body }) => {
    selectClaudeAccountById(body.id);
  },
);

export const handleAutoSwitch = implementMachine(
  setClaudeAccountAutoSwitch,
  ({ body }) => {
    setClaudeAccountsAutoSwitch(body.enabled);
  },
);
