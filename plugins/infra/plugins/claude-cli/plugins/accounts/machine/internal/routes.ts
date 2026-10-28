import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import {
  addClaudeAccount,
  removeClaudeAccount,
  selectClaudeAccount,
  setClaudeAccountAutoSwitch,
} from "../../core";
import {
  addClaudeAccountWithCredential,
  removeClaudeAccountById,
  selectClaudeAccountById,
  setClaudeAccountsAutoSwitch,
} from "./store";

export const handleAdd = implementMachine(addClaudeAccount, ({ body }) =>
  addClaudeAccountWithCredential(body.name, body.credential),
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
