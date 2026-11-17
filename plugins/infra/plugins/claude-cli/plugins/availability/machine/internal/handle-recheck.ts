import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { recheckClaudeCode } from "../../core";
import {
  recheckClaudeCodeNow,
  recheckClaudeCodeOnReturn,
} from "../../server/internal/status";

export const handleRecheck = implementMachine(recheckClaudeCode, ({ body }) =>
  body.trigger === "user"
    ? recheckClaudeCodeNow()
    : recheckClaudeCodeOnReturn(),
);
