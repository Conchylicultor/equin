import type { FieldsRecord } from "@plugins/fields/core";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";

// The registry record's public fields, in column order. `ssh_public_key` (the
// table's remaining column) is deliberately absent: the key reaches the wire
// only as the derived `SshKey` (`servers/shared`), never as the raw column.
// The table stays hand-written (`server/internal/tables.ts`, a
// `deriveUpdatedAt` pgTable); this ref is what browser code names the entity by
// — the servers list derives its fields from it and `health` exposes its
// probe verdict on it.
export const serverFields = {
  id: textField(),
  name: textField({ label: "Name", primary: true }),
  host: textField(),
  port: intField(),
  sshUser: textField(),
  consoleUrl: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

export const deployServersEntityRef = entityRef("deploy_servers", serverFields);
