import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { recheckClaudeCode } from "../../core";
import { recheckClaudeCodeNow } from "../../server/internal/status";

export const handleRecheck = implementMachine(recheckClaudeCode, () =>
  recheckClaudeCodeNow(),
);
