import { z } from "zod";
import { SshFailureKindSchema } from "@plugins/infra/plugins/ssh/core";
import { PLATFORM_TAGS } from "@plugins/release/core";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  enumTextField,
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { deployServersEntityRef } from "@plugins/apps/plugins/deploy/plugins/servers/core";

/**
 * One reachability verdict per server — the row of the
 * `deploy_servers_ext_health` side-table (built from this shape in
 * `server/internal/tables.ts`), minus `hostKeyLine`: the pinned known_hosts
 * line is `serverOnly`, so it stays server-side — no client surface needs it.
 * The row keys on `serverId` (the `parent_id` PK).
 *
 * `checkedPublicKey` is `deploy_servers.ssh_public_key` **as of the check**, and
 * it is what makes "verified" exact without any cross-plugin write: the setup
 * step is done iff `ok && checkedPublicKey === server.sshKey?.publicKey`.
 * Replace the key and that line changes, the comparison fails, and the verify
 * step drops back to `active` on its own — `health` never has to be told, and
 * `servers` never has to import `health` to invalidate it.
 *
 * The column is the same string `servers` projects into `sshKey.publicKey`, so
 * the two sides are comparable by construction. A pasted key is no longer an
 * exception: `servers` derives its public half at the door, so it too carries a
 * real line here rather than a `null` that compares equal to everything.
 *
 * `platform` is the probe's second byproduct, and unlike `hostKeyLine` it DOES
 * reach the wire: a deployment surface has to show which artifact a server will
 * accept. `(ok, platform)` spells out four distinct states, which is what keeps
 * the null from absorbing a failure:
 *
 * | state | meaning |
 * |---|---|
 * | no row at all | never probed — we have never reached this box |
 * | `ok: false` | the last probe failed; there was no output to read a platform from |
 * | `ok: true`, `platform: null` | reached it, and it did not report a platform we support |
 * | `ok: true`, `platform: tag` | reached it, and it will accept `tag` artifacts |
 *
 * `converge` / `ship` therefore refuse on a null with a message naming which of
 * the three non-shippable states it is, instead of asserting against the null.
 */
export const serverHealthShape = defineExtensionShape({
  key: "serverId",
  fields: {
    ok: boolField(),
    checkedAt: dateField(),
    /**
     * Null when `ok` — the classified reason otherwise. The column is `text`;
     * the field's schema narrows it, so the value is decoded on the server's
     * reads too, not only on the wire.
     */
    failureKind: nullable(
      parsedTextField(SshFailureKindSchema, { default: "unknown" }),
    ),
    failureMessage: nullable(textField()),
    /** `deploy_servers.ssh_public_key` AS OF the check — see above. */
    checkedPublicKey: nullable(textField()),
    /**
     * TOFU-pinned known_hosts line, learned on the first successful check and
     * required to match on every later one. Never leaves the server: it is
     * `serverOnly` below.
     */
    hostKeyLine: nullable(textField()),
    /**
     * The host's own `uname -sm` as of this check, parsed to a `PlatformTag` —
     * which artifact this server will accept. DISCOVERED, never typed by a
     * human: a reinstalled or resized box reports its own truth on the next
     * check, so moving from x86 to ARM is not a code change. It lives here
     * rather than on `deploy_servers` for the same reason `ok` does —
     * probe-written state with its own writer and lifecycle — and it is the
     * twin of `checkedPublicKey`: stamped AS OF this check. See the state table
     * above.
     *
     * Last on purpose: field order is column order, which drizzle-kit diffs
     * positionally, so a new column goes on the end and no existing one shifts.
     */
    platform: nullable(enumTextField(PLATFORM_TAGS)),
  },
  serverOnly: ["hostKeyLine"],
  // The verdict reaches every list of servers as its `status` field (the id a
  // saved view names): reachable, unreachable, or NULL for a server never
  // probed — a missing row reads NULL, so "never checked" is a value the list
  // can group and filter by, not an absence. Each of the three is labelled by
  // its spelling (Online / Offline / Unknown — the filter chips, the group
  // headers).
  exposes: {
    parent: deployServersEntityRef,
    name: "health",
    fields: {
      ok: {
        as: "status",
        label: "Status",
        options: {
          true: { label: "Online", variant: "success" },
          false: { label: "Offline", variant: "destructive" },
          null: { label: "Unknown", hint: "Never checked" },
        },
      },
    },
  },
});
export const ServerHealthRowSchema = serverHealthShape.schema;
export type ServerHealthRow = z.infer<typeof ServerHealthRowSchema>;

/**
 * The probe's answer. A failure is a *variant*, never an absorbable value: the
 * UI keys its remediation copy off `kind`, and `unknown` carries OpenSSH's own
 * `stderr` so an unclassified failure is shown verbatim rather than guessed at.
 *
 * `stderr` is OpenSSH diagnostic text only — the endpoint never returns private
 * key material or the ssh argv.
 */
export const SshCheckResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    kind: SshFailureKindSchema,
    message: z.string(),
    stderr: z.string(),
  }),
]);
export type SshCheckResult = z.infer<typeof SshCheckResultSchema>;
