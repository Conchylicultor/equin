import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { deployServersEntityRef } from "../../core/entity-ref";

const deployServersEntity = defineEntity(
  deployServersEntityRef,
  {
    // Public half of the keypair whose private half lives in the secrets store.
    // Non-null whenever we hold a usable key — generated here, or derived from a
    // private key the user pasted. Null means we cannot name a key for this
    // server, which is the only honest way to say "no key".
    sshPublicKey: nullable(textField()),
  },
  {
    primaryKey: "id",
    // No `status` column: reachability is probe-written state owned by the
    // `health` sub-plugin's `deploy_servers_ext_health` side-table, not registry
    // data. See `../../shared/schemas.ts`.
    columns: {
      port: { default: 22 },
      sshUser: { default: "root" },
      createdAt: { default: defaultNow() },
      updatedAt: { default: defaultNow() },
    },
    updatedAt: {
      touchedBy: {
        name: true,
        host: true,
        port: true,
        sshUser: true,
        consoleUrl: true,
        sshPublicKey: true,
        id: false,
        createdAt: false,
      },
    },
  },
);

export const _deployServers = deployServersEntity.table;
