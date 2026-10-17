import type { FieldsRecord } from "@plugins/fields/core";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { idKindField } from "@plugins/ids/core";
import { deployServerIdKind } from "./id-kind";

// The registry record's public fields, in column order — the `deploy_servers`
// table is built from them (`server/internal/tables.ts`). `ssh_public_key` is
// a server field of that table, never on this ref: the key reaches the wire
// only as the derived `SshKey` (`servers/shared`). This ref is what browser
// code names the entity by — the servers list derives its fields from it and
// `health` exposes its probe verdict on it.
export const serverFields = {
  id: idKindField(deployServerIdKind),
  name: textField({ label: "Name", primary: true }),
  host: textField(),
  port: intField(),
  sshUser: textField(),
  consoleUrl: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

export const deployServersEntityRef = entityRef("deploy_servers", serverFields);
